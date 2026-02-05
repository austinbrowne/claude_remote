import Foundation

/// Server-assembled snapshot of a Claude Code session's full state.
/// Sent on initial watch, periodically (30s), and on permission changes.
public struct ClaudeState: Decodable, Sendable {
    public let session: SessionInfo?
    public let status: String?
    public let mode: String?
    public let contextPercentage: Double?
    public let permissions: Permissions?
    public let subagents: [String: SubagentState]?
    public let lastActivity: String?

    public struct SessionInfo: Decodable, Sendable {
        public let id: String?
        public let name: String?
        public let cwd: String?
        public let branch: String?
        public let tty: String?
        public let pid: Int?
    }

    public struct Permissions: Decodable, Sendable {
        public let allowedTools: [String]?
        public let sessionGranted: [String]?
        public let mode: String?
    }

    public struct SubagentState: Decodable, Sendable {
        public let status: String?
        public let description: String?
        public let agentType: String?
        public let currentTool: String?
        public let inputTokens: Int?
        public let outputTokens: Int?
        public let startTime: String?
        public let lastActivity: String?
    }
}
