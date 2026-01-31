import Foundation
import Observation

/// Bridges WebSocketService events into AppState.
/// Acts as the WebSocketServiceDelegate, converting server messages
/// into model updates on the shared AppState.
@Observable
@MainActor
public final class AppCoordinator: WebSocketServiceDelegate {
    public let state: AppState
    public let promptService: PromptService
    public private(set) var webSocket: WebSocketService?

    #if os(iOS)
    public let speechService = SpeechService()
    private var autoModeSpeechTask: Task<Void, Never>?
    #endif

    public init(state: AppState) {
        self.state = state
        self.promptService = PromptService()
        promptService.setSendHandler { [weak self] action in
            self?.webSocket?.send(action)
        }

        // Restore all persisted settings
        SettingsStore.load(into: state)

        #if os(iOS)
        // Wire trigger command callback
        speechService.onTriggerCommand = { [weak self] command in
            self?.handleTriggerCommand(command)
        }
        #endif
    }

    // MARK: - Connection Lifecycle

    /// Connect to the server with the given URL and token
    public func connect(url: URL, token: String) {
        disconnect()
        let ws = WebSocketService(serverURL: url, token: token)
        ws.delegate = self
        self.webSocket = ws
        ws.connect()
    }

    /// Reconnect using the stored server URL and Keychain token
    public func reconnect() {
        let keychain = KeychainService()
        guard !state.serverURL.isEmpty,
              let httpURL = URL(string: state.serverURL),
              let host = httpURL.host,
              let token = keychain.load(for: state.serverURL) else {
            return
        }
        let wsScheme = httpURL.scheme == "https" ? "wss" : "ws"
        let port = httpURL.port.map { ":\($0)" } ?? ""
        guard let wsURL = URL(string: "\(wsScheme)://\(host)\(port)/ws") else { return }
        connect(url: wsURL, token: token)
    }

    /// Disconnect from the server
    public func disconnect() {
        webSocket?.disconnect()
        webSocket = nil
    }

