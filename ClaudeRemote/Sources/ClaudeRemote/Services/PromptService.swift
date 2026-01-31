import Foundation
import Observation

/// The kind of prompt being shown
public enum PromptKind: Sendable, Equatable {
    case permission(tool: String?, command: String?, isDestructive: Bool)
    case question(questions: [QuestionData])
}

/// The user's response to a permission prompt
public enum PermissionChoice: Sendable {
    case allow
    case allowAlways
    case deny
}

/// A prompt item displayed as a card
public struct PromptItem: Identifiable, Sendable, Equatable {
    public let id: UUID
    public let kind: PromptKind
    public let arrivedAt: Date
    public var isStale: Bool

    public init(
        kind: PromptKind,
        arrivedAt: Date = Date(),
        isStale: Bool = false
    ) {
        self.id = UUID()
        self.kind = kind
        self.arrivedAt = arrivedAt
        self.isStale = isStale
    }
}

/// Manages prompt queue, delay-suppress, staleness, auto-dismiss, and history recovery.
///
/// Ported from the web client's `prompts.js` patterns.
@Observable
@MainActor
public final class PromptService {
    // MARK: - Public State

    /// The active prompt being displayed (nil when no prompt)
    public private(set) var currentPrompt: PromptItem?

    // MARK: - Internal State

    /// Number of messages received since the current prompt was shown
    private var messagesSincePrompt = 0

    /// Pending permission waiting for the 500ms delay to elapse
    private var pendingPermission: PromptItem?

    /// Timer task for the 500ms permission delay
    private var delayTask: Task<Void, Never>?

    /// Task for multi-select sequential injection
    private var multiSelectTask: Task<Void, Never>?

    /// Closure to send actions back through the WebSocket
    private var sendHandler: (@MainActor (ClientAction) -> Void)?

    /// The session ID to use for inject/escape/mode_toggle actions
    public var sessionId: String?

    // MARK: - Init

    public init() {}

    /// Set the handler for sending actions (called by AppCoordinator after init)
    public func setSendHandler(_ handler: @escaping @MainActor (ClientAction) -> Void) {
        self.sendHandler = handler
    }

    // MARK: - Public API

    /// Handle a claude_output message from the server
    public func handleClaudeOutput(_ data: ClaudeOutputData) {
        switch data.type {
        case "permission_request":
            handlePermissionRequest(data)

        case "ask_user_question":
            handleQuestion(data)

        case "tool_result":
            // Cancel pending permission if tool_result arrives within 500ms
            cancelPendingPermission()
            // Auto-dismiss current permission prompt
            if case .permission = currentPrompt?.kind {
                dismissPrompt()
            }
            incrementMessageCounter()

        case "assistant", "tool":
            incrementMessageCounter()

        default:
            break
        }
    }

    /// Handle a session_status change
    public func handleSessionStatus(_ status: SessionStatus) {
        if status == .processing {
            // Claude moved on — dismiss any active prompt
            dismissPrompt()
            cancelPendingPermission()
        }
    }

    /// Recover a prompt from history (called after loading history messages)
    public func recoverFromHistory(_ messages: [Message], sessionStatus: SessionStatus) {
        guard sessionStatus == .waiting else { return }

        // Scan backwards for the last permission_request or ask_user_question
        // that doesn't have a subsequent tool_result or user message
        var foundPromptIndex: Int?
        for i in stride(from: messages.count - 1, through: 0, by: -1) {
            let msg = messages[i]
            if msg.type == .toolResult || msg.type == .user {
                // A response was already given — no recovery needed
                break
            }
            if msg.type == .permissionRequest || msg.type == .askUserQuestion {
                foundPromptIndex = i
                break
            }
        }

        guard let index = foundPromptIndex else { return }
        let msg = messages[index]

        if msg.type == .permissionRequest {
            let prompt = PromptItem(
                kind: .permission(
                    tool: msg.tool,
                    command: extractCommand(from: msg),
                    isDestructive: msg.isDestructive
                ),
                arrivedAt: msg.timestamp,
                isStale: true
            )
            showPrompt(prompt)
        } else if msg.type == .askUserQuestion, let questions = msg.questions, !questions.isEmpty {
            let prompt = PromptItem(
                kind: .question(questions: questions),
                arrivedAt: msg.timestamp,
                isStale: true
            )
            showPrompt(prompt)
        }
    }

    /// Dismiss the current prompt
    public func dismiss() {
        dismissPrompt()
    }

    /// Respond with a single text value (for "Other" freeform input or single-select)
    public func respond(text: String) {
        guard let sid = sessionId else { return }
        sendHandler?(.inject(command: text, sessionId: sid))
        dismissPrompt()
    }

    /// Respond to a permission prompt
    public func respondPermission(_ choice: PermissionChoice) {
        guard let sid = sessionId else { return }
        switch choice {
        case .allow:
            sendHandler?(.inject(command: "y", sessionId: sid))
        case .allowAlways:
            sendHandler?(.inject(command: "always", sessionId: sid))
        case .deny:
            sendHandler?(.inject(command: "n", sessionId: sid))
        }
        dismissPrompt()
    }

    /// Respond with multiple selections (multi-select question)
    /// Injects each selection with 1000ms delay, then submits with empty string
    public func respondMultiSelect(_ selections: [String]) {
        guard let sid = sessionId else { return }
        dismissPrompt()

        multiSelectTask = Task { @MainActor [sendHandler] in
            for selection in selections {
                guard !Task.isCancelled else { return }
                sendHandler?(.inject(command: selection, sessionId: sid))
                try? await Task.sleep(for: .seconds(1))
            }
            guard !Task.isCancelled else { return }
            // Submit with empty string
            sendHandler?(.inject(command: "", sessionId: sid))
        }
    }

    // MARK: - Private

    private func handlePermissionRequest(_ data: ClaudeOutputData) {
        // Cancel any existing pending permission
        cancelPendingPermission()

        let command = data.content ?? data.input?["command"]?.stringValue
        let prompt = PromptItem(
            kind: .permission(
                tool: data.tool,
                command: command,
                isDestructive: data.isDestructive ?? false
            )
        )

        // Store as pending and start 500ms timer
        pendingPermission = prompt
        delayTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled, let self else { return }
            // Timer fired — show the permission card
            if let pending = self.pendingPermission {
                self.pendingPermission = nil
                self.showPrompt(pending)
            }
        }
    }

    private func handleQuestion(_ data: ClaudeOutputData) {
        guard let questions = data.questions, !questions.isEmpty else { return }
        // Questions show immediately (no delay)
        let prompt = PromptItem(kind: .question(questions: questions))
        showPrompt(prompt)
    }

    private func cancelPendingPermission() {
        delayTask?.cancel()
        delayTask = nil
        pendingPermission = nil
    }

    private func showPrompt(_ prompt: PromptItem) {
        currentPrompt = prompt
        messagesSincePrompt = 0
    }

    private func dismissPrompt() {
        currentPrompt = nil
        messagesSincePrompt = 0
        cancelPendingPermission()
        multiSelectTask?.cancel()
        multiSelectTask = nil
    }

    private func incrementMessageCounter() {
        guard currentPrompt != nil else { return }
        messagesSincePrompt += 1
        if messagesSincePrompt >= 2, currentPrompt?.isStale == false {
            currentPrompt?.isStale = true
        }
    }

    private func extractCommand(from message: Message) -> String? {
        message.content ?? message.toolInput?["command"]?.stringValue
    }
}
