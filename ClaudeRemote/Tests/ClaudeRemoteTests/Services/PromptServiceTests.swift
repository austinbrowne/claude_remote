import Testing
import Foundation
@testable import ClaudeRemote

@Suite("PromptService")
struct PromptServiceTests {

    // MARK: - Helpers

    @MainActor
    private static func makeSUT() -> (service: PromptService, actions: ActionCapture) {
        let capture = ActionCapture()
        let service = PromptService()
        service.setSendHandler { action in
            capture.actions.append(action)
        }
        service.sessionId = "test-session"
        return (service, capture)
    }

    // MARK: - Permission Delay and Suppress

    @MainActor
    @Test("permission_request is not shown immediately (delayed 500ms)")
    func permissionDelayed() {
        let (service, _) = Self.makeSUT()
        let data = ClaudeOutputData(type: "permission_request", tool: "Bash", input: ["command": .string("ls")])
        service.handleClaudeOutput(data)
        // Should NOT show immediately
        #expect(service.currentPrompt == nil)
        #expect(service.promptQueue.isEmpty)
    }

    @MainActor
    @Test("permission_request shows after 500ms delay")
    func permissionShowsAfterDelay() async throws {
        let (service, _) = Self.makeSUT()
        let data = ClaudeOutputData(type: "permission_request", tool: "Bash", input: ["command": .string("ls")])
        service.handleClaudeOutput(data)
        #expect(service.currentPrompt == nil)

        // Wait for the 500ms delay to fire
        try await Task.sleep(for: .milliseconds(600))
        #expect(service.currentPrompt != nil)
        #expect(service.promptQueue.count == 1)
        if case .permission(let tool, _, _) = service.currentPrompt?.kind {
            #expect(tool == "Bash")
        } else {
            Issue.record("Expected permission prompt")
        }
    }

    @MainActor
    @Test("permission_request suppressed if tool_result arrives within 500ms")
    func permissionSuppressed() async throws {
        let (service, _) = Self.makeSUT()
        let permData = ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-1")
        service.handleClaudeOutput(permData)
        #expect(service.currentPrompt == nil)

        // tool_result arrives before 500ms
        let resultData = ClaudeOutputData(type: "tool_result", content: "done", toolUseId: "tu-1")
        service.handleClaudeOutput(resultData)

        // Wait past the 500ms window
        try await Task.sleep(for: .milliseconds(600))
        // Should still be nil — was suppressed
        #expect(service.currentPrompt == nil)
        #expect(service.promptQueue.isEmpty)
    }

    // MARK: - Question Prompts

    @MainActor
    @Test("ask_user_question shows immediately without delay")
    func questionImmediate() {
        let (service, _) = Self.makeSUT()
        let questions = [QuestionData(question: "Pick one?", header: "Choice", options: [
            QuestionOption(label: "A"),
            QuestionOption(label: "B"),
        ])]
        let data = ClaudeOutputData(type: "ask_user_question", questions: questions)
        service.handleClaudeOutput(data)
        // Should show immediately
        #expect(service.currentPrompt != nil)
        #expect(service.promptQueue.count == 1)
        if case .question(let qs) = service.currentPrompt?.kind {
            #expect(qs.count == 1)
            #expect(qs[0].question == "Pick one?")
        } else {
            Issue.record("Expected question prompt")
        }
    }

    // MARK: - Auto-dismiss

    @MainActor
    @Test("permission prompt dismissed on tool_result")
    func autoDismissOnToolResult() async throws {
        let (service, _) = Self.makeSUT()
        // Show a permission prompt
        let data = ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-1")
        service.handleClaudeOutput(data)
        try await Task.sleep(for: .milliseconds(600))
        #expect(service.currentPrompt != nil)

        // tool_result arrives
        service.handleClaudeOutput(ClaudeOutputData(type: "tool_result", toolUseId: "tu-1"))
        #expect(service.currentPrompt == nil)
        #expect(service.promptQueue.isEmpty)
    }

