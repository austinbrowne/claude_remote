import Foundation
import Observation

/// Connection state machine for server switching
public enum ConnectionState: Sendable {
    case disconnected
    case connecting
    case connected
    case switching
}

/// Bridges WebSocketService events into AppState.
/// Acts as the WebSocketServiceDelegate, converting server messages
/// into model updates on the shared AppState.
@Observable
@MainActor
public final class AppCoordinator: WebSocketServiceDelegate {
    public let state: AppState
    public let promptService: PromptService
    public private(set) var webSocket: WebSocketService?

    // MARK: - Server Switching
    public private(set) var connectionState: ConnectionState = .disconnected
    private var switchContinuation: CheckedContinuation<Bool, Never>?

    #if os(iOS)
    public let speechService = SpeechService()
    public let notificationService: NotificationService
    private var autoModeSpeechTask: Task<Void, Never>?

    // MARK: - Voice Loop State (not persisted — loops don't survive app restarts)
    public private(set) var isVoiceLoopActive = false
    private var voiceLoopRetryCount = 0
    private static let maxVoiceLoopRetries = 5
    private var voiceLoopRetryTask: Task<Void, Never>?
    private var lastVoiceAutoSendTime: Date?
    private static let voiceAutoSendCooldown: TimeInterval = 0.3
    // Stop phrases defined in VoicePromptMatcher.stopPhrases for testability
    #endif

    private var deliveredClearTask: Task<Void, Never>?

    public init(state: AppState) {
        self.state = state
        self.promptService = PromptService()

        #if os(iOS)
        self.notificationService = NotificationService(appState: state)
        #endif

        // All stored properties initialized — safe to capture [weak self]

        // Restore all persisted settings
        SettingsStore.load(into: state)

        promptService.setSendHandler { [weak self] action in
            self?.webSocket?.send(action)
        }

        #if os(iOS)
        notificationService.onNotificationTap = { [weak self] sessionId in
            self?.state.beginSessionSwitch(to: sessionId)
        }

        // Wire trigger command callback
        speechService.onTriggerCommand = { [weak self] command in
            self?.handleTriggerCommand(command)
        }

        // Wire manual auto-send callback (silence timer fired in manual mic mode)
        speechService.onManualAutoSend = { [weak self] text in
            self?.handleVoiceInput(text)
        }

        // Wire trigger cooldown callback — decides whether to resume trigger or voice loop
        speechService.onCooldownComplete = { [weak self] in
            guard let self else { return }
            if self.isVoiceLoopActive {
                // CONS-001 fix: transition from trigger to manual listening for voice loop
                do {
                    try self.speechService.startListening()
                    self.voiceLoopRetryCount = 0
                } catch {
                    self.scheduleVoiceLoopRetry()
                }
            } else {
                // Normal trigger flow — resume trigger listening
                _ = try? self.speechService.startTriggerListening()
            }
        }

        // Wire error callback — surfaces SpeechService errors as toasts
        speechService.onError = { [weak self] message in
            guard let self else { return }
            self.state.showToast(message, icon: "mic.slash", style: .warning)
            // If voice loop is active and recognition errored, retry with backoff
            if self.isVoiceLoopActive && !self.speechService.isListening {
                self.scheduleVoiceLoopRetry()
            }
            // If trigger retries exhausted, reset the toggle
            if self.state.triggerEnabled && self.speechService.triggerState == .idle && !self.speechService.isAudioEngineRunning {
                self.state.triggerEnabled = false
                SettingsStore.saveTriggerEnabled(false)
            }
        }
        speechService.onServerFallback = { [weak self] in
            self?.state.showToast("Using server-based speech (on-device unavailable)", icon: "icloud", style: .info)
        }
        #endif
    }

    // MARK: - Connection Lifecycle

    /// Connect to the server with the given URL and token
    public func connect(url: URL, token: String) {
        disconnect()
        if connectionState != .switching {
            connectionState = .connecting
        }
        let ws = WebSocketService(serverURL: url, token: token)
        ws.delegate = self
        // Preserve session watch across reconnection so the WebSocket's
        // own re-watch logic (in handleServerMessage on auth success)
        // sends a single watch_session after reconnecting.
        if let sessionId = state.currentSessionId {
            ws.setLastWatchedSession(sessionId)
        }
        self.webSocket = ws
        ws.connect()
    }

    /// Reconnect only if the WebSocket connection has dropped (e.g. after iOS backgrounding)
    public func reconnectIfNeeded() {
        guard webSocket != nil, !(webSocket?.isConnected ?? false) else { return }
        reconnect()
    }

    /// Reconnect using the stored server URL and Keychain token
    public func reconnect() {
        let keychain = KeychainService()
        guard !state.serverURL.isEmpty,
              let httpURL = URL(string: state.serverURL),
              let wsURL = WebSocketService.webSocketURL(from: httpURL),
              let token = keychain.load(for: state.serverURL) else {
            return
        }
        connect(url: wsURL, token: token)
    }

    /// Disconnect from the server
    public func disconnect() {
        webSocket?.disconnect()
        webSocket = nil
        if connectionState != .switching {
            connectionState = .disconnected
        }
    }

    /// Watch a session (sends watch_session to server)
    public func watchSession(_ sessionId: String) {
        #if os(iOS)
        cancelAutoModeSpeech()
        #endif
        // Unwatch previous session before watching new one
        if let previous = state.currentSessionId, previous != sessionId {
            webSocket?.send(.unwatchSession(sessionId: previous))
        }
        webSocket?.setLastWatchedSession(sessionId)
        webSocket?.send(.watchSession(sessionId: sessionId))
        promptService.clearQueue()
        promptService.sessionId = sessionId
    }

    /// Unwatch a session
    public func unwatchSession(_ sessionId: String) {
        webSocket?.send(.unwatchSession(sessionId: sessionId))
    }

    /// Request session list refresh
    public func refreshSessions() {
        webSocket?.send(.refreshSessions)
    }

    /// Inject a command into a session
    public func injectCommand(_ command: String, sessionId: String) {
        webSocket?.send(.inject(command: command, sessionId: sessionId))
    }

