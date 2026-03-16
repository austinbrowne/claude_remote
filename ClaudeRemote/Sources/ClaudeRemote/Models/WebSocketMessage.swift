import Foundation

// MARK: - Server → Client Messages

/// All message types the server can send to the client
public enum ServerMessage: Sendable {
    case authResult(success: Bool, error: String?)
    case sessions(data: [Session])
    case commands(data: [SlashCommand])
    case watching(sessionId: String, session: Session)
    case history(sessionId: String, data: [ClaudeOutputData])
    case claudeOutput(sessionId: String, data: ClaudeOutputData)
    case sessionStatus(sessionId: String, status: String, lastActive: String?)
    case statusUpdate(status: String)
    case tokenUsage(sessionId: String?, input: Int?, output: Int?)
    case contextPercentage(sessionId: String?, percentage: Int?)
    case taskCreate(id: String?, subject: String, description: String?, activeForm: String?, status: String?, owner: String?)
    case taskUpdate(taskId: String, status: String, subject: String?, activeForm: String?, description: String?, owner: String?)
    case taskList(tasks: [TaskItem])
    case subagentStarting(description: String, agentType: String?)
    case subagentStart(agentId: String, sessionId: String?, description: String?, agentType: String?, teamName: String?, memberName: String?)
    case subagentOutput(agentId: String, sessionId: String?, data: ClaudeOutputData?)
    case subagentTool(agentId: String, tool: String, input: String?)
    case subagentTokens(agentId: String, input: Int?, output: Int?)
    case subagentStop(agentId: String)
    case teamCreate(teamName: String)
    case teamDelete
    case teamMessage(sender: String, recipient: String?, content: String, messageType: String?)
    case injectResult(success: Bool, error: String?)
    case escapeResult(success: Bool, error: String?)
    case modeToggleResult(success: Bool, error: String?)
    case modeChange(sessionId: String?, mode: String)
    case error(code: String, message: String, details: [String: AnyCodableValue]?)
    case pong(timestamp: Int)
    case claudeState(sessionId: String?, state: ClaudeState)
    case permissionResolved(sessionId: String?, toolUseId: String)
    case sessionReplaced(oldSessionId: String, newSessionId: String, session: Session?)
    case clearAndResumeProgress(sessionId: String?, step: String, message: String)
    case milestone(sessionId: String?, text: String, timestamp: String, toolCount: Int)
    case milestones(sessionId: String?, milestones: [MilestoneData])
    case state(clientId: String?, watchingSessions: [String]?, settings: [String: AnyCodableValue]?)
    case sessionDelta(sessionId: String, events: [[String: AnyCodableValue]], lastSeq: Int?)
    case pendingPrompts(sessionId: String, prompts: [PendingPrompt], lastSeq: Int?)
    case sessionSuspect(sessionId: String)
    case sessionAlive(sessionId: String)
    case unknown(type: String, raw: [String: AnyCodableValue])
}

/// Data inside a claude_output message
public struct ClaudeOutputData: Decodable, Sendable, Equatable {
    public let type: String
    public let content: String?
    public let tool: String?
    public let input: [String: AnyCodableValue]?
    public let language: String?
    public let status: String?
    public let questions: [QuestionData]?
    public let isDestructive: Bool?
    public let toolUseId: String?
    public let isError: Bool?

    /// Whether this entry is a local CLI command (/compact, /help, etc.)
    /// that should not be displayed in the message list.
    public var isLocalCommand: Bool {
        guard type == "user", let content else { return false }
        return content.contains("<command-name>") || content.contains("<command-message>") || content.contains("<local-command-stdout>")
    }

    public init(
        type: String,
        content: String? = nil,
        tool: String? = nil,
        input: [String: AnyCodableValue]? = nil,
        language: String? = nil,
        status: String? = nil,
        questions: [QuestionData]? = nil,
        isDestructive: Bool? = nil,
        toolUseId: String? = nil,
        isError: Bool? = nil
    ) {
        self.type = type
        self.content = content
        self.tool = tool
        self.input = input
        self.language = language
        self.status = status
        self.questions = questions
        self.isDestructive = isDestructive
        self.toolUseId = toolUseId
        self.isError = isError
    }
}