    @MainActor
    @Test("prompt dismissed on session_status processing")
    func autoDismissOnProcessing() async throws {
        let (service, _) = Self.makeSUT()
        let questions = [QuestionData(question: "Pick?")]
        service.handleClaudeOutput(ClaudeOutputData(type: "ask_user_question", questions: questions))
        #expect(service.currentPrompt != nil)

        service.handleSessionStatus(.processing)
        #expect(service.currentPrompt == nil)
        #expect(service.promptQueue.isEmpty)
    }

    @MainActor
    @Test("session_status 'waiting' does not dismiss prompt")
    func waitingDoesNotDismiss() {
        let (service, _) = Self.makeSUT()
        let questions = [QuestionData(question: "Pick?")]
        service.handleClaudeOutput(ClaudeOutputData(type: "ask_user_question", questions: questions))
        #expect(service.currentPrompt != nil)

        service.handleSessionStatus(.waiting)
        #expect(service.currentPrompt != nil)
    }

    // MARK: - Staleness

    @MainActor
    @Test("prompt becomes stale after 2 assistant messages")
    func stalenessAfterTwoMessages() {
        let (service, _) = Self.makeSUT()
        let questions = [QuestionData(question: "Pick?")]
        service.handleClaudeOutput(ClaudeOutputData(type: "ask_user_question", questions: questions))
        #expect(service.currentPrompt?.isStale == false)

        service.handleClaudeOutput(ClaudeOutputData(type: "assistant", content: "msg1"))
        #expect(service.currentPrompt?.isStale == false)

        service.handleClaudeOutput(ClaudeOutputData(type: "assistant", content: "msg2"))
        #expect(service.currentPrompt?.isStale == true)
    }

    @MainActor
    @Test("tool messages also count toward staleness")
    func toolMessagesStaleness() {
        let (service, _) = Self.makeSUT()
        let questions = [QuestionData(question: "Pick?")]
        service.handleClaudeOutput(ClaudeOutputData(type: "ask_user_question", questions: questions))

        service.handleClaudeOutput(ClaudeOutputData(type: "tool", tool: "Read"))
        service.handleClaudeOutput(ClaudeOutputData(type: "tool_result", content: "done"))
        #expect(service.currentPrompt?.isStale == true)
    }

    // MARK: - History Recovery

    @MainActor
    @Test("recovers permission_request from history when waiting")
    func recoverPermission() {
        let (service, _) = Self.makeSUT()
        let messages = [
            Message(type: .assistant, content: "Let me run that"),
            Message(type: .permissionRequest, tool: "Bash", toolInput: ["command": .string("rm -rf")], isDestructive: true),
        ]
        service.recoverFromHistory(messages, sessionStatus: .waiting)
        #expect(service.currentPrompt != nil)
        #expect(service.promptQueue.count == 1)
        if case .permission(let tool, _, let isDestructive) = service.currentPrompt?.kind {
            #expect(tool == "Bash")
            #expect(isDestructive == true)
        } else {
            Issue.record("Expected permission prompt")
        }
    }

    @MainActor
    @Test("recovers ask_user_question from history when waiting")
    func recoverQuestion() {
        let (service, _) = Self.makeSUT()
        let questions = [QuestionData(question: "Which option?", options: [QuestionOption(label: "A")])]
        let messages = [
            Message(type: .assistant, content: "I need to ask you"),
            Message(type: .askUserQuestion, questions: questions),
        ]
        service.recoverFromHistory(messages, sessionStatus: .waiting)
        #expect(service.currentPrompt != nil)
        if case .question(let qs) = service.currentPrompt?.kind {
            #expect(qs[0].question == "Which option?")
        } else {
            Issue.record("Expected question prompt")
        }
    }