    /// Manual approve a tool use from its tool card (fallback when prompt card didn't appear).
    /// Injects '1' (allow once) and cleans up any matching prompt from the queue.
    public func manualApproveToolUse(toolUseId: String) {
        guard let sessionId = state.currentSessionId else { return }
        // Clean up matching prompt from queue/minimized to prevent double-response
        promptService.dismissPermission(toolUseId: toolUseId)
        // Inject '1' (allow once) with toolUseId for accurate routing
        webSocket?.send(.inject(command: "1", sessionId: sessionId, toolUseId: toolUseId))
    }

    /// Send escape (Ctrl+C) to a session
    public func escapeSession(_ sessionId: String) {
        webSocket?.send(.escape(sessionId: sessionId))
    }

    /// Refresh the current session by unwatching and re-watching.
    /// Clears all local state and reloads history from the server — manual "unfreeze".
    public func refreshCurrentSession(_ sessionId: String) {
        webSocket?.send(.unwatchSession(sessionId: sessionId))
        state.messages.removeAll()
        state.activeSubagents.removeAll()
        state.tasks.removeAll()
        state.sessionStatus = .unknown
        state.currentActivity = nil
        state.contextPercentage = 0
        promptService.clearQueue()
        // Re-watch to get fresh history and state
        webSocket?.send(.watchSession(sessionId: sessionId))
        webSocket?.setLastWatchedSession(sessionId)
        promptService.sessionId = sessionId
    }

    /// Toggle plan/act mode for a session
    public func toggleMode(_ sessionId: String) {
        webSocket?.send(.modeToggle(sessionId: sessionId))
    }

    /// Trigger a clear & resume cycle for the given session
    public func clearAndResume(_ sessionId: String) {
        // First server step is "saving_state" — set that as initial state
        state.clearAndResumeState = .savingState
        webSocket?.send(.clearAndResume(sessionId: sessionId))
    }

    // MARK: - Server Switching