/// A question in ask_user_question
public struct QuestionData: Codable, Sendable, Equatable {
    public let question: String
    public let header: String?
    public let options: [QuestionOption]?
    public let multiSelect: Bool?

    public init(question: String, header: String? = nil, options: [QuestionOption]? = nil, multiSelect: Bool? = nil) {
        self.question = question
        self.header = header
        self.options = options
        self.multiSelect = multiSelect
    }
}

/// An option in a question
public struct QuestionOption: Codable, Sendable, Equatable {
    public let label: String
    public let description: String?
    public let value: String?

    public init(label: String, description: String? = nil, value: String? = nil) {
        self.label = label
        self.description = description
        self.value = value
    }
}

/// A task item from task_create/task_update/task_list
public struct TaskItem: Codable, Sendable, Equatable {
    public let id: String?
    public let subject: String?
    public let status: String?
    public let description: String?
    public let activeForm: String?
    /// Agent name that owns/claimed this task (e.g. "implementer-1")
    public let owner: String?

    public init(id: String? = nil, subject: String? = nil, status: String? = nil, description: String? = nil, activeForm: String? = nil, owner: String? = nil) {
        self.id = id
        self.subject = subject
        self.status = status
        self.description = description
        self.activeForm = activeForm
        self.owner = owner
    }
}

/// Wrapper for resilient array decoding — skips entries that fail to decode
/// instead of failing the entire array.
private struct LossyDecodableArray<Element: Decodable>: Decodable {
    let elements: [Element]

    init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        var decoded: [Element] = []
        while !container.isAtEnd {
            if let element = try? container.decode(Element.self) {
                decoded.append(element)
            } else {
                // Skip the bad element by decoding as throwaway AnyCodableValue
                _ = try? container.decode(AnyCodableValue.self)
            }
        }
        elements = decoded
    }
}

/// A slash command available in the session
public struct SlashCommand: Decodable, Sendable, Identifiable {
    public let name: String
    public let description: String

    public var id: String { name }

    public init(name: String, description: String) {
        self.name = name
        self.description = description
    }
}

/// A pending prompt from server's authoritative state (for recovery on reconnect)
public struct PendingPrompt: Decodable, Sendable {
    public let promptId: String?
    public let type: String
    public let tool: String?
    public let toolUseId: String?
    public let data: ClaudeOutputData?
    public let seq: Int?
    public let timestamp: Int?
}

// MARK: - Client → Server Actions

/// All actions the client can send to the server
public enum ClientAction: Sendable {
    case auth(token: String)
    case watchSession(sessionId: String, fromSeq: Int? = nil)
    case unwatchSession(sessionId: String)
    case refreshSessions
    case inject(command: String, sessionId: String, toolUseId: String? = nil)
    case selectOption(index: Int, sessionId: String)
    case selectOther(index: Int, text: String, sessionId: String)
    case escape(sessionId: String)
    case modeToggle(sessionId: String)
    case updateSettings(settings: [String: AnyCodableValue])
    case clearAndResume(sessionId: String)
    case ping

    /// Encode to JSON dictionary for sending over WebSocket
    public func toJSON() -> [String: Any] {
        switch self {
        case .auth(let token):
            return ["action": "auth", "token": token]
        case .watchSession(let sessionId, let fromSeq):
            var dict: [String: Any] = ["action": "watch_session", "sessionId": sessionId]
            if let fromSeq, fromSeq > 0 { dict["fromSeq"] = fromSeq }
            return dict
        case .unwatchSession(let sessionId):
            return ["action": "unwatch_session", "sessionId": sessionId]
        case .refreshSessions:
            return ["action": "refresh_sessions"]
        case .inject(let command, let sessionId, let toolUseId):
            var dict: [String: Any] = ["action": "inject", "command": command, "sessionId": sessionId]
            if let toolUseId { dict["toolUseId"] = toolUseId }
            return dict
        case .selectOption(let index, let sessionId):
            return ["action": "select_option", "index": index, "sessionId": sessionId]
        case .selectOther(let index, let text, let sessionId):
            return ["action": "select_other", "index": index, "text": text, "sessionId": sessionId]
        case .escape(let sessionId):
            return ["action": "escape", "sessionId": sessionId]
        case .modeToggle(let sessionId):
            return ["action": "mode_toggle", "sessionId": sessionId]
        case .updateSettings(let settings):
            var dict: [String: Any] = ["action": "update_settings"]
            var settingsDict: [String: Any] = [:]
            for (key, value) in settings {
                settingsDict[key] = value.toAny()
                }
            dict["settings"] = settingsDict
            return dict
        case .clearAndResume(let sessionId):
            return ["action": "clear_and_resume", "sessionId": sessionId]
        case .ping:
            return ["action": "ping"]
        }
    }