    @MainActor
    @Test("does not recover if session is not waiting")
    func noRecoverWhenNotWaiting() {
        let (service, _) = Self.makeSUT()
        let messages = [
            Message(type: .permissionRequest, tool: "Bash"),
        ]
        service.recoverFromHistory(messages, sessionStatus: .processing)
        #expect(service.currentPrompt == nil)
    }

    @MainActor
    @Test("does not recover if tool_result follows permission_request")
    func noRecoverAfterToolResult() {
        let (service, _) = Self.makeSUT()
        let messages = [
            Message(type: .permissionRequest, tool: "Bash", toolUseId: "tu-1"),
            Message(type: .toolResult, content: "done", toolUseId: "tu-1"),
        ]
        service.recoverFromHistory(messages, sessionStatus: .waiting)
        #expect(service.currentPrompt == nil)
    }

    @MainActor
    @Test("does not recover if user message follows permission_request")
    func noRecoverAfterUserMessage() {
        let (service, _) = Self.makeSUT()
        let messages = [
            Message(type: .permissionRequest, tool: "Bash"),
            Message(type: .user, content: "y"),
        ]
        service.recoverFromHistory(messages, sessionStatus: .waiting)
        #expect(service.currentPrompt == nil)
    }

    @MainActor
    @Test("recovered prompts are marked stale")
    func recoveredPromptsAreStale() {
        let (service, _) = Self.makeSUT()
        let messages = [
            Message(type: .permissionRequest, tool: "Bash"),
        ]
        service.recoverFromHistory(messages, sessionStatus: .waiting)
        #expect(service.currentPrompt != nil)
        #expect(service.currentPrompt?.isStale == true)
    }

    // MARK: - Response Actions

    @MainActor
    @Test("respondPermission allow sends 'y' inject")
    func respondAllow() {
        let (service, capture) = Self.makeSUT()
        // Set up a prompt first
        let questions = [QuestionData(question: "test")]
        service.handleClaudeOutput(ClaudeOutputData(type: "ask_user_question", questions: questions))

        service.respondPermission(.allow)
        #expect(capture.actions.count == 1)
        if case .inject(let command, let sessionId) = capture.actions[0] {
            #expect(command == "y")
            #expect(sessionId == "test-session")
        } else {
            Issue.record("Expected inject action")
        }
        #expect(service.currentPrompt == nil)
    }

    @MainActor
    @Test("respondPermission deny sends 'n' inject")
    func respondDeny() {
        let (service, capture) = Self.makeSUT()
        service.respondPermission(.deny)
        #expect(capture.actions.count == 1)
        if case .inject(let command, _) = capture.actions[0] {
            #expect(command == "n")
        } else {
            Issue.record("Expected inject action")
        }
    }

    @MainActor
    @Test("respondPermission allowAlways sends 'always' inject")
    func respondAllowAlways() {
        let (service, capture) = Self.makeSUT()
        service.respondPermission(.allowAlways)
        #expect(capture.actions.count == 1)
        if case .inject(let command, _) = capture.actions[0] {
            #expect(command == "always")
        } else {
            Issue.record("Expected inject action")
        }
    }

    @MainActor
    @Test("respond text sends inject and dismisses prompt")
    func respondText() {
        let (service, capture) = Self.makeSUT()
        let questions = [QuestionData(question: "test")]
        service.handleClaudeOutput(ClaudeOutputData(type: "ask_user_question", questions: questions))
        #expect(service.currentPrompt != nil)

        service.respond(text: "my answer")
        #expect(capture.actions.count == 1)
        if case .inject(let command, _) = capture.actions[0] {
            #expect(command == "my answer")
        } else {
            Issue.record("Expected inject action")
        }
        #expect(service.currentPrompt == nil)
    }