    /// Switch to a different saved server. Validates before disconnecting.
    /// Returns true if the switch succeeded, false if it failed (with auto-rollback).
    @discardableResult
    public func switchServer(_ server: SavedServer) async -> Bool {
        // Only switch from connected state
        guard connectionState == .connected else { return false }

        // 1. VALIDATE FIRST (still connected to old server)
        guard let canonicalURL = URLHelper.canonicalize(server.url) else {
            state.showToast("Invalid server URL", icon: "xmark.circle", style: .error)
            return false
        }

        guard let httpURL = URL(string: canonicalURL),
              let wsURL = WebSocketService.webSocketURL(from: httpURL) else {
            state.showToast("Invalid server URL", icon: "xmark.circle", style: .error)
            return false
        }

        let keychain = KeychainService()
        guard let token = keychain.load(for: canonicalURL) else {
            // No token — navigate to AuthView with URL pre-filled
            state.serverURL = canonicalURL
            SettingsStore.saveServerURL(canonicalURL)
            state.isAuthenticated = false
            state.userDidDisconnect = false
            return false
        }

        // 2. Enter switching state (disables UI)
        let previousURL = state.serverURL
        connectionState = .switching

        // 3. Disconnect from current
        disconnect()
        state.clearMessages()

        // 4. Connect to new
        state.serverURL = canonicalURL
        SettingsStore.saveServerURL(canonicalURL)
        connect(url: wsURL, token: token)

        // 5. Await result with timeout
        let connected = await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            self.switchContinuation = continuation

            // Timeout after 10 seconds
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(10))
                if self.connectionState == .switching {
                    self.switchContinuation?.resume(returning: false)
                    self.switchContinuation = nil
                }
            }
        }

        if connected {
            connectionState = .connected
            state.showToast("Switched to \(server.name)", icon: "checkmark.circle", style: .success)
            return true
        } else {
            // ROLLBACK — reconnect to previous server
            state.showToast("Could not reach \(server.name)", icon: "wifi.slash", style: .error)
            state.serverURL = previousURL
            SettingsStore.saveServerURL(previousURL)

            if let prevHTTP = URL(string: previousURL),
               let prevWS = WebSocketService.webSocketURL(from: prevHTTP),
               let prevToken = keychain.load(for: previousURL) {
                connectionState = .connecting
                connect(url: prevWS, token: prevToken)
            } else {
                connectionState = .disconnected
            }
            return false
        }
    }

    /// Delete a saved server. If it's the active server, disconnects first.
    /// Returns true if the active server was deleted (caller should show AuthView).
    public func deleteServer(_ server: SavedServer) -> Bool {
        let isActive = (URLHelper.canonicalize(server.url) ?? server.url) == state.serverURL
        if isActive {
            disconnect()
            state.isAuthenticated = false
            state.serverURL = ""
            SettingsStore.saveServerURL("")
            state.clearMessages()
        }
        SettingsStore.removeSavedServer(id: server.id)
        return isActive
    }

    // MARK: - Terminal Management

    /// Create a new tmux terminal window, optionally in a specific repo
    public func newTerminal(repoName: String? = nil, startClaude: Bool = false) {
        webSocket?.send(.newTerminal(repoName: repoName, startClaude: startClaude))
    }

    /// Start Claude in a terminal pane
    public func startClaude(sessionId: String) {
        webSocket?.send(.startClaude(sessionId: sessionId))
    }

    /// Fetch repo list from server via HTTP
    public func fetchRepos() async -> [RepoItem] {
        guard !state.serverURL.isEmpty,
              let url = URL(string: state.serverURL + "/repos") else { return [] }
        let keychain = KeychainService()
        guard let token = keychain.load(for: state.serverURL) else { return [] }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        do {
            let (data, _) = try await URLSession.shared.data(for: request)
            let response = try JSONDecoder().decode(RepoListResponse.self, from: data)
            return response.repos
        } catch {
            return []
        }
    }

    /// Sync current settings to the server
    public func syncSettings() {
        var settings: [String: AnyCodableValue] = [
            "ttsEnabled": .bool(state.ttsEnabled),
            "speakTools": .bool(state.speakTools),
            "speechRate": .double(Double(state.speechRate)),
            "notifyEnabled": .bool(state.notifyEnabled),
            "debugMode": .bool(state.debugMode),
        ]
        if let voice = state.voiceIdentifier {
            settings["voiceIdentifier"] = .string(voice)
        }
        webSocket?.send(.updateSettings(settings: settings))
    }

    // MARK: - WebSocketServiceDelegate

    public func webSocketDidConnect() {
        state.isConnected = true
        if connectionState != .switching {
            state.showToast("Connected", icon: "wifi", style: .success)
        }
    }

    public func webSocketDidDisconnect(code: Int?) {
        state.isConnected = false
        if connectionState != .switching {
            connectionState = .disconnected
            state.showToast("Disconnected", icon: "wifi.slash", style: .warning)
        }
    }

    public func webSocketDidFailWithError(_ error: Error) {
        // Log errors for debugging (decode failures, connection issues)
        print("[AppCoordinator] WebSocket error: \(error.localizedDescription)")
    }

    public func webSocketDidReceiveMessage(_ message: ServerMessage) {
        if state.debugMode {
            let debugContent = debugDescription(for: message)
            let debugMsg = Message(type: .statusUpdate, content: "[DEBUG] \(debugContent)")
            state.appendMessage(debugMsg)
        }
        routeMessage(message)
    }

    // MARK: - Message Routing

    private func routeMessage(_ message: ServerMessage) {
        switch message {
        case .authResult(let success, let error):
            if success {
                state.isAuthenticated = true
                if connectionState == .switching {
                    // Resolve the switch continuation
                    switchContinuation?.resume(returning: true)
                    switchContinuation = nil
                } else {
                    connectionState = .connected
                }
                // If a notification tap triggered a session switch while disconnected,
                // retry it now that we're authenticated
                if let pendingId = state.pendingSessionId, state.sessionSwitchState == .switching {
                    watchSession(pendingId)
                }
            } else {
                state.isAuthenticated = false
                state.isConnected = false
                if connectionState == .switching {
                    switchContinuation?.resume(returning: false)
                    switchContinuation = nil
                } else {
                    connectionState = .disconnected
                }
                state.showToast(error ?? "Authentication failed", icon: "lock.slash", style: .error)
                #if os(iOS)
                HapticService.error()
                #endif
            }

        case .sessions(let data):
            state.sessions = data

        case .commands(let data):
            state.slashCommands = data

        case .watching(let sessionId, let session):
            // Update session list with fresh data from server
            if let index = state.sessions.firstIndex(where: { $0.id == sessionId }) {
                state.sessions[index] = session
            } else {
                state.sessions.append(session)
            }
            state.confirmSessionSwitch(sessionId: sessionId)

        case .history(_, let data):
            state.clearMessages()
            for entry in data {
                // Skip spinner status_updates from history — they're transient noise
                if entry.type == "status_update" { continue }
                // Skip local CLI commands (/compact, /help, etc.)
                if entry.isLocalCommand { continue }
                guard var msg = messageFromClaudeOutput(entry) else { continue }
                if msg.type == .toolResult {
                    state.mergeOrAppendToolResult(msg)
                } else {
                    // Set subagentStatus on history subagent_starting entries
                    if entry.type == "subagent_starting" {
                        msg.subagentStatus = "starting"
                    }
                    state.appendMessage(msg)
                    // Register for correlation so live subagent_start can link to it
                    if entry.type == "subagent_starting" {
                        state.pendingSubagentMessages.append(
                            (description: entry.content ?? "", messageIndex: state.messages.count - 1)
                        )
                    }
                }
            }
            promptService.recoverFromHistory(state.messages, sessionStatus: state.sessionStatus)
            // Auto-complete any unmatched subagent cards after 30s (fast-finishing agents)
            let pendingSnapshot = state.pendingSubagentMessages
            if !pendingSnapshot.isEmpty {
                Task { @MainActor [weak state] in
                    try? await Task.sleep(for: .seconds(30))
                    guard let state else { return }
                    for pending in pendingSnapshot {
                        // Only complete if still pending (not yet correlated by a live subagent_start)
                        if state.pendingSubagentMessages.contains(where: { $0.messageIndex == pending.messageIndex }) {
                            state.updateSubagentMessage(at: pending.messageIndex, status: "completed", tool: nil)
                        }
                    }
                    state.pendingSubagentMessages.removeAll(where: { p in
                        pendingSnapshot.contains(where: { $0.messageIndex == p.messageIndex })
                    })
                }
            }

        case .claudeOutput(let sessionId, let data):
            // Ignore output from a different session (prevents cross-session message leaks).
            // Also accept messages for a session we're actively switching to (pendingSessionId)
            // to avoid dropping output during the brief switch window.
            if sessionId != state.currentSessionId && sessionId != state.pendingSessionId {
                print("[AppCoordinator] Dropped claude_output: sessionId \(sessionId.prefix(8)) != current \(state.currentSessionId?.prefix(8) ?? "nil")")
                break
            }
            // Skip local CLI commands (/compact, /help, etc.)
            if data.isLocalCommand { return }
            // Compaction starting — show full-screen overlay
            if data.type == "compaction_starting" {
                state.isCompacting = true
                return
            }
            // Compaction complete — dismiss overlay and show toast
            if data.type == "compaction_complete" {
                state.isCompacting = false
                state.showToast("Context compacted", icon: "arrow.triangle.2.circlepath", style: .info)
                return
            }
            // Route spinner status_updates to the persistent activity indicator
            if data.type == "status_update" {
                // Use actual tool name when available (e.g., "Reading..." instead of "Conjuring...")
                if let tool = data.tool, !tool.isEmpty {
                    state.currentActivity = "\(tool)..."
                } else {
                    state.currentActivity = data.content
                }
                if let status = data.status {
                    state.sessionStatus = SessionStatus(rawValue: status) ?? .unknown
                }
                promptService.handleClaudeOutput(data)
                return
            }
            // Skip types that are handled as top-level ServerMessage (not chat messages)
            if ["task_create", "task_update", "task_list", "mode_change", "token_usage"].contains(data.type) {
                return
            }
            // Subagent starting via claude_output fallback — handle like .subagentStarting
            // (Server normally sends this as top-level subagent_starting, but history entries
            // and older servers may still embed it in claude_output)
            if data.type == "subagent_starting" {
                let desc = data.content ?? ""
                let msg = Message(
                    type: .subagentStarting,
                    content: desc,
                    tool: data.tool,
                    subagentStatus: "starting"
                )
                state.appendMessage(msg)
                let index = state.messages.count - 1
                state.pendingSubagentMessages.append((description: desc, messageIndex: index))
                return
            }
            // Any non-status message means activity finished for that step
            if data.type == "assistant" || data.type == "tool_result" {
                state.currentActivity = nil
            }
            guard let msg = messageFromClaudeOutput(data) else { return }
            // Deduplicate user messages (server echoes what we sent)
            if msg.type == .user, let content = msg.content {
                if state.shouldDedupeMessage(content) { return }
            }
            // Merge tool_results into their matching tool_use cards
            if msg.type == .toolResult {
                state.mergeOrAppendToolResult(msg)
            } else {
                state.appendMessage(msg)
            }
            promptService.handleClaudeOutput(data)

            #if os(iOS)
            // Notify for permission requests, questions, and plan exit
            if data.type == "permission_request" {
                let tool = data.tool ?? "Tool"
                let cmd = data.content ?? data.input?["command"]?.stringValue ?? ""
                notify(trigger: .permission, sessionId: sessionId, body: "\(tool): \(cmd)")
            } else if data.type == "ask_user_question" {
                let questionText = data.questions?.first?.question ?? "Question from Claude"
                notify(trigger: .question, sessionId: sessionId, body: questionText)
            } else if data.type == "exit_plan_mode" {
                notify(trigger: .planExit, sessionId: sessionId, body: "Plan ready for approval")
            }

            // Haptic when a new prompt card appears
            if promptService.currentPrompt != nil {
                HapticService.medium()
            }

            if speechService.isAutoMode, let prompt = promptService.currentPrompt {
                cancelAutoModeSpeech()
                speechService.onTranscriptUpdate = { [weak self] transcript in
                    self?.handleVoiceResponse(transcript)
                }
                autoModeSpeechTask = Task { @MainActor [weak self] in
                    guard let self else { return }
                    let speech = toolSpeechSummary(for: prompt)
                    await speechService.speakThenListen(speech)
                }
            }
            #endif

        case .sessionStatus(_, let status, _), .statusUpdate(let status):
            let parsed = SessionStatus(rawValue: status) ?? .unknown
            state.sessionStatus = parsed
            if parsed == .idle || parsed == .waiting { state.currentActivity = nil }
            promptService.handleSessionStatus(parsed)
            // #35: session_status often arrives AFTER history. If the queue is still empty
            // and the session is now waiting, attempt history recovery with the correct status.
            if parsed == .waiting && promptService.promptQueue.isEmpty && !state.messages.isEmpty {
                promptService.recoverFromHistory(state.messages, sessionStatus: .waiting)
            }
            #if os(iOS)
            if promptService.currentPrompt == nil { cancelAutoModeSpeech() }

            // Notify on status changes
            switch parsed {
            case .processing:
                notify(trigger: .status, sessionId: nil, body: "Work Started")
            case .idle:
                notify(trigger: .status, sessionId: nil, body: "Work Complete")
            case .waiting:
                notify(trigger: .status, sessionId: nil, body: "Waiting for Input")
            default:
                break
            }
            #endif

        case .tokenUsage:
            break // Legacy — context is now tracked via context_percentage

        case .contextPercentage(let sessionId, let percentage):
            // Ignore from a different session (prevents cross-session contamination)
            if let sessionId, sessionId != state.currentSessionId { break }

            let oldPct = state.contextPercentage
            if let percentage {
                state.contextPercentage = min(Double(percentage) / 100.0, 1.0)
            }
            let newPct = state.contextPercentage

            if oldPct < 0.9 && newPct >= 0.9 {
                state.showToast("Context nearly full — consider /compact", icon: "exclamationmark.triangle.fill", style: .warning)
            }

        case .taskCreate(let id, let subject, let description, let activeForm, let status, let owner):
            let task = TaskItem(id: id, subject: subject, status: status, description: description, activeForm: activeForm, owner: owner)
            state.tasks.append(task)

        case .taskUpdate(let taskId, let status, let subject, let activeForm, let description, let owner):
            if status == "deleted" {
                // Remove deleted tasks from the list
                state.tasks.removeAll { $0.id == taskId }
            } else if let index = state.tasks.firstIndex(where: { $0.id == taskId }) {
                let old = state.tasks[index]
                state.tasks[index] = TaskItem(
                    id: old.id,
                    subject: subject ?? old.subject,
                    status: status,
                    description: description ?? old.description,
                    activeForm: activeForm ?? old.activeForm,
                    owner: owner ?? old.owner
                )
            }

        case .taskList(let tasks):
            state.tasks = tasks

        case .subagentStarting(let description, let agentType):
            let msg = Message(
                type: .subagentStarting,
                content: description,
                tool: agentType,
                subagentStatus: "starting"
            )
            state.appendMessage(msg)
            let index = state.messages.count - 1
            state.pendingSubagentMessages.append((description: description, messageIndex: index))

        case .subagentStart(let agentId, _, let description, let agentType, let teamName, let memberName):
            state.activeSubagents[agentId] = SubagentInfo(
                description: description ?? "",
                agentType: agentType ?? "general",
                teamName: teamName,
                memberName: memberName
            )
            // If this subagent belongs to a team, track the active team name
            if let teamName, !teamName.isEmpty {
                state.activeTeamName = teamName
            }
            // Correlate to pending subagentStarting message (FIFO by description match)
            if let idx = state.pendingSubagentMessages.firstIndex(where: { $0.description == (description ?? "") }) {
                let msgIndex = state.pendingSubagentMessages[idx].messageIndex
                state.pendingSubagentMessages.remove(at: idx)
                state.subagentMessageMap[agentId] = msgIndex
                state.updateSubagentMessage(at: msgIndex, status: "running", tool: nil, agentId: agentId)
            }

        case .subagentOutput(let agentId, _, let data):
            // Subagent permissions are auto-approved server-side via TTY injection.
            // However, if auto-approve fails, the server broadcasts the permission as
            // a fallback. Route permission_request and ask_user_question to the prompt
            // queue so the user can approve manually when auto-approve doesn't work.
            if let data, (data.type == "ask_user_question" || data.type == "permission_request") {
                let desc = state.activeSubagents[agentId]?.description
                promptService.handleClaudeOutput(data, agentDescription: desc)

                #if os(iOS)
                if data.type == "ask_user_question" {
                    let questionText = data.questions?.first?.question ?? "Question from Claude"
                    let prefix = desc.map { "\($0) — " } ?? ""
                    notify(trigger: .question, sessionId: nil, body: "\(prefix)\(questionText)")
                } else if data.type == "permission_request" {
                    let toolName = data.tool ?? "Unknown tool"
                    let prefix = desc.map { "\($0) — " } ?? ""
                    notify(trigger: .permission, sessionId: nil, body: "\(prefix)\(toolName) needs approval")
                }
                #endif
            }
            // Other subagent output (tool, assistant, etc.) suppressed —
            // activity shown in inline card + badge detail sheet

        case .subagentTool(let agentId, let tool, _):
            state.activeSubagents[agentId]?.currentTool = tool
            state.activeSubagents[agentId]?.lastActivity = Date()
            if let msgIndex = state.subagentMessageMap[agentId] {
                state.updateSubagentMessage(at: msgIndex, status: "running", tool: tool)
            }

        case .subagentTokens(let agentId, let input, let output):
            if let input { state.activeSubagents[agentId]?.inputTokens += input }
            if let output { state.activeSubagents[agentId]?.outputTokens += output }

        case .subagentStop(let agentId):
            state.activeSubagents[agentId]?.status = "completed"
            if let msgIndex = state.subagentMessageMap[agentId] {
                state.updateSubagentMessage(at: msgIndex, status: "completed", tool: nil)
                // Explicitly clear stale tool name on completion
                state.messages[msgIndex].subagentCurrentTool = nil
            }

        case .teamCreate(let teamName):
            state.activeTeamName = teamName
            state.teamMessages.removeAll()

        case .teamDelete:
            state.activeTeamName = nil
            state.teamMessages.removeAll()

        case .teamMessage(let sender, let recipient, let content, _):
            let teamMsg = TeamMessage(sender: sender, recipient: recipient, content: content)
            state.teamMessages.append(teamMsg)
            if state.teamMessages.count > AppState.maxTeamMessages {
                state.teamMessages.removeFirst(state.teamMessages.count - AppState.maxTeamMessages)
            }
            // Also render inline in chat so team messages are visible in the conversation
            let chatMsg = Message(
                type: .teamMessage,
                content: content,
                teamSender: sender,
                teamRecipient: recipient
            )
            state.appendMessage(chatMsg)

        case .permissionResolved(let sessionId, let toolUseId):
            // Ignore from a different session
            if let sessionId, sessionId != state.currentSessionId { break }
            promptService.handlePermissionResolved(toolUseId: toolUseId)

        case .modeChange(let sessionId, let mode):
            // Ignore mode changes from a different session
            if let sessionId, sessionId != state.currentSessionId { break }
            if let newMode = SessionMode(rawValue: mode) {
                state.sessionMode = newMode
            }

        case .modeToggleResult(let success, let error):
            if !success {
                state.showToast(error ?? "Mode toggle failed", icon: "exclamationmark.triangle", style: .warning)
            }
            // Actual mode update comes from server's mode_change broadcast

        case .injectResult(let success, let error):
            if success {
                // Only set "Delivered" if still showing "Sending..."
                // (avoids overwriting a spinner verb that arrived faster)
                if state.currentActivity == "Sending..." {
                    state.currentActivity = "Delivered"
                    // Auto-clear after 2s — handles race where session goes idle
                    // before inject_result arrives, leaving "Delivered" stuck
                    deliveredClearTask?.cancel()
                    deliveredClearTask = Task { @MainActor [weak state] in
                        try? await Task.sleep(for: .seconds(2))
                        guard !Task.isCancelled else { return }
                        if state?.currentActivity == "Delivered" {
                            state?.currentActivity = nil
                        }
                    }
                }
            } else {
                state.currentActivity = nil
                state.showToast(error ?? "Failed to send message", icon: "exclamationmark.triangle", style: .error)
            }

        case .escapeResult:
            break

        case .error(_, let errorMessage, _):
            let msg = Message(type: .statusUpdate, content: "Error: \(errorMessage)")
            state.appendMessage(msg)
            #if os(iOS)
            notify(trigger: .error, sessionId: nil, body: errorMessage)
            #endif

        case .sessionReplaced(let oldSessionId, let newSessionId, let session):
            // Only handle if we were watching the old session
            guard oldSessionId == state.currentSessionId else { break }

            // Update session list with the new session
            if let session {
                if let index = state.sessions.firstIndex(where: { $0.id == oldSessionId }) {
                    state.sessions[index] = session
                } else {
                    state.sessions.append(session)
                }
            }
            // Remove old session from list
            state.sessions.removeAll { $0.id == oldSessionId }

            // Switch to the new session — send watch_session to get fresh history
            watchSession(newSessionId)

        case .clearAndResumeProgress(_, let step, let progressMessage):
            switch step {
            case "saving_state":
                state.clearAndResumeState = .savingState
            case "clearing":
                state.clearAndResumeState = .clearing
            case "switching":
                state.clearAndResumeState = .switching
            case "complete":
                state.clearAndResumeState = .idle
                state.showToast("Context cleared & resumed", icon: "arrow.clockwise.circle", style: .success)
                #if os(iOS)
                HapticService.success()
                #endif
            case "failed":
                state.clearAndResumeState = .idle
                state.showToast(progressMessage, icon: "exclamationmark.triangle", style: .error)
                #if os(iOS)
                HapticService.error()
                #endif
            case "already_pending":
                // Already in progress, no state change needed
                break
            default:
                break
            }

        case .claudeState(let sessionId, let claudeState):
            guard sessionId == state.currentSessionId else { break }
            if let status = claudeState.status {
                state.sessionStatus = SessionStatus(rawValue: status) ?? .unknown
            }
            if let mode = claudeState.mode {
                state.sessionMode = SessionMode(rawValue: mode) ?? .defaultMode
            }
            if let pct = claudeState.contextPercentage {
                // Server sends 0-100 integer; state expects 0-1.0 fraction
                state.contextPercentage = min(pct / 100.0, 1.0)
            }
            if let permissions = claudeState.permissions {
                promptService.updateAllowedTools(permissions)
            }
            if let tasks = claudeState.tasks {
                state.tasks = tasks
            }
            // #35: claude_state often arrives AFTER history with the authoritative status.
            // If the queue is empty and state now reports waiting, retry history recovery.
            if state.sessionStatus == .waiting && promptService.promptQueue.isEmpty && !state.messages.isEmpty {
                promptService.recoverFromHistory(state.messages, sessionStatus: .waiting)
            }
            // Sync team data from server state snapshot
            if let team = claudeState.team, let name = team.name {
                state.activeTeamName = name
                // Populate team member names on existing subagents
                if let members = team.members {
                    for (agentId, memberName) in members {
                        state.activeSubagents[agentId]?.memberName = memberName
                        state.activeSubagents[agentId]?.teamName = name
                    }
                }
            } else if claudeState.team == nil {
                // Server explicitly has no team — clear local team state
                state.activeTeamName = nil
                state.teamMessages.removeAll()
            }

        case .milestone(let sessionId, let text, let timestamp, let toolCount):
            // Ignore from a different session
            if let sessionId, sessionId != state.currentSessionId { break }
            let data = MilestoneData(text: text, timestamp: timestamp, toolCount: toolCount)
            state.milestones.append(data.toMilestone())
            // Cap at 20 milestones, drop oldest
            if state.milestones.count > 20 {
                state.milestones.removeFirst(state.milestones.count - 20)
            }

        case .milestones(let sessionId, let milestoneDataList):
            // Ignore from a different session
            if let sessionId, sessionId != state.currentSessionId { break }
            state.milestones = milestoneDataList.map { $0.toMilestone() }

        case .pong:
            break // Handled by WebSocketService

        case .state:
            break // State sync handled separately

        case .unknown:
            break
        }
    }

    // MARK: - Notification Helpers

    #if os(iOS)
    /// Get the session name for notification display
    private func sessionName(for sessionId: String?) -> String {
        guard let sessionId else { return "Claude" }
        return state.sessions.first(where: { $0.id == sessionId })?.name ?? "Claude"
    }

    /// Schedule a local notification for a session event
    private func notify(trigger: NotificationTrigger, sessionId: String?, body: String) {
        guard let sessionId = sessionId ?? state.currentSessionId else { return }
        notificationService.scheduleIfNeeded(
            trigger: trigger,
            sessionName: sessionName(for: sessionId),
            sessionId: sessionId,
            body: body
        )
    }
    #endif

    // MARK: - Message Conversion

    private func buildMessage(
        type: String,
        content: String?,
        tool: String?,
        input: [String: AnyCodableValue]?,
        language: String?,
        subagentId: String? = nil,
        questions: [QuestionData]? = nil,
        isDestructive: Bool = false,
        toolUseId: String? = nil,
        isError: Bool = false
    ) -> Message? {
        let messageType = MessageType(rawValue: type) ?? .unknown
        // Filter empty assistant messages (tool-only responses)
        if messageType == .assistant && (content == nil || content?.isEmpty == true) {
            return nil
        }
        return Message(
            type: messageType,
            content: content,
            tool: tool,
            toolInput: input,
            language: language,
            isSubagent: subagentId != nil,
            subagentId: subagentId,
            questions: questions,
            isDestructive: isDestructive,
            toolUseId: toolUseId,
            resultIsError: isError
        )
    }

    private func messageFromClaudeOutput(_ data: ClaudeOutputData, subagentId: String? = nil) -> Message? {
        buildMessage(
            type: data.type,
            content: data.content,
            tool: data.tool,
            input: data.input,
            language: data.language,
            subagentId: subagentId,
            questions: data.questions,
            isDestructive: data.isDestructive ?? false,
            toolUseId: data.toolUseId,
            isError: data.isError ?? false
        )
    }

    private func debugDescription(for message: ServerMessage) -> String {
        switch message {
        case .authResult(let success, _): return "auth_result success=\(success)"
        case .sessions(let data): return "sessions count=\(data.count)"
        case .commands(let data): return "commands count=\(data.count)"
        case .watching(let sid, _): return "watching session=\(sid)"
        case .history(let sid, let data): return "history session=\(sid) entries=\(data.count)"
        case .claudeOutput(_, let data): return "claude_output type=\(data.type) len=\(data.content?.count ?? 0)"
        case .sessionStatus(_, let status, _): return "session_status status=\(status)"
        case .statusUpdate(let status): return "status_update status=\(status)"
        case .tokenUsage(_, let i, let o): return "token_usage in=\(i ?? 0) out=\(o ?? 0)"
        case .contextPercentage(_, let p): return "context_percentage pct=\(p ?? 0)"
        case .taskCreate(let id, _, _, _, _, _): return "task_create id=\(id ?? "nil")"
        case .taskUpdate(let id, let status, _, _, _, _): return "task_update id=\(id) status=\(status)"
        case .taskList(let tasks): return "task_list count=\(tasks.count)"
        case .subagentStarting(let desc, _): return "subagent_starting desc=\(desc.prefix(40))"
        case .subagentStart(let id, _, _, _, let team, let member): return "subagent_start id=\(id)\(team.map { " team=\($0)" } ?? "")\(member.map { " member=\($0)" } ?? "")"
        case .subagentOutput(let id, _, _): return "subagent_output id=\(id)"
        case .subagentTool(let id, let tool, _): return "subagent_tool id=\(id) tool=\(tool)"
        case .subagentTokens(let id, _, _): return "subagent_tokens id=\(id)"
        case .subagentStop(let id): return "subagent_stop id=\(id)"
        case .teamCreate(let name): return "team_create name=\(name)"
        case .teamDelete: return "team_delete"
        case .teamMessage(let sender, _, _, _): return "team_message from=\(sender)"
        case .injectResult(let success, _): return "inject_result success=\(success)"
        case .escapeResult(let success, _): return "escape_result success=\(success)"
        case .permissionResolved(_, let toolUseId): return "permission_resolved toolUseId=\(toolUseId)"
        case .modeChange(_, let mode): return "mode_change mode=\(mode)"
        case .modeToggleResult(let success, _): return "mode_toggle_result success=\(success)"
        case .error(let code, let msg, _): return "error code=\(code) msg=\(msg)"
        case .pong(let ts): return "pong ts=\(ts)"
        case .sessionReplaced(let old, let new, _): return "session_replaced \(old.prefix(8)) → \(new.prefix(8))"
        case .clearAndResumeProgress(_, let step, _): return "clear_and_resume_progress step=\(step)"
        case .claudeState(let sid, _): return "claude_state session=\(sid ?? "nil")"
        case .milestone(_, let text, _, _): return "session_milestone text=\(text.prefix(40))"
        case .milestones(_, let milestones): return "session_milestones count=\(milestones.count)"
        case .state: return "state"
        case .unknown(let type, _): return "unknown type=\(type)"
        }
    }

    // MARK: - Voice I/O (iOS)

    #if os(iOS)
    /// Cancel any active auto-mode speech and listening.
    /// Called on session switch, prompt dismissal, and status changes.
    private func cancelAutoModeSpeech() {
        autoModeSpeechTask?.cancel()
        autoModeSpeechTask = nil
        speechService.onTranscriptUpdate = nil
        if speechService.isListening { speechService.stopListening() }
        if speechService.isSpeaking { speechService.stopSpeaking() }
        // Exit voice loop on session switch / disconnect
        if isVoiceLoopActive {
            resetVoiceLoopState()
        }
    }

    /// Build a spoken summary for a prompt card
    private func toolSpeechSummary(for prompt: PromptItem) -> String {
        switch prompt.kind {
        case .permission(let tool, let command, _):
            let toolName = tool ?? "a tool"
            let cmdSummary = command.map { String($0.prefix(50)) } ?? ""
            return "Allow \(toolName) to run \(cmdSummary)? Say allow, always, or deny."

        case .question(let questions):
            guard let q = questions.first else { return "" }
            let optionLabels = (q.options ?? []).map(\.label).joined(separator: ", ")
            return "Question: \(q.question). Options are: \(optionLabels)."

        case .planExit:
            return "Plan ready. Say accept, accept and clear, or manual."
        }
    }

    /// Handle a voice transcript update in auto-mode.
    /// Only stops listening and clears the callback on a successful match.
    public func handleVoiceResponse(_ transcript: String) {
        guard speechService.isAutoMode,
              let prompt = promptService.currentPrompt else { return }

        let match = VoicePromptMatcher.match(
            transcript: transcript,
            promptKind: prompt.kind
        )

        switch match {
        case .noMatch:
            return // Keep listening for a better transcript
        case .allow:
            promptService.respondPermission(.allow)
        case .allowAlways:
            promptService.respondPermission(.allowAlways)
        case .deny:
            promptService.respondPermission(.deny)
        case .option(let index):
            if case .question(let questions) = prompt.kind,
               let q = questions.first,
               let options = q.options,
               index < options.count {
                promptService.respondOption(index: index)
            }
        case .planExitOption(let option):
            promptService.respondPlanExit(option)
        }

        speechService.onTranscriptUpdate = nil
        speechService.stopListening()
    }

    // MARK: - Voice Input Handler

    /// Unified voice input handler — processes silence-timer auto-send, stop commands,
    /// prompt suppression, and voice loop continuation.
    private func handleVoiceInput(_ text: String) {
        let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { return }
        guard cleaned.count <= 10_000 else { return } // Match InputBarView's client-side limit
        guard let sessionId = state.currentSessionId else { return }

        // Check if the ENTIRE transcript is a stop command (voice loop only)
        if isVoiceLoopActive && VoicePromptMatcher.isStopCommand(cleaned) {
            exitVoiceLoop()
            return
        }

        // Suppress auto-send when a permission prompt is active — prevent ambient audio
        // from approving permissions via the auto-mode matching pipeline
        if promptService.currentPrompt != nil {
            // Restart listening to clear stale transcript so next utterance starts fresh
            if isVoiceLoopActive && speechService.isListening {
                speechService.stopListening()
                scheduleVoiceLoopRestart()
            }
            return
        }

        // Enforce cooldown to prevent rapid-fire sends (parity with InputBarView)
        if let last = lastVoiceAutoSendTime, Date().timeIntervalSince(last) < Self.voiceAutoSendCooldown {
            return
        }
        lastVoiceAutoSendTime = Date()

        HapticService.heavy()
        state.trackSentMessage(cleaned)
        injectCommand(cleaned, sessionId: sessionId)
        speechService.stopListening()

        // Voice loop: restart listening after sending (with delay for audio engine teardown)
        if isVoiceLoopActive {
            scheduleVoiceLoopRestart()
        }
    }

    /// Exit the voice loop cleanly with feedback, then resume trigger if it was enabled.
    public func exitVoiceLoop() {
        resetVoiceLoopState()
        speechService.stopListening()
        HapticService.medium()
        state.showToast("Voice loop ended", icon: "mic.slash", style: .info)
        // Resume trigger listening — voice loop was started from trigger flow
        if state.triggerEnabled {
            _ = try? speechService.startTriggerListening()
        }
    }

    /// Reset voice loop state without side effects (no stopListening, no toast).
    /// Called from all exit paths to ensure consistent cleanup.
    private func resetVoiceLoopState() {
        isVoiceLoopActive = false
        voiceLoopRetryCount = 0
        voiceLoopRetryTask?.cancel()
        voiceLoopRetryTask = nil
        speechService.preferOnDeviceRecognition = false
    }

    /// Schedule a delayed restart of manual listening for the voice loop.
    /// Brief delay (0.3s) allows audio engine to fully tear down, preventing stale audio buffers
    /// from being re-processed by the new recognition session.
    private func scheduleVoiceLoopRestart() {
        voiceLoopRetryTask?.cancel()
        voiceLoopRetryTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(0.3))
            guard !Task.isCancelled, let self, self.isVoiceLoopActive else { return }
            do {
                try self.speechService.startListening()
                self.voiceLoopRetryCount = 0
            } catch {
                self.scheduleVoiceLoopRetry()
            }
        }
    }

    /// Schedule a retry for voice loop recognition with exponential backoff.
    private func scheduleVoiceLoopRetry() {
        guard voiceLoopRetryCount < Self.maxVoiceLoopRetries else {
            resetVoiceLoopState()
            state.showToast("Voice loop stopped — tap mic to retry", icon: "mic.slash", style: .warning)
            // Resume trigger listening — voice loop failed but trigger may still work
            if state.triggerEnabled {
                _ = try? speechService.startTriggerListening()
            }
            return
        }

        let delay = Double(min(1 << voiceLoopRetryCount, 16)) // 1, 2, 4, 8, 16 seconds
        voiceLoopRetryCount += 1
        #if DEBUG
        print("[VoiceLoop] Retry #\(voiceLoopRetryCount) in \(delay)s")
        #endif

        voiceLoopRetryTask?.cancel()
        voiceLoopRetryTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self, self.isVoiceLoopActive else { return }
            do {
                try self.speechService.startListening()
                self.voiceLoopRetryCount = 0
            } catch {
                #if DEBUG
                print("[VoiceLoop] Retry failed: \(error)")
                #endif
                self.scheduleVoiceLoopRetry()
            }
        }
    }

    // MARK: - Trigger Word

    /// Handle a captured command from trigger word detection.
    private func handleTriggerCommand(_ command: String) {
        guard let sessionId = state.currentSessionId else {
            let msg = Message(type: .statusUpdate, content: "Trigger command ignored (no active session): \(command)")
            state.appendMessage(msg)
            return
        }
        HapticService.heavy()
        state.trackSentMessage(command)
        injectCommand(command, sessionId: sessionId)

        // Start voice loop — continue listening after trigger command
        isVoiceLoopActive = true
        voiceLoopRetryCount = 0
        speechService.preferOnDeviceRecognition = true
    }

    /// Enable or disable trigger word mode. Persists to UserDefaults,
    /// reconfigures the audio session, and starts/stops trigger listening.
    public func setTriggerEnabled(_ enabled: Bool) {
        // Guard against redundant calls (prevents Settings toggle feedback loop)
        guard enabled != state.triggerEnabled else { return }

        state.triggerEnabled = enabled
        SettingsStore.saveTriggerEnabled(enabled)

        if enabled {
            // Trigger mode implicitly enables auto-mode (TTS reads prompts, voice responds)
            speechService.isAutoMode = true
            do {
                speechService.configureAudioSession(forBackground: true)
                let result = try speechService.startTriggerListening()
                switch result {
                case .started:
                    break // Success
                case .authorizationPending:
                    // Auth dialog is showing — don't revert yet.
                    // If denied, the onError callback will handle revert.
                    state.showToast("Requesting speech permission...", icon: "mic", style: .info)
                case .failed(let reason):
                    print("[Trigger] Failed to start: \(reason)")
                    state.triggerEnabled = false
                    SettingsStore.saveTriggerEnabled(false)
                    speechService.isAutoMode = false
                    state.showToast("Trigger word unavailable: \(reason)", icon: "mic.slash", style: .warning)
                }
            } catch {
                // Revert — prevents boot-loop if audio hardware isn't available
                print("[Trigger] Failed to start: \(error)")
                state.triggerEnabled = false
                SettingsStore.saveTriggerEnabled(false)
                speechService.isAutoMode = false
                state.showToast("Trigger word unavailable", icon: "mic.slash", style: .warning)
            }
        } else {
            speechService.stopTriggerListening()
            speechService.isAutoMode = false
            speechService.configureAudioSession(forBackground: false)
            // Exit voice loop if active
            if isVoiceLoopActive {
                resetVoiceLoopState()
            }
        }
    }

    /// Restart trigger listening after returning from background.
    /// iOS may deactivate the audio session while backgrounded; this re-establishes it.
    /// Also detects zombie state where triggerState says .listening but audio engine is dead.
    public func restoreTriggerIfNeeded() {
        // Voice loop doesn't survive backgrounding — exit cleanly
        if isVoiceLoopActive {
            resetVoiceLoopState()
            state.showToast("Voice loop ended — backgrounded", icon: "mic.slash", style: .info)
        }

        guard state.triggerEnabled else { return }

        // Crash-loop protection: if we attempted restore within the last 3 seconds,
        // we likely crashed during it (setActive hanging). Break the loop.
        // 3s is generous — real crash loops restart in <1s. 10s was too aggressive
        // and triggered during normal multitasking (switching apps and back).
        let restoreKey = "triggerRestoreTimestamp"
        let lastAttempt = UserDefaults.standard.double(forKey: restoreKey)
        if lastAttempt > 0 && Date().timeIntervalSince1970 - lastAttempt < 3 {
            print("[Trigger] Recent restore attempt (\(Int(Date().timeIntervalSince1970 - lastAttempt))s ago) — skipping to break crash loop")
            UserDefaults.standard.set(0.0, forKey: restoreKey)
            state.triggerEnabled = false
            SettingsStore.saveTriggerEnabled(false)
            state.showToast("Trigger word disabled after crash — re-enable in Settings", icon: "mic.slash", style: .warning)
            return
        }

        // Check for zombie state: triggerState claims listening but audio engine is dead.
        // This happens when iOS kills the audio session while backgrounded.
        let isZombie = (speechService.triggerState == .listening || speechService.triggerState == .capturing)
            && !speechService.isAudioEngineRunning

        // If trigger is actively listening AND audio engine is running, nothing to do
        if (speechService.triggerState == .listening || speechService.triggerState == .capturing)
            && speechService.isAudioEngineRunning {
            return
        }

        if isZombie {
            print("[Trigger] Zombie state detected — triggerState=\(speechService.triggerState) but audioEngine not running. Force-restarting.")
            // Force stop to reset state before restarting
            speechService.stopTriggerListening()
        }

        // Mark restore attempt start
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: restoreKey)

        // Re-enable: force-reconfigure audio session (iOS may have deactivated it
        // while backgrounded) and start listening
        do {
            speechService.audioSessionConfigured = false
            speechService.configureAudioSession(forBackground: true)
            try speechService.startTriggerListening()
            print("[Trigger] Restored after foreground return")
            // Clear on success
            UserDefaults.standard.set(0.0, forKey: restoreKey)
        } catch {
            print("[Trigger] Failed to restore after foreground: \(error)")
            UserDefaults.standard.set(0.0, forKey: restoreKey)
            state.showToast("Trigger word failed to restore", icon: "mic.slash", style: .warning)
        }
    }
    #endif
}