    /// Serialize to JSON Data
    public func toData() throws -> Data {
        try JSONSerialization.data(withJSONObject: toJSON())
    }
}

// MARK: - Decoding

extension ServerMessage: Decodable {
    enum CodingKeys: String, CodingKey {
        case type
        // auth_result
        case success, error
        // sessions, history
        case data
        // watching, session_status, claude_output, subagent_*
        case sessionId, session, status, lastActive
        // token_usage, mode_change, context_percentage
        case input, output, usage, mode, percentage
        // task_*
        case id, taskId, subject, description, activeForm, tasks, owner
        // subagent
        case agentId, agentType, tool, teamName, memberName
        // team_message
        case sender, recipient, messageType
        // error
        case code, message, details
        // pong
        case timestamp
        // state / claude_state
        case clientId, watchingSessions, settings, state
        // clear_and_resume / session_replaced
        case oldSessionId, newSessionId, step
        // permission_resolved
        case toolUseId
        // milestones
        case milestones, toolCount, text
        // question
        case questions
        // permission
        case command, isDestructive
        // session_delta / pending_prompts
        case events, lastSeq, prompts
        // misc
        case language, content
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)

        switch type {
        case "auth_result":
            let success = try container.decode(Bool.self, forKey: .success)
            let error = try container.decodeIfPresent(String.self, forKey: .error)
            self = .authResult(success: success, error: error)

        case "sessions":
            let data = try container.decode([Session].self, forKey: .data)
            self = .sessions(data: data)

        case "commands":
            let data = try container.decode([SlashCommand].self, forKey: .data)
            self = .commands(data: data)

        case "watching":
            let sessionId = try container.decode(String.self, forKey: .sessionId)
            let session = try container.decode(Session.self, forKey: .session)
            self = .watching(sessionId: sessionId, session: session)

        case "history":
            let sessionId = try container.decode(String.self, forKey: .sessionId)
            // Use lossy decoding: skip individual entries that fail instead of
            // dropping the entire history array.
            let lossy = try container.decode(LossyDecodableArray<ClaudeOutputData>.self, forKey: .data)
            self = .history(sessionId: sessionId, data: lossy.elements)

        case "claude_output":
            let sessionId = try container.decode(String.self, forKey: .sessionId)
            let data = try container.decode(ClaudeOutputData.self, forKey: .data)
            self = .claudeOutput(sessionId: sessionId, data: data)

        case "session_status":
            let sessionId = try container.decode(String.self, forKey: .sessionId)
            let status = try container.decode(String.self, forKey: .status)
            let lastActive = try container.decodeIfPresent(String.self, forKey: .lastActive)
            self = .sessionStatus(sessionId: sessionId, status: status, lastActive: lastActive)

        case "status_update":
            // Server sends status in 'content' field (from parseLogEntry) or 'status' field
            let status = try (try? container.decode(String.self, forKey: .content))
                ?? container.decode(String.self, forKey: .status)
            self = .statusUpdate(status: status)

        case "token_usage":
            let sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId)
            let input = try container.decodeIfPresent(Int.self, forKey: .input)
            let output = try container.decodeIfPresent(Int.self, forKey: .output)
            self = .tokenUsage(sessionId: sessionId, input: input, output: output)

