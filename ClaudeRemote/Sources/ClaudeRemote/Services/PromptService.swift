import Foundation
import Observation

/// The kind of prompt being shown
public enum PromptKind: Sendable, Equatable {
    case permission(tool: String?, command: String?, isDestructive: Bool)
    case question(questions: [QuestionData])
    case planExit
}

/// The user's response to a plan exit prompt
public enum PlanExitOption: Sendable, Equatable {
    case acceptPreserveContext  // Option 2: preserves conversation context (recommended)
    case acceptClearContext     // Option 1: clears context (destructive)
    case manualApprove          // Option 3: manually approve each edit
    case requestChanges(String) // Option 4: free-form modification text
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
    /// Correlation ID for matching tool_result dismissals to the correct queue item
    public let toolUseId: String?
    /// Human-readable label for subagent permissions (e.g. "Security review of iOS app")
    public let agentDescription: String?
    /// Monotonic arrival order for FIFO sorting (0 = unordered, appended at end)
    let arrivalOrder: Int

    public init(
        kind: PromptKind,
        arrivedAt: Date = Date(),
        isStale: Bool = false,
        toolUseId: String? = nil,
        agentDescription: String? = nil,
        arrivalOrder: Int = 0
    ) {
        self.id = UUID()
        self.kind = kind
        self.arrivedAt = arrivedAt
        self.isStale = isStale
        self.toolUseId = toolUseId
        self.agentDescription = agentDescription
        self.arrivalOrder = arrivalOrder
    }
}

/// Manages prompt queue, delay-suppress, staleness, auto-dismiss, and history recovery.
///
/// Supports multiple concurrent permissions via a FIFO queue. The queue head
/// (`currentPrompt`) is the actionable item; subsequent items are visible but
/// have disabled buttons until they become the head.
@Observable
@MainActor
public final class PromptService {
    // MARK: - Public State

    /// All pending prompts in FIFO order. The head (first) is the active prompt.
    public private(set) var promptQueue: [PromptItem] = []

    /// The active prompt being displayed — queue head (nil when queue is empty).
    public var currentPrompt: PromptItem? { promptQueue.first }

    // MARK: - Allowed Tools (from claudeState)

    /// Tools that are pre-allowed and should never show permission prompts
    private var allowedTools: Set<String> = []

    /// Update allowed tools from a claudeState permissions payload
    public func updateAllowedTools(_ permissions: ClaudeState.Permissions) {
        var tools = Set(permissions.allowedTools ?? [])
        tools.formUnion(permissions.sessionGranted ?? [])
        allowedTools = tools
    }

    /// Check if a tool is pre-allowed (no permission prompt needed).
    /// Uses exact match only — domain-scoped grants like WebFetch(domain:x.com)
    /// are handled by Claude Code internally. If Claude Code auto-approves,
    /// the coalesce delay + tool_result suppression handles it.
    private func isToolAllowed(_ tool: String) -> Bool {
        allowedTools.contains(tool)
    }

    // MARK: - Internal State

    /// Number of messages received since any prompt was shown
    private var messagesSincePrompt = 0

    /// Monotonic counter for preserving FIFO order among pending permissions
    private var arrivalCounter: Int = 0

    /// Permissions waiting for their individual 500ms delays to elapse (keyed by pendingKey)
    private var pendingPermissions: [String: (item: PromptItem, order: Int)] = [:]

    /// Single coalescing timer that batches rapid permission arrivals into one flush
    private var coalesceTask: Task<Void, Never>?

    /// Timestamp of the first buffered permission (for anti-starvation max-hold)
    private var firstPendingArrival: Date?

    /// Coalescing delay — resets on each new arrival
    private static let coalesceDelay: Duration = .milliseconds(300)

    /// Maximum time to hold permissions before forced flush (prevents starvation)
    private static let maxHoldTime: TimeInterval = 0.6

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
    public func handleClaudeOutput(_ data: ClaudeOutputData, agentDescription: String? = nil) {
        switch data.type {
        case "permission_request":
            handlePermissionRequest(data, agentDescription: agentDescription)

        case "ask_user_question":
            handleQuestion(data, agentDescription: agentDescription)

        case "exit_plan_mode":
            handlePlanExit(agentDescription: agentDescription)

        case "tool_result":
            // Cancel pending permission matching this tool_result's toolUseId,
            // or dismiss from queue if already enqueued (but not both)
            if !cancelPendingPermission(toolUseId: data.toolUseId) {
                dismissPermission(toolUseId: data.toolUseId)
            }
            incrementMessageCounter()

        case "assistant", "tool":
            incrementMessageCounter()

        default:
            break
        }
    }