    /// Watch a session (sends watch_session to server)
    public func watchSession(_ sessionId: String) {
        #if os(iOS)
        cancelAutoModeSpeech()
        #endif
        webSocket?.setLastWatchedSession(sessionId)
        webSocket?.send(.watchSession(sessionId: sessionId))
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

    /// Send escape (Ctrl+C) to a session
    public func escapeSession(_ sessionId: String) {
        webSocket?.send(.escape(sessionId: sessionId))
    }

    /// Toggle plan/act mode for a session
    public func toggleMode(_ sessionId: String) {
        webSocket?.send(.modeToggle(sessionId: sessionId))
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
        state.showToast("Connected", icon: "wifi", style: .success)
    }

    public func webSocketDidDisconnect(code: Int?) {
        state.isConnected = false
        state.showToast("Disconnected", icon: "wifi.slash", style: .warning)
    }

    public func webSocketDidFailWithError(_ error: Error) {
        // Errors during connection are surfaced via disconnect
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
            } else {
                state.isAuthenticated = false
                state.isConnected = false
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
                guard let msg = messageFromHistoryEntry(entry) else { continue }
                if msg.type == .toolResult {
                    state.mergeOrAppendToolResult(msg)
                } else {
                    state.appendMessage(msg)
                }
            }
            promptService.recoverFromHistory(state.messages, sessionStatus: state.sessionStatus)

        case .claudeOutput(_, let data):
            // Route spinner status_updates to the persistent activity indicator
            if data.type == "status_update" {
                state.currentActivity = data.content
                if let status = data.status {
                    state.sessionStatus = SessionStatus(rawValue: status) ?? .unknown
                }
                promptService.handleClaudeOutput(data)
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
            // Haptic when a new prompt card appears
            if promptService.currentPrompt != nil {
                HapticService.medium()
            }

            if speechService.isAutoMode, let prompt = promptService.currentPrompt {
                autoModeSpeechTask?.cancel()
                speechService.stopSpeaking()
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

        case .sessionStatus(_, let status, _):
            let parsed = SessionStatus(rawValue: status) ?? .unknown
            state.sessionStatus = parsed
            if parsed == .idle || parsed == .waiting { state.currentActivity = nil }
            promptService.handleSessionStatus(parsed)
            #if os(iOS)
            if promptService.currentPrompt == nil { cancelAutoModeSpeech() }
            #endif

        case .statusUpdate(let status):
            let parsed = SessionStatus(rawValue: status) ?? .unknown
            state.sessionStatus = parsed
            if parsed == .idle || parsed == .waiting { state.currentActivity = nil }
            promptService.handleSessionStatus(parsed)
            #if os(iOS)
            if promptService.currentPrompt == nil { cancelAutoModeSpeech() }
            #endif

        case .tokenUsage(let input, let output):
            let msg = Message(
                type: .tokenUsage,
                content: formatTokenCount(input ?? 0, output ?? 0)
            )
            state.appendMessage(msg)

        case .taskCreate(let id, let subject, let description, let activeForm, let status):
            let task = TaskItem(id: id, subject: subject, status: status, description: description, activeForm: activeForm)
            state.tasks.append(task)

        case .taskUpdate(let taskId, let status, let subject):
            if let index = state.tasks.firstIndex(where: { $0.id == taskId }) {
                let old = state.tasks[index]
                state.tasks[index] = TaskItem(
                    id: old.id,
                    subject: subject ?? old.subject,
                    status: status,
                    description: old.description,
                    activeForm: old.activeForm
                )
            }

        case .taskList(let tasks):
            state.tasks = tasks

        case .subagentStarting(let description, let agentType):
            let msg = Message(
                type: .subagentStarting,
                content: description,
                tool: agentType
            )
            state.appendMessage(msg)

        case .subagentStart(let agentId, _, let description, let agentType):
            state.activeSubagents[agentId] = SubagentInfo(
                description: description ?? "",
                agentType: agentType ?? "general"
            )

        case .subagentOutput(let agentId, _, let data):
            guard let data, let msg = messageFromClaudeOutput(data, subagentId: agentId) else { return }
            state.appendMessage(msg)

        case .subagentTool(let agentId, let tool, _):
            state.activeSubagents[agentId]?.currentTool = tool
            state.activeSubagents[agentId]?.lastActivity = Date()

        case .subagentTokens(let agentId, let input, let output):
            if let input { state.activeSubagents[agentId]?.inputTokens += input }
            if let output { state.activeSubagents[agentId]?.outputTokens += output }

        case .subagentStop(let agentId):
            state.activeSubagents[agentId]?.status = "completed"

        case .modeToggleResult(let success, _):
            if success {
                state.sessionMode = state.sessionMode.next
            }

        case .injectResult, .escapeResult:
            break

        case .error(_, let errorMessage, _):
            let msg = Message(type: .statusUpdate, content: "Error: \(errorMessage)")
            state.appendMessage(msg)

        case .pong:
            break // Handled by WebSocketService

        case .state:
            break // State sync handled separately

        case .unknown:
            break
        }
    }

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
        case .tokenUsage(let i, let o): return "token_usage in=\(i ?? 0) out=\(o ?? 0)"
        case .taskCreate(let id, _, _, _, _): return "task_create id=\(id ?? "nil")"
        case .taskUpdate(let id, let status, _): return "task_update id=\(id) status=\(status)"
        case .taskList(let tasks): return "task_list count=\(tasks.count)"
        case .subagentStarting(let desc, _): return "subagent_starting desc=\(desc.prefix(40))"
        case .subagentStart(let id, _, _, _): return "subagent_start id=\(id)"
        case .subagentOutput(let id, _, _): return "subagent_output id=\(id)"
        case .subagentTool(let id, let tool, _): return "subagent_tool id=\(id) tool=\(tool)"
        case .subagentTokens(let id, _, _): return "subagent_tokens id=\(id)"
        case .subagentStop(let id): return "subagent_stop id=\(id)"
        case .injectResult(let success, _): return "inject_result success=\(success)"
        case .escapeResult(let success, _): return "escape_result success=\(success)"
        case .modeToggleResult(let success, _): return "mode_toggle_result success=\(success)"
        case .error(let code, let msg, _): return "error code=\(code) msg=\(msg)"
        case .pong(let ts): return "pong ts=\(ts)"
        case .state: return "state"
        case .unknown(let type, _): return "unknown type=\(type)"
        }
    }

    private func messageFromHistoryEntry(_ entry: HistoryEntry) -> Message? {
        buildMessage(
            type: entry.type,
            content: entry.content,
            tool: entry.tool,
            input: entry.input,
            language: entry.language,
            questions: entry.questions,
            isDestructive: entry.isDestructive ?? false,
            toolUseId: entry.toolUseId,
            isError: entry.isError ?? false
        )
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
                promptService.respond(text: options[index].label)
            }
        }

        speechService.onTranscriptUpdate = nil
        speechService.stopListening()
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
    }

    /// Enable or disable trigger word mode. Persists to UserDefaults,
    /// reconfigures the audio session, and starts/stops trigger listening.
    public func setTriggerEnabled(_ enabled: Bool) {
        state.triggerEnabled = enabled
        SettingsStore.saveTriggerEnabled(enabled)

        if enabled {
            try? speechService.configureAudioSession(forBackground: true)
            try? speechService.startTriggerListening()
        } else {
            speechService.stopTriggerListening()
            try? speechService.configureAudioSession(forBackground: false)
        }
    }
    #endif
}