        case "context_percentage":
            let sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId)
            let percentage = try container.decodeIfPresent(Int.self, forKey: .percentage)
            self = .contextPercentage(sessionId: sessionId, percentage: percentage)

        case "task_create":
            let id = try container.decodeIfPresent(String.self, forKey: .id)
            let subject = try container.decode(String.self, forKey: .subject)
            let description = try container.decodeIfPresent(String.self, forKey: .description)
            let activeForm = try container.decodeIfPresent(String.self, forKey: .activeForm)
            let status = try container.decodeIfPresent(String.self, forKey: .status)
            let owner = try container.decodeIfPresent(String.self, forKey: .owner)
            self = .taskCreate(id: id, subject: subject, description: description, activeForm: activeForm, status: status, owner: owner)

        case "task_update":
            let taskId = try container.decode(String.self, forKey: .taskId)
            let status = try container.decode(String.self, forKey: .status)
            let subject = try container.decodeIfPresent(String.self, forKey: .subject)
            let activeForm = try container.decodeIfPresent(String.self, forKey: .activeForm)
            let description = try container.decodeIfPresent(String.self, forKey: .description)
            let owner = try container.decodeIfPresent(String.self, forKey: .owner)
            self = .taskUpdate(taskId: taskId, status: status, subject: subject, activeForm: activeForm, description: description, owner: owner)

        case "task_list":
            let tasks = try container.decode([TaskItem].self, forKey: .tasks)
            self = .taskList(tasks: tasks)

        case "subagent_starting":
            let description = try container.decode(String.self, forKey: .description)
            let agentType = try container.decodeIfPresent(String.self, forKey: .agentType)
            self = .subagentStarting(description: description, agentType: agentType)

        case "subagent_start":
            let agentId = try container.decode(String.self, forKey: .agentId)
            let sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId)
            let description = try container.decodeIfPresent(String.self, forKey: .description)
            let agentType = try container.decodeIfPresent(String.self, forKey: .agentType)
            let teamName = try container.decodeIfPresent(String.self, forKey: .teamName)
            let memberName = try container.decodeIfPresent(String.self, forKey: .memberName)
            self = .subagentStart(agentId: agentId, sessionId: sessionId, description: description, agentType: agentType, teamName: teamName, memberName: memberName)

        case "subagent_output":
            let agentId = try container.decode(String.self, forKey: .agentId)
            let sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId)
            let data = try container.decodeIfPresent(ClaudeOutputData.self, forKey: .data)
            self = .subagentOutput(agentId: agentId, sessionId: sessionId, data: data)

        case "subagent_tool":
            let agentId = try container.decode(String.self, forKey: .agentId)
            let tool = try container.decode(String.self, forKey: .tool)
            let input = try container.decodeIfPresent(String.self, forKey: .input)
            self = .subagentTool(agentId: agentId, tool: tool, input: input)

        case "subagent_tokens":
            let agentId = try container.decode(String.self, forKey: .agentId)
            let input = try container.decodeIfPresent(Int.self, forKey: .input)
            let output = try container.decodeIfPresent(Int.self, forKey: .output)
            self = .subagentTokens(agentId: agentId, input: input, output: output)

        case "subagent_stop":
            let agentId = try container.decode(String.self, forKey: .agentId)
            self = .subagentStop(agentId: agentId)

        case "team_create":
            let teamName = try container.decode(String.self, forKey: .teamName)
            self = .teamCreate(teamName: teamName)

        case "team_delete":
            self = .teamDelete

        case "team_message":
            let sender = try container.decode(String.self, forKey: .sender)
            let recipient = try container.decodeIfPresent(String.self, forKey: .recipient)
            let content = try container.decode(String.self, forKey: .content)
            let messageType = try container.decodeIfPresent(String.self, forKey: .messageType)
            self = .teamMessage(sender: sender, recipient: recipient, content: content, messageType: messageType)

        case "inject_result":
            let success = try container.decode(Bool.self, forKey: .success)
            let error = try container.decodeIfPresent(String.self, forKey: .error)
            self = .injectResult(success: success, error: error)

        case "escape_result":
            let success = try container.decode(Bool.self, forKey: .success)
            let error = try container.decodeIfPresent(String.self, forKey: .error)
            self = .escapeResult(success: success, error: error)

        case "mode_toggle_result":
            let success = try container.decode(Bool.self, forKey: .success)
            let error = try container.decodeIfPresent(String.self, forKey: .error)
            self = .modeToggleResult(success: success, error: error)

        case "mode_change":
            let sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId)
            let mode = try container.decode(String.self, forKey: .mode)
            self = .modeChange(sessionId: sessionId, mode: mode)

        case "error":
            let code = try container.decode(String.self, forKey: .code)
            let message = try container.decode(String.self, forKey: .message)
            let details = try container.decodeIfPresent([String: AnyCodableValue].self, forKey: .details)
            self = .error(code: code, message: message, details: details)

        case "pong":
            let timestamp = try container.decode(Int.self, forKey: .timestamp)
            self = .pong(timestamp: timestamp)

        case "claude_state":
            let sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId)
            let claudeState = try container.decode(ClaudeState.self, forKey: .state)
            self = .claudeState(sessionId: sessionId, state: claudeState)

        case "permission_resolved":
            let sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId)
            let toolUseId = try container.decode(String.self, forKey: .toolUseId)
            self = .permissionResolved(sessionId: sessionId, toolUseId: toolUseId)

        case "session_replaced":
            let oldSessionId = try container.decode(String.self, forKey: .oldSessionId)
            let newSessionId = try container.decode(String.self, forKey: .newSessionId)
            let session = try container.decodeIfPresent(Session.self, forKey: .session)
            self = .sessionReplaced(oldSessionId: oldSessionId, newSessionId: newSessionId, session: session)

        case "clear_and_resume_progress":
            let sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId)
            let step = try container.decode(String.self, forKey: .step)
            let message = try container.decode(String.self, forKey: .message)
            self = .clearAndResumeProgress(sessionId: sessionId, step: step, message: message)

        case "session_milestone":
            let sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId)
            let text = try container.decode(String.self, forKey: .text)
            let timestamp = try container.decode(String.self, forKey: .timestamp)
            let toolCount = try container.decode(Int.self, forKey: .toolCount)
            self = .milestone(sessionId: sessionId, text: text, timestamp: timestamp, toolCount: toolCount)

        case "session_milestones":
            let sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId)
            let milestones = try container.decode([MilestoneData].self, forKey: .milestones)
            self = .milestones(sessionId: sessionId, milestones: milestones)

        case "state":
            let clientId = try container.decodeIfPresent(String.self, forKey: .clientId)
            let watchingSessions = try container.decodeIfPresent([String].self, forKey: .watchingSessions)
            let settings = try container.decodeIfPresent([String: AnyCodableValue].self, forKey: .settings)
            self = .state(clientId: clientId, watchingSessions: watchingSessions, settings: settings)

        case "session_delta":
            let sessionId = try container.decode(String.self, forKey: .sessionId)
            // decodeIfPresent: returns nil on missing key, throws on type mismatch
            let events = (try container.decodeIfPresent([[String: AnyCodableValue]].self, forKey: .events)) ?? []
            let lastSeq = try container.decodeIfPresent(Int.self, forKey: .lastSeq)
            self = .sessionDelta(sessionId: sessionId, events: events, lastSeq: lastSeq)

        case "pending_prompts":
            let sessionId = try container.decode(String.self, forKey: .sessionId)
            // Use LossyDecodableArray for per-element resilience; decodeIfPresent handles
            // missing key gracefully (returns nil → empty array) without swallowing structural errors
            let prompts = (try container.decodeIfPresent(LossyDecodableArray<PendingPrompt>.self, forKey: .prompts))?.elements ?? []
            let lastSeq = try container.decodeIfPresent(Int.self, forKey: .lastSeq)
            self = .pendingPrompts(sessionId: sessionId, prompts: prompts, lastSeq: lastSeq)

        case "session_suspect":
            let sessionId = try container.decode(String.self, forKey: .sessionId)
            self = .sessionSuspect(sessionId: sessionId)

        case "session_alive":
            let sessionId = try container.decode(String.self, forKey: .sessionId)
            self = .sessionAlive(sessionId: sessionId)

        default:
            // Forward-compat: unknown types don't crash
            let raw = (try? container.decode([String: AnyCodableValue].self, forKey: .data)) ?? [:]
            self = .unknown(type: type, raw: raw)
        }
    }
}

// MARK: - AnyCodableValue Helpers

extension AnyCodableValue {
    func toAny() -> Any {
        switch self {
        case .string(let s): return s
        case .int(let i): return i
        case .double(let d): return d
        case .bool(let b): return b
        case .null: return NSNull()
        case .array(let arr): return arr.map { $0.toAny() }
        case .dictionary(let dict): return dict.mapValues { $0.toAny() }
        }
    }
}