    /// Handle a permission_resolved message from the server.
    /// Removes the matching prompt from the queue (or cancels a pending permission).
    public func handlePermissionResolved(toolUseId: String) {
        // Try cancelling from pending buffer first
        if cancelPendingPermission(toolUseId: toolUseId) { return }
        // Otherwise remove from the live queue
        dismissPermission(toolUseId: toolUseId)
    }

    /// Handle a session_status change
    public func handleSessionStatus(_ status: SessionStatus) {
        // Note: we intentionally do NOT clearQueue() on .processing.
        // In multi-agent mode, one agent starting to process doesn't mean
        // others are done waiting. Each prompt is properly dismissed by its
        // own tool_result event via dismissPermission(toolUseId:).
        // Session disconnect/switch still calls clearQueue() explicitly.
    }

    /// Recover prompts from history (called after loading history messages).
    /// Finds ALL unmatched permission_request/ask_user_question entries.
    public func recoverFromHistory(_ messages: [Message], sessionStatus: SessionStatus) {
        guard sessionStatus == .waiting else { return }
        clearQueue() // Prevent duplicates on reconnect

        // Collect all prompt messages and track which have been answered
        var answeredToolUseIds: Set<String> = []
        var unansweredPrompts: [Message] = []

        // Forward scan: find prompts and track which are answered
        var promptIndices: [(index: Int, msg: Message)] = []
        for (i, msg) in messages.enumerated() {
            if msg.type == .toolResult, let tuId = msg.toolUseId {
                answeredToolUseIds.insert(tuId)
            }
            // tool_results are merged into tool/permissionRequest messages —
            // if resultContent is set, the tool already completed
            if (msg.type == .tool || msg.type == .permissionRequest), msg.resultContent != nil,
               let tuId = msg.toolUseId {
                answeredToolUseIds.insert(tuId)
            }
            if msg.type == .permissionRequest || msg.type == .askUserQuestion {
                promptIndices.append((i, msg))
            }
        }

        // A prompt is unanswered if:
        // - Permission: no matching tool_result and no immediately following user message
        // - Question: no subsequent user message (answer injection)
        for (idx, msg) in promptIndices {
            if msg.type == .permissionRequest {
                if let tuId = msg.toolUseId, answeredToolUseIds.contains(tuId) {
                    continue
                }
                // Also skip if a user message follows it (manual answer)
                if idx + 1 < messages.count && messages[idx + 1].type == .user {
                    continue
                }
            } else if msg.type == .askUserQuestion {
                // Question answered if followed by a user message anywhere after it
                let hasFollowingUserMsg = ((idx + 1)..<messages.count).contains {
                    messages[$0].type == .user
                }
                if hasFollowingUserMsg { continue }
            }
            unansweredPrompts.append(msg)
        }

        for msg in unansweredPrompts {
            if msg.type == .permissionRequest {
                // Don't filter by isToolAllowed here — the server already filters
                // permission_requests with matching tool_results. If one reached us
                // without a tool_result, Claude Code is genuinely waiting for it,
                // regardless of the tool's "always" grant status.
                let prompt = PromptItem(
                    kind: .permission(
                        tool: msg.tool,
                        command: extractCommand(from: msg),
                        isDestructive: msg.isDestructive
                    ),
                    arrivedAt: msg.timestamp,
                    isStale: true,
                    toolUseId: msg.toolUseId
                )
                enqueuePrompt(prompt)
            } else if msg.type == .askUserQuestion, let questions = msg.questions, !questions.isEmpty {
                let prompt = PromptItem(
                    kind: .question(questions: questions),
                    arrivedAt: msg.timestamp,
                    isStale: true
                )
                enqueuePrompt(prompt)
            }
        }
    }

    /// Dismiss the current (head) prompt
    public func dismiss() {
        dismissHead()
        // Cancel multi-select even if queue was already empty
        // (respondMultiSelect dismisses head before starting its task)
        multiSelectTask?.cancel()
        multiSelectTask = nil
    }