    @MainActor
    @Test("respondMultiSelect sends each selection with delay then empty submit")
    func respondMultiSelect() async throws {
        let (service, capture) = Self.makeSUT()
        service.respondMultiSelect(["A", "B", "C"])

        // Wait for all injections to complete (3 * 1s + buffer)
        try await Task.sleep(for: .seconds(3.5))

        // Should have 4 actions: A, B, C, ""
        #expect(capture.actions.count == 4)
        let commands = capture.actions.compactMap { action -> String? in
            if case .inject(let cmd, _) = action { return cmd }
            return nil
        }
        #expect(commands == ["A", "B", "C", ""])
    }

    @MainActor
    @Test("multi-select task cancelled on dismiss")
    func multiSelectCancelledOnDismiss() async throws {
        let (service, capture) = Self.makeSUT()
        service.respondMultiSelect(["A", "B", "C", "D", "E"])

        // Wait a bit then dismiss (should cancel remaining injections)
        try await Task.sleep(for: .milliseconds(500))
        service.dismiss()

        // Wait for what would have been the full injection time
        try await Task.sleep(for: .seconds(5))

        // Should have fewer than 6 actions (5 selections + 1 empty submit)
        // because dismiss cancelled the task
        #expect(capture.actions.count < 6)
    }

    @MainActor
    @Test("dismiss clears current prompt")
    func dismissClearsPrompt() {
        let (service, _) = Self.makeSUT()
        let questions = [QuestionData(question: "test")]
        service.handleClaudeOutput(ClaudeOutputData(type: "ask_user_question", questions: questions))
        #expect(service.currentPrompt != nil)

        service.dismiss()
        #expect(service.currentPrompt == nil)
    }

    @MainActor
    @Test("no action sent when sessionId is nil")
    func noActionWithoutSessionId() {
        let capture = ActionCapture()
        let service = PromptService()
        service.setSendHandler { action in
            capture.actions.append(action)
        }
        // sessionId is nil
        service.respond(text: "hello")
        #expect(capture.actions.isEmpty)
    }

    // MARK: - Permission content extraction

    @MainActor
    @Test("permission_request extracts command from content field")
    func permissionCommandFromContent() async throws {
        let (service, _) = Self.makeSUT()
        let data = ClaudeOutputData(type: "permission_request", content: "git status", tool: "Bash")
        service.handleClaudeOutput(data)
        try await Task.sleep(for: .milliseconds(600))

        if case .permission(_, let command, _) = service.currentPrompt?.kind {
            #expect(command == "git status")
        } else {
            Issue.record("Expected permission prompt with command")
        }
    }

    @MainActor
    @Test("permission_request extracts command from input field")
    func permissionCommandFromInput() async throws {
        let (service, _) = Self.makeSUT()
        let data = ClaudeOutputData(type: "permission_request", tool: "Bash", input: ["command": .string("npm test")])
        service.handleClaudeOutput(data)
        try await Task.sleep(for: .milliseconds(600))

        if case .permission(_, let command, _) = service.currentPrompt?.kind {
            #expect(command == "npm test")
        } else {
            Issue.record("Expected permission prompt with command")
        }
    }

    // MARK: - Queue Behavior

    @MainActor
    @Test("concurrent permissions queue instead of overwriting")
    func concurrentPermissionsQueue() async throws {
        let (service, _) = Self.makeSUT()
        // Send 3 permission requests rapidly
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-1"))
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Write", toolUseId: "tu-2"))
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Edit", toolUseId: "tu-3"))

        // Wait for all 500ms delays to fire
        try await Task.sleep(for: .milliseconds(700))

        // All 3 should be in the queue
        #expect(service.promptQueue.count == 3)
        if case .permission(let tool, _, _) = service.promptQueue[0].kind {
            #expect(tool == "Bash")
        }
        if case .permission(let tool, _, _) = service.promptQueue[1].kind {
            #expect(tool == "Write")
        }
        if case .permission(let tool, _, _) = service.promptQueue[2].kind {
            #expect(tool == "Edit")
        }
    }

