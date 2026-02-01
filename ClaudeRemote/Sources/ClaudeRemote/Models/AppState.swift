import Foundation
import Observation

/// Session switch state machine
public enum SessionSwitchState: Sendable {
    case idle
    case switching
    case active
}

/// Claude Code session mode (server-driven, synced from JSONL permissionMode)
public enum SessionMode: String, Sendable {
    case defaultMode = "default"
    case acceptEdits = "acceptEdits"
    case plan = "plan"

    public var label: String {
        switch self {
        case .defaultMode: "Default"
        case .acceptEdits: "Accept Edits"
        case .plan: "Plan"
        }
    }
}

/// Info about an active subagent
public struct SubagentInfo: Sendable {
    public var status: String
    public var startTime: Date
    public var description: String
    public var agentType: String
    public var currentTool: String?
    public var inputTokens: Int
    public var outputTokens: Int
    public var lastActivity: Date

    public init(
        status: String = "running",
        startTime: Date = Date(),
        description: String = "",
        agentType: String = "general",
        currentTool: String? = nil,
        inputTokens: Int = 0,
        outputTokens: Int = 0,
        lastActivity: Date = Date()
    ) {
        self.status = status
        self.startTime = startTime
        self.description = description
        self.agentType = agentType
        self.currentTool = currentTool
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.lastActivity = lastActivity
    }
}

/// Single source of truth for all app state
@Observable
@MainActor
public final class AppState {
    // MARK: - Connection
    public var isAuthenticated = false
    public var isConnected = false
    public var serverURL: String = ""
    /// Set when user explicitly disconnects; suppresses auto-connect in AuthView
    public var userDidDisconnect = false

    // MARK: - Sessions
    public var sessions: [Session] = []
    public var currentSessionId: String?
    public var sessionSwitchState: SessionSwitchState = .idle
    public var pendingSessionId: String?

    // MARK: - Messages
    public var messages: [Message] = []
    public var sessionStatus: SessionStatus = .idle

    // MARK: - Commands
    public var slashCommands: [SlashCommand] = []

    // MARK: - Subagents & Tasks
    public var activeSubagents: [String: SubagentInfo] = [:]
    public var tasks: [TaskItem] = []

    // MARK: - Toast
    public var currentToast: ToastItem?

    /// Show a toast notification that auto-dismisses
    public func showToast(_ message: String, icon: String, style: ToastItem.ToastStyle = .info) {
        currentToast = ToastItem(message: message, icon: icon, style: style)
    }

    // MARK: - Mode & Activity
    public var sessionMode: SessionMode = .defaultMode
    /// Current spinner/activity text (e.g. "Thinking..."), nil when idle
    public var currentActivity: String?

    // MARK: - Context Window
    public var contextTokensUsed: Int = 0
    public static let defaultContextWindowSize = 200_000

    public var contextPercentage: Double {
        guard contextTokensUsed > 0 else { return 0 }
        return min(Double(contextTokensUsed) / Double(Self.defaultContextWindowSize), 1.0)
    }

    // MARK: - Settings
    public var ttsEnabled = false
    public var speakTools = false
    public var triggerEnabled = false
    public var speechRate: Float = 1.0
    public var voiceIdentifier: String?
    public var notifyEnabled = false
    public var debugMode = false

    // MARK: - App Lifecycle
    /// Whether the app is currently in the foreground (used to suppress notifications)
    public var isInForeground = true

    // MARK: - Pending State
    /// Recent user messages for deduplication (normalized content -> timestamp)
    public var recentUserMessages: [String: Date] = [:]

    // MARK: - Subagent Correlation
    /// Pending subagent_starting messages awaiting agentId correlation (FIFO).
    public var pendingSubagentMessages: [(description: String, messageIndex: Int)] = []
    /// Maps agentId to index in messages array for in-place updates.
    public var subagentMessageMap: [String: Int] = [:]

    // MARK: - Constants
    public static let maxMessages = 500
    public static let dedupWindow: TimeInterval = 10

    public init() {}

    // MARK: - Message Management

    /// Add a message, trimming oldest if over max.
    /// Filters out literal "(no content)" placeholder messages.
    public func appendMessage(_ message: Message) {
        let text = message.content?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if text == "(no content)" {
            return
        }
        messages.append(message)
        if messages.count > Self.maxMessages {
            messages.removeFirst(messages.count - Self.maxMessages)
        }
    }

    /// Merge a tool_result into its matching tool message, or append standalone
    public func mergeOrAppendToolResult(_ message: Message) {
        if let toolUseId = message.toolUseId,
           let index = messages.lastIndex(where: { $0.toolUseId == toolUseId && ($0.type == .tool || $0.type == .permissionRequest) }) {
            messages[index].resultContent = message.content
            messages[index].resultIsError = message.resultIsError
        } else {
            appendMessage(message)
        }
    }

    /// Clear all messages
    public func clearMessages() {
        messages.removeAll()
        tasks.removeAll()
        pendingSubagentMessages.removeAll()
        subagentMessageMap.removeAll()
    }

    /// Update a subagent message's mutable fields by its index.
    public func updateSubagentMessage(at index: Int, status: String?, tool: String?, agentId: String? = nil) {
        guard index < messages.count else { return }
        if let status { messages[index].subagentStatus = status }
        if let tool { messages[index].subagentCurrentTool = tool }
        if let agentId { messages[index].subagentAgentId = agentId }
    }

    // MARK: - Deduplication

    /// Track a sent message for dedup
    public func trackSentMessage(_ content: String) {
        let key = Self.normalizeForDedup(content)
        recentUserMessages[key] = Date()
        cleanupExpiredDedup()
    }

    /// Check if a message should be deduped (returns true if duplicate)
    public func shouldDedupeMessage(_ content: String) -> Bool {
        let key = Self.normalizeForDedup(content)
        if recentUserMessages[key] != nil {
            recentUserMessages.removeValue(forKey: key)
            return true
        }
        return false
    }

    private static let whitespaceRegex = try! NSRegularExpression(pattern: "\\s+")

    /// Normalize content for deduplication
    public static func normalizeForDedup(_ content: String) -> String {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        return Self.whitespaceRegex.stringByReplacingMatches(
            in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed),
            withTemplate: " "
        )
    }

    /// Remove expired dedup entries
    private func cleanupExpiredDedup() {
        let cutoff = Date().addingTimeInterval(-Self.dedupWindow)
        recentUserMessages = recentUserMessages.filter { $0.value > cutoff }
    }

    // MARK: - Session Switching

    /// Begin switching to a session
    public func beginSessionSwitch(to sessionId: String) {
        sessionSwitchState = .switching
        pendingSessionId = sessionId
        // Clear stale data from previous session immediately
        messages.removeAll()
        tasks.removeAll()
        activeSubagents.removeAll()
        pendingSubagentMessages.removeAll()
        subagentMessageMap.removeAll()
        contextTokensUsed = 0
        sessionStatus = .idle
        sessionMode = .defaultMode
        currentActivity = nil
    }

    /// Confirm session switch completed
    public func confirmSessionSwitch(sessionId: String) {
        if sessionSwitchState == .switching && sessionId == pendingSessionId {
            currentSessionId = sessionId
            sessionSwitchState = .active
            pendingSessionId = nil
        } else if sessionSwitchState == .idle {
            // Initial connection or reconnection
            currentSessionId = sessionId
            sessionSwitchState = .active
        }
    }
}