    /// Respond with a single text value (for freeform-only questions with no options)
    public func respond(text: String) {
        guard let sid = sessionId else { return }
        sendHandler?(.inject(command: text, sessionId: sid))
        dismissHead()
    }

    /// Respond with freeform "Other" text. Uses direct `inject` (typed text) rather
    /// than `selectOption` + `inject`, matching the web client's approach. Claude Code's
    /// AskUserQuestion accepts typed text directly — the ink Select arrow-key mechanism
    /// is not needed for freeform responses.
    public func respondOther(optionCount: Int, text: String) {
        guard let sid = sessionId else { return }
        sendHandler?(.inject(command: text, sessionId: sid))
        dismissHead()
    }

    /// Respond by selecting a pre-defined option by its index.
    /// Uses arrow-key navigation instead of text injection because Claude Code's
    /// ink-based AskUserQuestion selector ignores typed text.
    public func respondOption(index: Int) {
        guard let sid = sessionId else { return }
        sendHandler?(.selectOption(index: index, sessionId: sid))
        dismissHead()
    }

    /// Approve all pending permissions at once. Sends "always" for head, cascades the rest.
    public func approveAll() {
        guard let sid = sessionId else { return }
        guard case .permission = currentPrompt?.kind else { return }

        // Collect all unique tools from queue + pending
        var allTools: Set<String> = []
        for item in promptQueue {
            if case .permission(let t, _, _) = item.kind, let t { allTools.insert(t) }
        }
        for (_, pending) in pendingPermissions {
            if case .permission(let t, _, _) = pending.item.kind, let t { allTools.insert(t) }
        }

        // Send "always" for the head permission (unblocks Claude Code)
        let headToolUseId = currentPrompt?.toolUseId
        sendHandler?(.inject(command: "always", sessionId: sid, toolUseId: headToolUseId))
        dismissHead()

        // Persist all tools to allowedTools (skips future prompts)
        allowedTools.formUnion(allTools)

        // Cancel all pending permissions
        pendingPermissions.removeAll()
        coalesceTask?.cancel()
        coalesceTask = nil
        firstPendingArrival = nil

        // Clear remaining permissions from queue (preserve questions/planExit)
        promptQueue.removeAll { item in
            if case .permission = item.kind { return true }
            return false
        }
    }

    /// Respond to a permission prompt (always applies to queue head)
    public func respondPermission(_ choice: PermissionChoice) {
        guard let sid = sessionId else { return }
        let headPrompt = currentPrompt
        let respondedTool = headPrompt.flatMap { prompt -> String? in
            if case .permission(let tool, _, _) = prompt.kind { return tool }
            return nil
        }
        let respondedToolUseId = headPrompt?.toolUseId

        switch choice {
        case .allow:
            sendHandler?(.inject(command: "y", sessionId: sid))
        case .allowAlways:
            // Pass toolUseId so server can accurately track which tool was granted
            sendHandler?(.inject(command: "always", sessionId: sid, toolUseId: respondedToolUseId))
        case .deny:
            sendHandler?(.inject(command: "n", sessionId: sid))
        }
        dismissHead()

        // "Allow Always" cascade: remove other permissions with the same tool
        if choice == .allowAlways, let tool = respondedTool {
            cascadeAlwaysAllow(tool: tool)
        }
    }