    @MainActor
    @Test("tool_result dismisses correct queue item by toolUseId")
    func toolResultDismissesCorrectItem() async throws {
        let (service, _) = Self.makeSUT()
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-1"))
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Write", toolUseId: "tu-2"))
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Edit", toolUseId: "tu-3"))
        try await Task.sleep(for: .milliseconds(700))
        #expect(service.promptQueue.count == 3)

        // Dismiss the middle one (Write)
        service.handleClaudeOutput(ClaudeOutputData(type: "tool_result", toolUseId: "tu-2"))
        #expect(service.promptQueue.count == 2)
        // Bash and Edit should remain
        #expect(service.promptQueue[0].toolUseId == "tu-1")
        #expect(service.promptQueue[1].toolUseId == "tu-3")
    }

    @MainActor
    @Test("Allow Always cascade removes matching tool permissions")
    func allowAlwaysCascade() async throws {
        let (service, _) = Self.makeSUT()
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-1"))
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-2"))
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Write", toolUseId: "tu-3"))
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-4"))
        try await Task.sleep(for: .milliseconds(700))
        #expect(service.promptQueue.count == 4)

        // Allow Always on head (Bash tu-1) — should cascade and remove tu-2 and tu-4
        service.respondPermission(.allowAlways)
        // Only Write (tu-3) should remain
        #expect(service.promptQueue.count == 1)
        #expect(service.promptQueue[0].toolUseId == "tu-3")
    }

    @MainActor
    @Test("clearQueue removes all prompts")
    func clearQueueRemovesAll() async throws {
        let (service, _) = Self.makeSUT()
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-1"))
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Write", toolUseId: "tu-2"))
        try await Task.sleep(for: .milliseconds(700))
        #expect(service.promptQueue.count == 2)

        service.clearQueue()
        #expect(service.promptQueue.isEmpty)
        #expect(service.currentPrompt == nil)
    }

    @MainActor
    @Test("session_status processing clears entire queue")
    func processingClearsQueue() async throws {
        let (service, _) = Self.makeSUT()
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-1"))
        let questions = [QuestionData(question: "Pick?")]
        service.handleClaudeOutput(ClaudeOutputData(type: "ask_user_question", questions: questions))
        try await Task.sleep(for: .milliseconds(700))
        #expect(service.promptQueue.count == 2)

        service.handleSessionStatus(.processing)
        #expect(service.promptQueue.isEmpty)
    }

    @MainActor
    @Test("dismiss removes head, next item becomes currentPrompt")
    func dismissRemovesHead() async throws {
        let (service, _) = Self.makeSUT()
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-1"))
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Write", toolUseId: "tu-2"))
        try await Task.sleep(for: .milliseconds(700))
        #expect(service.promptQueue.count == 2)

        service.dismiss()
        #expect(service.promptQueue.count == 1)
        #expect(service.currentPrompt?.toolUseId == "tu-2")
    }

    @MainActor
    @Test("agentDescription is stored on prompt item")
    func agentDescriptionStored() async throws {
        let (service, _) = Self.makeSUT()
        let data = ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-1")
        service.handleClaudeOutput(data, agentDescription: "Security review")
        try await Task.sleep(for: .milliseconds(700))
        #expect(service.currentPrompt?.agentDescription == "Security review")
    }

    @MainActor
    @Test("tool_result suppresses pending and does not affect other queue items")
    func toolResultSuppressesPendingOnly() async throws {
        let (service, _) = Self.makeSUT()
        // First permission enters queue
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-1"))
        try await Task.sleep(for: .milliseconds(700))
        #expect(service.promptQueue.count == 1)

        // Second permission starts 500ms delay
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Write", toolUseId: "tu-2"))

        // tool_result for the pending one arrives within 500ms
        service.handleClaudeOutput(ClaudeOutputData(type: "tool_result", toolUseId: "tu-2"))

        try await Task.sleep(for: .milliseconds(700))
        // Only Bash should remain — Write was suppressed during delay
        #expect(service.promptQueue.count == 1)
        #expect(service.promptQueue[0].toolUseId == "tu-1")
    }

