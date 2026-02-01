import Foundation

/// Types of messages in the chat
public enum MessageType: String, Codable, Sendable {
    case assistant
    case user
    case tool
    case toolResult = "tool_result"
    case statusUpdate = "status_update"
    case permissionRequest = "permission_request"
    case askUserQuestion = "ask_user_question"
    case tokenUsage = "token_usage"
    case subagentStarting = "subagent_starting"
    case unknown

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let raw = try container.decode(String.self)
        self = MessageType(rawValue: raw) ?? .unknown
    }
}

/// A message displayed in the chat view
public struct Message: Identifiable, Sendable {
    public let id: UUID
    public let type: MessageType
    public let content: String?
    public let tool: String?
    public let toolInput: [String: AnyCodableValue]?
    public let language: String?
    public let timestamp: Date
    public let isSubagent: Bool
    public let subagentId: String?
    public let questions: [QuestionData]?
    public let isDestructive: Bool
    public let toolUseId: String?
    /// Merged tool result content (set when a tool_result is merged into its tool_use)
    public var resultContent: String?
    /// Whether the merged tool result was an error
    public var resultIsError: Bool
    /// Subagent lifecycle state: "starting", "running", "completed"
    public var subagentStatus: String?
    /// Current tool being used by subagent (updated on subagent_tool)
    public var subagentCurrentTool: String?
    /// Linked agent ID (set when subagent_start correlates to this message)
    public var subagentAgentId: String?

    public init(
        type: MessageType,
        content: String? = nil,
        tool: String? = nil,
        toolInput: [String: AnyCodableValue]? = nil,
        language: String? = nil,
        timestamp: Date = Date(),
        isSubagent: Bool = false,
        subagentId: String? = nil,
        questions: [QuestionData]? = nil,
        isDestructive: Bool = false,
        toolUseId: String? = nil,
        resultContent: String? = nil,
        resultIsError: Bool = false,
        subagentStatus: String? = nil,
        subagentCurrentTool: String? = nil,
        subagentAgentId: String? = nil
    ) {
        self.id = UUID()
        self.type = type
        self.content = content
        self.tool = tool
        self.toolInput = toolInput
        self.language = language
        self.timestamp = timestamp
        self.isSubagent = isSubagent
        self.subagentId = subagentId
        self.questions = questions
        self.isDestructive = isDestructive
        self.toolUseId = toolUseId
        self.resultContent = resultContent
        self.resultIsError = resultIsError
        self.subagentStatus = subagentStatus
        self.subagentCurrentTool = subagentCurrentTool
        self.subagentAgentId = subagentAgentId
    }
}

/// Type-erased Codable value for dynamic JSON
public enum AnyCodableValue: Sendable, Equatable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case null
    case array([AnyCodableValue])
    case dictionary([String: AnyCodableValue])
}

extension AnyCodableValue: Codable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
            return
        }
        if let s = try? container.decode(String.self) {
            self = .string(s)
            return
        }
        if let b = try? container.decode(Bool.self) {
            self = .bool(b)
            return
        }
        if let i = try? container.decode(Int.self) {
            self = .int(i)
            return
        }
        if let d = try? container.decode(Double.self) {
            self = .double(d)
            return
        }
        if let arr = try? container.decode([AnyCodableValue].self) {
            self = .array(arr)
            return
        }
        if let dict = try? container.decode([String: AnyCodableValue].self) {
            self = .dictionary(dict)
            return
        }
        self = .null
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let s): try container.encode(s)
        case .int(let i): try container.encode(i)
        case .double(let d): try container.encode(d)
        case .bool(let b): try container.encode(b)
        case .null: try container.encodeNil()
        case .array(let arr): try container.encode(arr)
        case .dictionary(let dict): try container.encode(dict)
        }
    }
}

extension AnyCodableValue {
    /// Extract string value if this is a string
    public var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    /// Extract int value if this is an int
    public var intValue: Int? {
        if case .int(let i) = self { return i }
        return nil
    }

    /// Extract bool value if this is a bool
    public var boolValue: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }
}
