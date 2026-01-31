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

    /// Disconnect from the server
    public func disconnect() {
        webSocket?.disconnect()
        webSocket = nil
    }

    /// Watch a session (sends watch_session to server)
    public func watchSession(_ sessionId: String) {
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

    // MARK: - WebSocketServiceDelegate

    public func webSocketDidConnect() {
        state.isConnected = true
    }

    public func webSocketDidDisconnect(code: Int?) {
        state.isConnected = false
    }

    public func webSocketDidFailWithError(_ error: Error) {
        // Errors during connection are surfaced via disconnect
    }

    public func webSocketDidReceiveMessage(_ message: ServerMessage) {
        routeMessage(message)
    }

    // MARK: - Message Routing

    private func routeMessage(_ message: ServerMessage) {
        switch message {
        case .authResult(let success, _):
            if !success {
                state.isAuthenticated = false
                state.isConnected = false
            }

        case .sessions(let data):
            state.sessions = data

        case .watching(let sessionId, _):
            state.confirmSessionSwitch(sessionId: sessionId)

        case .history(_, let data):
            state.clearMessages()
            for entry in data {
                guard let msg = messageFromHistoryEntry(entry) else { continue }
                state.appendMessage(msg)
            }
            promptService.recoverFromHistory(state.messages, sessionStatus: state.sessionStatus)

        case .claudeOutput(_, let data):
            guard let msg = messageFromClaudeOutput(data) else { return }
            // Deduplicate user messages (server echoes what we sent)
            if msg.type == .user, let content = msg.content {
                if state.shouldDedupeMessage(content) { return }
            }
            state.appendMessage(msg)
            // Update session status from status_update messages
            if data.type == "status_update", let status = data.status {
                state.sessionStatus = SessionStatus(rawValue: status) ?? .unknown
            }
            promptService.handleClaudeOutput(data)

            #if os(iOS)
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
            state.sessionStatus = SessionStatus(rawValue: status) ?? .unknown
            promptService.handleSessionStatus(SessionStatus(rawValue: status) ?? .unknown)

        case .statusUpdate(let status):
            state.sessionStatus = SessionStatus(rawValue: status) ?? .unknown
            promptService.handleSessionStatus(SessionStatus(rawValue: status) ?? .unknown)

        case .tokenUsage(let input, let output):
            let msg = Message(
                type: .tokenUsage,
                content: formatTokenUsage(input: input, output: output)
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

        case .injectResult, .escapeResult, .modeToggleResult:
            break // Handled by Phase 3

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
        isDestructive: Bool = false
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
            isDestructive: isDestructive
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
            isDestructive: data.isDestructive ?? false
        )
    }

    private func messageFromHistoryEntry(_ entry: HistoryEntry) -> Message? {
        buildMessage(
            type: entry.type,
            content: entry.content,
            tool: entry.tool,
            input: entry.input,
            language: entry.language,
            questions: entry.questions
        )
    }

    private func formatTokenUsage(input: Int?, output: Int?) -> String {
        let fmt = { (n: Int?) -> String in
            guard let n else { return "0" }
            if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
            if n >= 1_000 { return String(format: "%.1fk", Double(n) / 1_000) }
            return "\(n)"
        }
        return "\(fmt(input)) in / \(fmt(output)) out"
    }

    // MARK: - Voice I/O (iOS)

    #if os(iOS)
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
    #endif
}