    @MainActor
    @Test("history recovery finds multiple unmatched permissions")
    func recoverMultiplePermissions() {
        let (service, _) = Self.makeSUT()
        let messages = [
            Message(type: .assistant, content: "Running tools..."),
            Message(type: .permissionRequest, tool: "Bash", toolUseId: "tu-1"),
            Message(type: .permissionRequest, tool: "Write", toolUseId: "tu-2"),
            Message(type: .permissionRequest, tool: "Edit", toolUseId: "tu-3"),
        ]
        service.recoverFromHistory(messages, sessionStatus: .waiting)
        #expect(service.promptQueue.count == 3)
        #expect(service.promptQueue[0].toolUseId == "tu-1")
        #expect(service.promptQueue[1].toolUseId == "tu-2")
        #expect(service.promptQueue[2].toolUseId == "tu-3")
    }

    @MainActor
    @Test("history recovery skips answered permissions")
    func recoverSkipsAnswered() {
        let (service, _) = Self.makeSUT()
        let messages = [
            Message(type: .assistant, content: "Running tools..."),
            Message(type: .permissionRequest, tool: "Bash", toolUseId: "tu-1"),
            Message(type: .toolResult, content: "done", toolUseId: "tu-1"),
            Message(type: .permissionRequest, tool: "Write", toolUseId: "tu-2"),
        ]
        service.recoverFromHistory(messages, sessionStatus: .waiting)
        // Only Write should be recovered (Bash was answered)
        #expect(service.promptQueue.count == 1)
        #expect(service.promptQueue[0].toolUseId == "tu-2")
    }

    // MARK: - History Recovery (Forward Scan)

    @MainActor
    @Test("recovery clears existing queue before recovering")
    func recoveryClearsExistingQueue() {
        let (service, _) = Self.makeSUT()
        // Pre-populate the queue with an existing prompt
        let existingQ = [QuestionData(question: "Old question")]
        service.handleClaudeOutput(ClaudeOutputData(type: "ask_user_question", questions: existingQ))
        #expect(service.promptQueue.count == 1)

        // Now recover from history — old prompt should be gone
        let messages = [
            Message(type: .permissionRequest, tool: "Bash", toolUseId: "tu-1"),
        ]
        service.recoverFromHistory(messages, sessionStatus: .waiting)
        #expect(service.promptQueue.count == 1)
        // Should be the recovered permission, not the old question
        if case .permission(let tool, _, _) = service.currentPrompt?.kind {
            #expect(tool == "Bash")
        } else {
            Issue.record("Expected recovered permission, not old question")
        }
    }

    @MainActor
    @Test("recovers multiple questions past user messages")
    func recoverMultipleQuestionsPastUserMessages() {
        let (service, _) = Self.makeSUT()
        let q1 = [QuestionData(question: "Q1?")]
        let q2 = [QuestionData(question: "Q2?")]
        let q3 = [QuestionData(question: "Q3?")]
        let messages = [
            Message(type: .askUserQuestion, questions: q1),
            Message(type: .user, content: "answer to Q1"),    // answers Q1
            Message(type: .askUserQuestion, questions: q2),
            Message(type: .askUserQuestion, questions: q3),
        ]
        service.recoverFromHistory(messages, sessionStatus: .waiting)
        // Q1 answered, Q2 and Q3 unanswered
        #expect(service.promptQueue.count == 2)
        if case .question(let qs) = service.promptQueue[0].kind {
            #expect(qs[0].question == "Q2?")
        } else {
            Issue.record("Expected Q2")
        }
        if case .question(let qs) = service.promptQueue[1].kind {
            #expect(qs[0].question == "Q3?")
        } else {
            Issue.record("Expected Q3")
        }
    }