    /// Respond with multiple selections (multi-select question)
    /// Injects each selection with 1000ms delay, then submits with empty string
    public func respondMultiSelect(_ selections: [String]) {
        guard let sid = sessionId else { return }
        dismissHead()

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

    /// Clear the entire queue (used on session switch)
    public func clearQueue() {
        promptQueue.removeAll()
        messagesSincePrompt = 0
        cancelAllPendingPermissions()
        multiSelectTask?.cancel()
        multiSelectTask = nil
    }

    // MARK: - Private

    private func handlePermissionRequest(_ data: ClaudeOutputData, agentDescription: String?) {
        // Auto-respond if tool is pre-allowed (from claudeState or approveAll).
        // The terminal may still be blocked on this prompt (e.g., after approveAll cleared
        // the queue but subagent prompts keep arriving). Injecting "always" unblocks it.
        if let tool = data.tool, isToolAllowed(tool) {
            if let sid = sessionId {
                sendHandler?(.inject(command: "always", sessionId: sid, toolUseId: data.toolUseId))
            }
            return
        }

        // Dedup: remove any existing prompt with the same toolUseId (e.g. from history recovery)
        if let toolUseId = data.toolUseId {
            promptQueue.removeAll { $0.toolUseId == toolUseId }
        }

        let command = data.content ?? data.input?["command"]?.stringValue
        let pendingKey = data.toolUseId ?? UUID().uuidString
        arrivalCounter += 1
        let order = arrivalCounter
        let prompt = PromptItem(
            kind: .permission(
                tool: data.tool,
                command: command,
                isDestructive: data.isDestructive ?? false
            ),
            toolUseId: data.toolUseId,
            agentDescription: agentDescription,
            arrivalOrder: order
        )

        // Store as pending and schedule coalesced flush
        pendingPermissions[pendingKey] = (item: prompt, order: order)
        scheduleCoalescedEnqueue()
    }

    private func handleQuestion(_ data: ClaudeOutputData, agentDescription: String?) {
        guard let questions = data.questions, !questions.isEmpty else { return }
        // Questions show immediately (no delay)
        let prompt = PromptItem(
            kind: .question(questions: questions),
            agentDescription: agentDescription
        )
        enqueuePrompt(prompt)
    }

    private func handlePlanExit(agentDescription: String?) {
        // Plan exit prompts show immediately (no delay)
        let prompt = PromptItem(
            kind: .planExit,
            agentDescription: agentDescription
        )
        enqueuePrompt(prompt)
    }

    /// Respond to a plan exit prompt using arrow-key selection.
    /// ExitPlanMode uses an ink-based TUI selector like AskUserQuestion.
    public func respondPlanExit(_ option: PlanExitOption) {
        guard let sid = sessionId else { return }

        switch option {
        case .acceptPreserveContext:
            // Option 2 (0-indexed: 1) — preserves context
            sendHandler?(.selectOption(index: 1, sessionId: sid))
        case .acceptClearContext:
            // Option 1 (0-indexed: 0) — clears context (destructive)
            sendHandler?(.selectOption(index: 0, sessionId: sid))
        case .manualApprove:
            // Option 3 (0-indexed: 2) — manually approve each edit
            sendHandler?(.selectOption(index: 2, sessionId: sid))
        case .requestChanges(let text):
            // Option 4 (0-indexed: 3) — select text input field, then inject text
            sendHandler?(.selectOption(index: 3, sessionId: sid))
            // Small delay before injecting text to allow selector to focus text field
            Task { @MainActor [sendHandler] in
                try? await Task.sleep(for: .milliseconds(300))
                sendHandler?(.inject(command: text, sessionId: sid))
            }
        }
        dismissHead()
    }

    /// Cancel a pending permission (still buffered before coalesce flush). Returns true if found.
    @discardableResult
    private func cancelPendingPermission(toolUseId: String?) -> Bool {
        if let toolUseId {
            for (key, pending) in pendingPermissions where pending.item.toolUseId == toolUseId {
                pendingPermissions.removeValue(forKey: key)
                return true
            }
            return false // Specific ID not found — don't fallback to removing unrelated items
        }
        // Fallback: cancel the oldest pending permission (by arrival order)
        // Only used for nil toolUseId (legacy tool_result path)
        if let oldest = pendingPermissions.min(by: { $0.value.order < $1.value.order })?.key {
            pendingPermissions.removeValue(forKey: oldest)
            return true
        }
        return false
    }

    private func cancelAllPendingPermissions() {
        coalesceTask?.cancel()
        coalesceTask = nil
        firstPendingArrival = nil
        pendingPermissions.removeAll()
    }

    /// Schedule a coalesced flush of all pending permissions.
    /// Resets on each new arrival (debounce), but forces flush after maxHoldTime
    /// to prevent starvation when permissions arrive continuously.
    private func scheduleCoalescedEnqueue() {
        if firstPendingArrival == nil {
            firstPendingArrival = Date()
        }
        coalesceTask?.cancel()

        // Compute delay: use coalesceDelay or remaining maxHoldTime, whichever is shorter
        let elapsed = Date().timeIntervalSince(firstPendingArrival!)
        let remaining = max(0, Self.maxHoldTime - elapsed)
        let delayMs = min(Double(Self.coalesceDelay.components.seconds) * 1000
                         + Double(Self.coalesceDelay.components.attoseconds) / 1e15,
                         remaining * 1000)

        coalesceTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(Int(delayMs)))
            guard !Task.isCancelled, let self else { return }
            self.flushPendingPermissions()
        }
    }

    /// Flush all buffered permissions into the queue in one batch (single @Observable mutation).
    private func flushPendingPermissions() {
        guard !pendingPermissions.isEmpty else { return }
        let sorted = pendingPermissions.sorted { $0.value.order < $1.value.order }
        pendingPermissions.removeAll()
        firstPendingArrival = nil
        coalesceTask = nil

        // Build new queue locally, then assign once for a single SwiftUI render pass
        var queue = promptQueue
        let wasEmpty = queue.isEmpty
        for (_, entry) in sorted {
            let prompt = entry.item
            if prompt.arrivalOrder > 0 {
                let insertAt = queue.firstIndex(where: { $0.arrivalOrder > prompt.arrivalOrder })
                    ?? queue.count
                queue.insert(prompt, at: insertAt)
            } else {
                queue.append(prompt)
            }
        }
        promptQueue = queue  // Single @Observable mutation
        if wasEmpty && !promptQueue.isEmpty {
            messagesSincePrompt = 0
        }
    }

    /// Enqueue a prompt. Items with arrivalOrder > 0 are inserted in FIFO order
    /// to handle 500ms delay tasks that may fire out of scheduling order.
    /// Items with arrivalOrder == 0 (questions, history recovery) are appended at the end.
    private func enqueuePrompt(_ prompt: PromptItem) {
        if prompt.arrivalOrder > 0 {
            // Sorted insertion: find first item with a higher arrivalOrder
            let insertAt = promptQueue.firstIndex(where: { $0.arrivalOrder > prompt.arrivalOrder })
                ?? promptQueue.count
            promptQueue.insert(prompt, at: insertAt)
        } else {
            promptQueue.append(prompt)
        }
        if promptQueue.count == 1 {
            messagesSincePrompt = 0
        }
    }

    private func dismissHead() {
        guard !promptQueue.isEmpty else { return }
        promptQueue.removeFirst()
        messagesSincePrompt = 0
        multiSelectTask?.cancel()
        multiSelectTask = nil
    }

    /// Dismiss a specific queued permission matching a tool_result's toolUseId
    private func dismissPermission(toolUseId: String?) {
        if let toolUseId {
            if let idx = promptQueue.firstIndex(where: { $0.toolUseId == toolUseId }) {
                promptQueue.remove(at: idx)
            }
            // toolUseId provided — don't fallback to head dismissal even if not found
            // (the item may have already been dismissed by user or cascadeAlwaysAllow)
            return
        }
        // Fallback ONLY when no toolUseId provided (legacy path)
        if case .permission = promptQueue.first?.kind {
            dismissHead()
        }
    }

    /// After "Allow Always", proactively remove other permissions for the same tool
    /// and persist the grant so future requests are auto-skipped without a server round-trip.
    private func cascadeAlwaysAllow(tool: String) {
        // Persist grant client-side so handlePermissionRequest → isToolAllowed skips future prompts
        allowedTools.insert(tool)

        // Cancel pending permissions for the same tool
        for (key, pending) in pendingPermissions {
            if case .permission(let t, _, _) = pending.item.kind, t == tool {
                pendingPermissions.removeValue(forKey: key)
            }
        }
        // Remove queued permissions for the same tool
        promptQueue.removeAll { item in
            if case .permission(let t, _, _) = item.kind { return t == tool }
            return false
        }
    }

    private func incrementMessageCounter() {
        guard !promptQueue.isEmpty else { return }
        messagesSincePrompt += 1
        if messagesSincePrompt >= 2 {
            for i in promptQueue.indices where !promptQueue[i].isStale {
                promptQueue[i].isStale = true
            }
        }
        // Safety-net auto-removal: after 30+ messages, remove stale permission prompts.
        // High threshold reduces risk of removing still-pending permissions.
        // Questions and planExit prompts are NEVER auto-removed — they require explicit user action.
        if messagesSincePrompt >= 30 {
            promptQueue.removeAll { item in
                guard item.isStale else { return false }
                if case .permission = item.kind { return true }
                return false
            }
        }
    }

    private func extractCommand(from message: Message) -> String? {
        message.content ?? message.toolInput?["command"]?.stringValue
    }
}
