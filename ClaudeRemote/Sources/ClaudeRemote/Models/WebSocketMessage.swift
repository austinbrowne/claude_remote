import Foundation

// MARK: - Server → Client Messages

/// All message types the server can send to the client
public enum ServerMessage: Sendable {
    case authResult(success: Bool, error: String?)
    case sessions(data: [Session])
    case watching(sessionId: String, session: Session)
    case history(sessionId: String, data: [HistoryEntry])
    case claudeOutput(sessionId: String, data: ClaudeOutputData)
    case sessionStatus(sessionId: String, status: String, lastActive: String?)
    case statusUpdate(status: String)
    case tokenUsage(input: Int?, output: Int?)
    case taskCreate(id: String?, subject: String, description: String?, activeForm: String?, status: String?)
    case taskUpdate(taskId: String, status: String, subject: String?)
    case taskList(tasks: [TaskItem])
    case subagentStarting(description: String, agentType: String?)
    case subagentStart(agentId: String, sessionId: String?, description: String?, agentType: String?)
    case subagentOutput(agentId: String, sessionId: String?, data: ClaudeOutputData?)
    case subagentTool(agentId: String, tool: String, input: String?)
    case subagentTokens(agentId: String, input: Int?, output: Int?)
    case subagentStop(agentId: String)
    case injectResult(success: Bool, error: String?)
    case escapeResult(success: Bool, error: String?)
    case modeToggleResult(success: Bool, error: String?)
    case error(code: String, message: String, details: [String: AnyCodableValue]?)
    case pong(timestamp: Int)
    case state(clientId: String?, watchingSessions: [String]?, settings: [String: AnyCodableValue]?)
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
    public let usage: TokenUsageData?

    public init(
        type: String,
        content: String? = nil,
        tool: String? = nil,
        input: [String: AnyCodableValue]? = nil,
        language: String? = nil,
        status: String? = nil,
        questions: [QuestionData]? = nil,
        isDestructive: Bool? = nil,
        usage: TokenUsageData? = nil
    ) {
        self.type = type
        self.content = content
        self.tool = tool
        self.input = input
        self.language = language
        self.status = status
        self.questions = questions
        self.isDestructive = isDestructive
        self.usage = usage
    }
}

/// Token usage data
public struct TokenUsageData: Codable, Sendable, Equatable {
    public let input: Int?
    public let output: Int?

    public init(input: Int? = nil, output: Int? = nil) {
        self.input = input
        self.output = output
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

    public init(id: String? = nil, subject: String? = nil, status: String? = nil, description: String? = nil, activeForm: String? = nil) {
        self.id = id
        self.subject = subject
        self.status = status
        self.description = description
        self.activeForm = activeForm
    }
}

/// A history entry (parsed message from server history)
public struct HistoryEntry: Decodable, Sendable, Equatable {
    public let type: String
    public let content: String?
    public let tool: String?
    public let input: [String: AnyCodableValue]?
    public let language: String?
    public let status: String?
    public let questions: [QuestionData]?

    public init(
        type: String,
        content: String? = nil,
        tool: String? = nil,
        input: [String: AnyCodableValue]? = nil,
        language: String? = nil,
        status: String? = nil,
        questions: [QuestionData]? = nil
    ) {
        self.type = type
        self.content = content
        self.tool = tool
        self.input = input
        self.language = language
        self.status = status
        self.questions = questions
    }
}

// MARK: - Client → Server Actions

/// All actions the client can send to the server
public enum ClientAction: Sendable {
    case auth(token: String)
    case watchSession(sessionId: String)
    case unwatchSession(sessionId: String)
    case refreshSessions
    case catchUp(sessionId: String)
    case inject(command: String, sessionId: String)
    case escape(sessionId: String)
    case modeToggle(sessionId: String)
    case updateSettings(settings: [String: AnyCodableValue])
    case ping
    case getState

    /// Encode to JSON dictionary for sending over WebSocket
    public func toJSON() -> [String: Any] {
        switch self {
        case .auth(let token):
            return ["action": "auth", "token": token]
        case .watchSession(let sessionId):
            return ["action": "watch_session", "sessionId": sessionId]
        case .unwatchSession(let sessionId):
            return ["action": "unwatch_session", "sessionId": sessionId]
        case .refreshSessions:
            return ["action": "refresh_sessions"]
        case .catchUp(let sessionId):
            return ["action": "catch_up", "sessionId": sessionId]
        case .inject(let command, let sessionId):
            return ["action": "inject", "command": command, "sessionId": sessionId]
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
        case .ping:
            return ["action": "ping"]
        case .getState:
            return ["action": "get_state"]
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
        // token_usage
        case input, output, usage
        // task_*
        case id, taskId, subject, description, activeForm, tasks
        // subagent
        case agentId, agentType, tool
        // error
        case code, message, details
        // pong
        case timestamp
        // state
        case clientId, watchingSessions, settings
        // question
        case questions
        // permission
        case command, isDestructive
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

        case "watching":
            let sessionId = try container.decode(String.self, forKey: .sessionId)
            let session = try container.decode(Session.self, forKey: .session)
            self = .watching(sessionId: sessionId, session: session)

        case "history":
            let sessionId = try container.decode(String.self, forKey: .sessionId)
            let data = try container.decode([HistoryEntry].self, forKey: .data)
            self = .history(sessionId: sessionId, data: data)

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
            let status = try container.decode(String.self, forKey: .status)
            self = .statusUpdate(status: status)

        case "token_usage":
            let input = try container.decodeIfPresent(Int.self, forKey: .input)
            let output = try container.decodeIfPresent(Int.self, forKey: .output)
            self = .tokenUsage(input: input, output: output)

        case "task_create":
            let id = try container.decodeIfPresent(String.self, forKey: .id)
            let subject = try container.decode(String.self, forKey: .subject)
            let description = try container.decodeIfPresent(String.self, forKey: .description)
            let activeForm = try container.decodeIfPresent(String.self, forKey: .activeForm)
            let status = try container.decodeIfPresent(String.self, forKey: .status)
            self = .taskCreate(id: id, subject: subject, description: description, activeForm: activeForm, status: status)

        case "task_update":
            let taskId = try container.decode(String.self, forKey: .taskId)
            let status = try container.decode(String.self, forKey: .status)
            let subject = try container.decodeIfPresent(String.self, forKey: .subject)
            self = .taskUpdate(taskId: taskId, status: status, subject: subject)

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
            self = .subagentStart(agentId: agentId, sessionId: sessionId, description: description, agentType: agentType)

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

        case "error":
            let code = try container.decode(String.self, forKey: .code)
            let message = try container.decode(String.self, forKey: .message)
            let details = try container.decodeIfPresent([String: AnyCodableValue].self, forKey: .details)
            self = .error(code: code, message: message, details: details)

        case "pong":
            let timestamp = try container.decode(Int.self, forKey: .timestamp)
            self = .pong(timestamp: timestamp)

        case "state":
            let clientId = try container.decodeIfPresent(String.self, forKey: .clientId)
            let watchingSessions = try container.decodeIfPresent([String].self, forKey: .watchingSessions)
            let settings = try container.decodeIfPresent([String: AnyCodableValue].self, forKey: .settings)
            self = .state(clientId: clientId, watchingSessions: watchingSessions, settings: settings)

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