    @MainActor
    @Test("answered question not recovered")
    func answeredQuestionNotRecovered() {
        let (service, _) = Self.makeSUT()
        let q = [QuestionData(question: "Pick?")]
        let messages = [
            Message(type: .askUserQuestion, questions: q),
            Message(type: .user, content: "my answer"),
        ]
        service.recoverFromHistory(messages, sessionStatus: .waiting)
        #expect(service.promptQueue.isEmpty)
    }

    @MainActor
    @Test("recoverFromHistory is idempotent — no duplicates on re-call")
    func recoverIdempotent() {
        let (service, _) = Self.makeSUT()
        let messages = [
            Message(type: .permissionRequest, tool: "Bash", toolUseId: "tu-1"),
            Message(type: .askUserQuestion, questions: [QuestionData(question: "Q?")]),
        ]
        service.recoverFromHistory(messages, sessionStatus: .waiting)
        #expect(service.promptQueue.count == 2)

        // Call again with same data — should still have exactly 2, not 4
        service.recoverFromHistory(messages, sessionStatus: .waiting)
        #expect(service.promptQueue.count == 2)
    }

    @MainActor
    @Test("Allow Always cascade also cancels pending permissions")
    func allowAlwaysCascadePending() async throws {
        let (service, _) = Self.makeSUT()
        // One in queue
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-1"))
        try await Task.sleep(for: .milliseconds(700))

        // Another Bash in pending (not yet in queue)
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-2"))

        // Allow Always on head
        service.respondPermission(.allowAlways)

        // Wait for any pending to fire
        try await Task.sleep(for: .milliseconds(700))

        // Queue should be empty — tu-2 was cancelled from pending
        #expect(service.promptQueue.isEmpty)
    }

    // MARK: - Regression: Double-Dismissal (Issue #8)

    @MainActor
    @Test("tool_result for already-dismissed permission does not remove other queue items")
    func toolResultForDismissedDoesNotAffectQueue() async throws {
        let (service, _) = Self.makeSUT()
        // Queue 3 permissions
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-1"))
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Write", toolUseId: "tu-2"))
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Edit", toolUseId: "tu-3"))
        try await Task.sleep(for: .milliseconds(700))
        #expect(service.promptQueue.count == 3)

        // User dismisses head (tu-1)
        service.dismiss()
        #expect(service.promptQueue.count == 2)
        #expect(service.promptQueue[0].toolUseId == "tu-2")

        // tool_result arrives for tu-1 (already dismissed by user)
        service.handleClaudeOutput(ClaudeOutputData(type: "tool_result", toolUseId: "tu-1"))

        // tu-2 and tu-3 must still be in the queue — not affected
        #expect(service.promptQueue.count == 2)
        #expect(service.promptQueue[0].toolUseId == "tu-2")
        #expect(service.promptQueue[1].toolUseId == "tu-3")
    }

    @MainActor
    @Test("tool_result for never-queued permission does not remove queue items")
    func toolResultForUnknownDoesNotAffectQueue() async throws {
        let (service, _) = Self.makeSUT()
        // Queue 2 permissions
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-1"))
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Write", toolUseId: "tu-2"))
        try await Task.sleep(for: .milliseconds(700))
        #expect(service.promptQueue.count == 2)

        // tool_result for a toolUseId that was never queued (auto-approved server-side)
        service.handleClaudeOutput(ClaudeOutputData(type: "tool_result", toolUseId: "tu-unknown"))

        // Queue must be unaffected
        #expect(service.promptQueue.count == 2)
        #expect(service.promptQueue[0].toolUseId == "tu-1")
        #expect(service.promptQueue[1].toolUseId == "tu-2")
    }

    // MARK: - Plan Exit Handling

    @MainActor
    @Test("exit_plan_mode creates planExit prompt immediately")
    func exitPlanModeShowsImmediately() {
        let (service, _) = Self.makeSUT()
        service.handleClaudeOutput(ClaudeOutputData(type: "exit_plan_mode"))

        #expect(service.currentPrompt != nil)
        #expect(service.promptQueue.count == 1)
        if case .planExit = service.currentPrompt?.kind {
            // Expected
        } else {
            Issue.record("Expected planExit prompt")
        }
    }

    @MainActor
    @Test("respondPlanExit acceptPreserveContext sends selectOption index 1")
    func respondPlanExitPreserveContext() {
        let (service, capture) = Self.makeSUT()
        service.handleClaudeOutput(ClaudeOutputData(type: "exit_plan_mode"))
        #expect(service.currentPrompt != nil)

        service.respondPlanExit(.acceptPreserveContext)
        #expect(capture.actions.count == 1)
        if case .selectOption(let index, let sessionId) = capture.actions[0] {
            #expect(index == 1) // Option 2 is 0-indexed as 1
            #expect(sessionId == "test-session")
        } else {
            Issue.record("Expected selectOption action")
        }
        #expect(service.currentPrompt == nil)
    }

    @MainActor
    @Test("respondPlanExit acceptClearContext sends selectOption index 0")
    func respondPlanExitClearContext() {
        let (service, capture) = Self.makeSUT()
        service.handleClaudeOutput(ClaudeOutputData(type: "exit_plan_mode"))

        service.respondPlanExit(.acceptClearContext)
        #expect(capture.actions.count == 1)
        if case .selectOption(let index, _) = capture.actions[0] {
            #expect(index == 0) // Option 1 is 0-indexed as 0
        } else {
            Issue.record("Expected selectOption action")
        }
    }

    @MainActor
    @Test("respondPlanExit manualApprove sends selectOption index 2")
    func respondPlanExitManualApprove() {
        let (service, capture) = Self.makeSUT()
        service.handleClaudeOutput(ClaudeOutputData(type: "exit_plan_mode"))

        service.respondPlanExit(.manualApprove)
        #expect(capture.actions.count == 1)
        if case .selectOption(let index, _) = capture.actions[0] {
            #expect(index == 2) // Option 3 is 0-indexed as 2
        } else {
            Issue.record("Expected selectOption action")
        }
    }

    @MainActor
    @Test("respondPlanExit requestChanges sends selectOption then inject")
    func respondPlanExitRequestChanges() async throws {
        let (service, capture) = Self.makeSUT()
        service.handleClaudeOutput(ClaudeOutputData(type: "exit_plan_mode"))

        service.respondPlanExit(.requestChanges("fix the bug"))
        // First action is selectOption
        #expect(capture.actions.count >= 1)
        if case .selectOption(let index, _) = capture.actions[0] {
            #expect(index == 3) // Option 4 is 0-indexed as 3
        } else {
            Issue.record("Expected selectOption action first")
        }

        // Wait for delayed inject
        try await Task.sleep(for: .milliseconds(400))
        #expect(capture.actions.count == 2)
        if case .inject(let command, _) = capture.actions[1] {
            #expect(command == "fix the bug")
        } else {
            Issue.record("Expected inject action second")
        }
    }

    @MainActor
    @Test("planExit prompt can queue alongside permission prompts")
    func planExitQueuesWithPermissions() async throws {
        let (service, _) = Self.makeSUT()

        // First add a permission
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-1"))
        try await Task.sleep(for: .milliseconds(600)) // Wait for delay
        #expect(service.promptQueue.count == 1)

        // Then add a planExit
        service.handleClaudeOutput(ClaudeOutputData(type: "exit_plan_mode"))
        #expect(service.promptQueue.count == 2)

        // Permission is head, planExit is second
        if case .permission = service.promptQueue[0].kind {
            // Expected
        } else {
            Issue.record("Expected permission as head")
        }
        if case .planExit = service.promptQueue[1].kind {
            // Expected
        } else {
            Issue.record("Expected planExit as second")
        }
    }
}

// MARK: - Test Helpers

/// Captures ClientAction calls for test verification
@MainActor
private final class ActionCapture {
    var actions: [ClientAction] = []
}
