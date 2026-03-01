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
    @Test("session_status processing preserves prompt queue (multi-agent safe)")
    func processingPreservesPrompts() async throws {
        let (service, _) = Self.makeSUT()
        let questions = [QuestionData(question: "Pick?")]
        service.handleClaudeOutput(ClaudeOutputData(type: "ask_user_question", questions: questions))
        #expect(service.currentPrompt != nil)

        // In multi-agent mode, one agent processing should not nuke other agents' prompts
        service.handleSessionStatus(.processing)
        #expect(service.currentPrompt != nil, "Processing should not clear prompts")
        #expect(!service.promptQueue.isEmpty, "Queue should be preserved")
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
    @Test("single recovered prompt is NOT marked stale (it's the current prompt)")
    func recoveredSinglePromptNotStale() {
        let (service, _) = Self.makeSUT()
        let messages = [
            Message(type: .permissionRequest, tool: "Bash"),
        ]
        service.recoverFromHistory(messages, sessionStatus: .waiting)
        #expect(service.currentPrompt != nil)
        // Single recovered prompt is the current one — not stale
        #expect(service.currentPrompt?.isStale == false)
    }

    // MARK: - Response Actions

    @MainActor
    @Test("respondOther uses selectOther to navigate ink selector then inject freetext")
    func respondOtherInjectsDirectly() async throws {
        let (service, capture) = Self.makeSUT()
        let questions = [QuestionData(question: "Pick?", options: [
            QuestionOption(label: "A"),
            QuestionOption(label: "B"),
            QuestionOption(label: "C"),
        ])]
        service.handleClaudeOutput(ClaudeOutputData(type: "ask_user_question", questions: questions))
        #expect(service.currentPrompt != nil)

        service.respondOther(optionCount: 3, text: "my custom answer")

        // selectOther navigates ink selector to "Other" via arrow keys, waits 600ms for
        // ink to transition to TextInput mode, then injects the freeform text.
        // Claude Code's ink-based selector ignores typed text — only arrow keys work.
        #expect(capture.actions.count == 1)
        if case .selectOther(let index, let text, let sessionId) = capture.actions[0] {
            #expect(index == 3)
            #expect(text == "my custom answer")
            #expect(sessionId == "test-session")
        } else {
            Issue.record("Expected selectOther action, got: \(capture.actions[0])")
        }
        #expect(service.currentPrompt == nil, "Prompt should be dismissed")
    }

    @MainActor
    @Test("respondPermission allow sends 'y' inject")
    func respondAllow() {
        let (service, capture) = Self.makeSUT()
        // Set up a prompt first
        let questions = [QuestionData(question: "test")]
        service.handleClaudeOutput(ClaudeOutputData(type: "ask_user_question", questions: questions))

        service.respondPermission(.allow)
        #expect(capture.actions.count == 1)
        if case .inject(let command, let sessionId, _) = capture.actions[0] {
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
        if case .inject(let command, _, _) = capture.actions[0] {
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
        if case .inject(let command, _, _) = capture.actions[0] {
            #expect(command == "always")
        } else {
            Issue.record("Expected inject action")
        }
    }

    @MainActor
    @Test("respondPermission allowAlways passes toolUseId from head prompt")
    func respondAllowAlwaysPassesToolUseId() async throws {
        let (service, capture) = Self.makeSUT()
        // Enqueue a permission with a specific toolUseId
        let data = ClaudeOutputData(
            type: "permission_request",
            tool: "Bash",
            input: ["command": .string("ls")],
            toolUseId: "toolu_abc123"
        )
        service.handleClaudeOutput(data)
        // Wait for coalescing flush
        try await Task.sleep(for: .milliseconds(700))
        #expect(service.currentPrompt != nil)
        #expect(service.currentPrompt?.toolUseId == "toolu_abc123")

        service.respondPermission(.allowAlways)
        #expect(capture.actions.count == 1)
        if case .inject(let command, let sessionId, let toolUseId) = capture.actions[0] {
            #expect(command == "always")
            #expect(sessionId == "test-session")
            #expect(toolUseId == "toolu_abc123")
        } else {
            Issue.record("Expected inject action with toolUseId")
        }
    }

    @MainActor
    @Test("respondPermission allow does not pass toolUseId")
    func respondAllowDoesNotPassToolUseId() async throws {
        let (service, capture) = Self.makeSUT()
        let data = ClaudeOutputData(
            type: "permission_request",
            tool: "Write",
            input: ["file_path": .string("/tmp/test.txt")],
            toolUseId: "toolu_xyz789"
        )
        service.handleClaudeOutput(data)
        try await Task.sleep(for: .milliseconds(700))
        #expect(service.currentPrompt != nil)

        service.respondPermission(.allow)
        #expect(capture.actions.count == 1)
        if case .inject(let command, _, let toolUseId) = capture.actions[0] {
            #expect(command == "y")
            // "allow" should not pass toolUseId (only "always" needs it)
            #expect(toolUseId == nil)
        } else {
            Issue.record("Expected inject action")
        }
    }

    @MainActor
    @Test("cross-tool isolation: Always Allow Bash does not affect Write permissions")
    func crossToolIsolation() async throws {
        let (service, capture) = Self.makeSUT()
        // Queue Bash permission
        service.handleClaudeOutput(ClaudeOutputData(
            type: "permission_request",
            tool: "Bash",
            input: ["command": .string("ls")],
            toolUseId: "toolu_bash1"
        ))
        // Queue Write permission
        service.handleClaudeOutput(ClaudeOutputData(
            type: "permission_request",
            tool: "Write",
            input: ["file_path": .string("/tmp/test.txt")],
            toolUseId: "toolu_write1"
        ))
        // Wait for coalescing flush
        try await Task.sleep(for: .milliseconds(700))
        #expect(service.promptQueue.count == 2)

        // Always Allow Bash (head prompt)
        service.respondPermission(.allowAlways)
        #expect(capture.actions.count == 1)
        if case .inject(let command, _, let toolUseId) = capture.actions[0] {
            #expect(command == "always")
            #expect(toolUseId == "toolu_bash1")
        } else {
            Issue.record("Expected inject action with Bash toolUseId")
        }

        // Write permission should still be in queue (cascade only removes same-tool)
        #expect(service.promptQueue.count == 1)
        if case .permission(let tool, _, _) = service.currentPrompt?.kind {
            #expect(tool == "Write")
        } else {
            Issue.record("Expected Write permission to remain in queue")
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
        if case .inject(let command, _, _) = capture.actions[0] {
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
            if case .inject(let cmd, _, _) = action { return cmd }
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
    @Test("dismiss minimizes prompt without sending anything to server")
    func dismissMinimizes() {
        let (service, capture) = Self.makeSUT()
        // Use ask_user_question (appears immediately, no coalesce delay)
        service.handleClaudeOutput(ClaudeOutputData(
            type: "ask_user_question",
            questions: [QuestionData(question: "Pick?")]
        ))
        #expect(service.promptQueue.count == 1)
        #expect(service.minimizedPrompts.isEmpty)

        service.dismiss()

        // Should NOT send anything to server
        #expect(capture.actions.isEmpty)
        // Prompt moved to minimized, not deleted
        #expect(service.promptQueue.isEmpty)
        #expect(service.minimizedPrompts.count == 1)
    }

    @MainActor
    @Test("dismiss does not send 'n' for permission prompts")
    func dismissPermissionNoReject() async throws {
        let (service, capture) = Self.makeSUT()
        service.handleClaudeOutput(ClaudeOutputData(
            type: "permission_request", content: "ls",
            tool: "Bash", toolUseId: "tu-1"
        ))
        try await Task.sleep(for: .milliseconds(600))
        #expect(service.promptQueue.count == 1)

        service.dismiss()

        // Must NOT send "n" — dismiss only hides, doesn't reject
        #expect(capture.actions.isEmpty)
        #expect(service.minimizedPrompts.count == 1)
        #expect(service.minimizedPrompts.first?.toolUseId == "tu-1")
    }

    @MainActor
    @Test("restoreMinimized moves prompts back to queue")
    func restoreMinimized() {
        let (service, _) = Self.makeSUT()
        service.handleClaudeOutput(ClaudeOutputData(
            type: "ask_user_question",
            questions: [QuestionData(question: "Pick?")]
        ))
        service.dismiss()
        #expect(service.promptQueue.isEmpty)
        #expect(service.minimizedPrompts.count == 1)

        service.restoreMinimized()
        #expect(service.promptQueue.count == 1)
        #expect(service.minimizedPrompts.isEmpty)
    }

    @MainActor
    @Test("permission_resolved cleans up minimized prompts")
    func permissionResolvedCleansMinimized() async throws {
        let (service, _) = Self.makeSUT()
        service.handleClaudeOutput(ClaudeOutputData(
            type: "permission_request", content: "file.txt",
            tool: "Read", toolUseId: "tu-2"
        ))
        try await Task.sleep(for: .milliseconds(600))
        service.dismiss()
        #expect(service.minimizedPrompts.count == 1)

        service.handlePermissionResolved(toolUseId: "tu-2")
        #expect(service.minimizedPrompts.isEmpty)
    }

    @MainActor
    @Test("clearQueue also clears minimized prompts")
    func clearQueueClearsMinimized() {
        let (service, _) = Self.makeSUT()
        service.handleClaudeOutput(ClaudeOutputData(
            type: "ask_user_question",
            questions: [QuestionData(question: "Pick?")]
        ))
        service.dismiss()
        #expect(service.minimizedPrompts.count == 1)

        service.clearQueue()
        #expect(service.minimizedPrompts.isEmpty)
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
    @Test("session_status processing does NOT clear queue (multi-agent safe)")
    func processingDoesNotClearQueue() async throws {
        let (service, _) = Self.makeSUT()
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-1"))
        let questions = [QuestionData(question: "Pick?")]
        service.handleClaudeOutput(ClaudeOutputData(type: "ask_user_question", questions: questions))
        try await Task.sleep(for: .milliseconds(700))
        #expect(service.promptQueue.count == 2)

        // In multi-agent mode, one agent processing doesn't mean others are done.
        // Queue should remain intact — prompts are dismissed individually by tool_result.
        service.handleSessionStatus(.processing)
        #expect(service.promptQueue.count == 2)
    }

    @MainActor
    @Test("session_status processing marks questions stale but NOT permissions")
    func processingMarksQuestionsStaleNotPermissions() async throws {
        let (service, _) = Self.makeSUT()
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "WebFetch", toolUseId: "tu-1"))
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "WebFetch", toolUseId: "tu-2"))
        let questions = [QuestionData(question: "Pick?")]
        service.handleClaudeOutput(ClaudeOutputData(type: "ask_user_question", questions: questions))
        try await Task.sleep(for: .milliseconds(700))
        #expect(service.promptQueue.count == 3)

        service.handleSessionStatus(.processing)
        #expect(service.promptQueue.count == 3, "All items should remain in queue")

        // Permissions should NOT be marked stale (Claude still needs approval)
        let permissions = service.promptQueue.filter { if case .permission = $0.kind { return true }; return false }
        #expect(permissions.allSatisfy { !$0.isStale }, "Permissions should not be marked stale on processing")

        // Questions SHOULD be marked stale (Claude moved past them)
        let questions2 = service.promptQueue.filter { if case .question = $0.kind { return true }; return false }
        #expect(questions2.allSatisfy { $0.isStale }, "Questions should be marked stale on processing")
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
    @Test("history recovery recovers only the last unmatched permission")
    func recoverLastPermission() {
        let (service, _) = Self.makeSUT()
        let messages = [
            Message(type: .assistant, content: "Running tools..."),
            Message(type: .permissionRequest, tool: "Bash", toolUseId: "tu-1"),
            Message(type: .permissionRequest, tool: "Write", toolUseId: "tu-2"),
            Message(type: .permissionRequest, tool: "Edit", toolUseId: "tu-3"),
        ]
        service.recoverFromHistory(messages, sessionStatus: .waiting)
        // Only the LAST unanswered permission is recovered
        #expect(service.promptQueue.count == 1)
        #expect(service.promptQueue[0].toolUseId == "tu-3")
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
    @Test("recovers only the last unanswered question")
    func recoverLastUnansweredQuestion() {
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
        // Only the LAST unanswered question is recovered (Q3)
        #expect(service.promptQueue.count == 1)
        if case .question(let qs) = service.promptQueue[0].kind {
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
        // Only recovers the LAST unanswered prompt (Q?)
        #expect(service.promptQueue.count == 1)

        // Call again with same data — should still have exactly 1, not 2
        service.recoverFromHistory(messages, sessionStatus: .waiting)
        #expect(service.promptQueue.count == 1)
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

    @MainActor
    @Test("Allow Always cascade persists tool to allowedTools, skipping future requests")
    func allowAlwaysPersistsToAllowedTools() async throws {
        let (service, _) = Self.makeSUT()
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-1"))
        try await Task.sleep(for: .milliseconds(700))
        #expect(service.promptQueue.count == 1)

        // Allow Always on Bash
        service.respondPermission(.allowAlways)
        #expect(service.promptQueue.isEmpty)

        // New Bash permission arrives — should be auto-skipped (no prompt)
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-2"))
        try await Task.sleep(for: .milliseconds(700))
        #expect(service.promptQueue.isEmpty, "Future Bash requests should be auto-skipped after Allow Always")

        // Different tool still shows prompt
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Write", toolUseId: "tu-3"))
        try await Task.sleep(for: .milliseconds(700))
        #expect(service.promptQueue.count == 1, "Non-Bash tools should still prompt")
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

    // MARK: - Approve All

    @MainActor
    @Test("approveAll sends always for head and clears all permissions")
    func approveAllClearsAllPermissions() async throws {
        let (service, capture) = Self.makeSUT()
        // Queue 3 mixed-tool permissions
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-1"))
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Write", toolUseId: "tu-2"))
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Read", toolUseId: "tu-3"))
        try await Task.sleep(for: .milliseconds(700))
        #expect(service.promptQueue.count == 3)

        service.approveAll()

        // Should have sent "always" for each permission (head + 2 remaining)
        #expect(capture.actions.count == 3)
        // First action: head permission (tu-1)
        if case .inject(let command, let sessionId, let toolUseId) = capture.actions[0] {
            #expect(command == "always")
            #expect(sessionId == "test-session")
            #expect(toolUseId == "tu-1")
        } else {
            Issue.record("Expected inject action with head toolUseId")
        }
        // Remaining actions: one inject per queued permission (tu-2, tu-3)
        let remainingToolUseIds = capture.actions.dropFirst().compactMap { action -> String? in
            if case .inject(let command, _, let toolUseId) = action {
                #expect(command == "always")
                return toolUseId
            }
            return nil
        }
        #expect(Set(remainingToolUseIds) == Set(["tu-2", "tu-3"]))
        // Queue should be completely empty
        #expect(service.promptQueue.isEmpty)
    }

    @MainActor
    @Test("approveAll preserves non-permission prompts")
    func approveAllPreservesNonPermissions() async throws {
        let (service, _) = Self.makeSUT()
        // Queue permission, then question
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-1"))
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Write", toolUseId: "tu-2"))
        try await Task.sleep(for: .milliseconds(700))
        let questions = [QuestionData(question: "Pick?")]
        service.handleClaudeOutput(ClaudeOutputData(type: "ask_user_question", questions: questions))
        #expect(service.promptQueue.count == 3)

        service.approveAll()

        // Only the question should remain
        #expect(service.promptQueue.count == 1)
        if case .question(let qs) = service.currentPrompt?.kind {
            #expect(qs[0].question == "Pick?")
        } else {
            Issue.record("Expected question prompt to survive approveAll")
        }
    }

    @MainActor
    @Test("approveAll clears pending permissions not yet flushed")
    func approveAllClearsPendingPermissions() async throws {
        let (service, _) = Self.makeSUT()
        // One permission in queue
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-1"))
        try await Task.sleep(for: .milliseconds(700))
        #expect(service.promptQueue.count == 1)

        // Another still pending (not flushed yet)
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Write", toolUseId: "tu-2"))

        service.approveAll()

        // Wait for any pending flush
        try await Task.sleep(for: .milliseconds(700))

        // Queue should be empty — pending was cleared
        #expect(service.promptQueue.isEmpty)
    }

    @MainActor
    @Test("approveAll no-ops when head is not a permission")
    func approveAllNoOpsForNonPermission() {
        let (service, capture) = Self.makeSUT()
        // Queue a question as head
        let questions = [QuestionData(question: "Pick?")]
        service.handleClaudeOutput(ClaudeOutputData(type: "ask_user_question", questions: questions))
        #expect(service.currentPrompt != nil)

        service.approveAll()

        // No actions should have been sent
        #expect(capture.actions.isEmpty)
        // Question should still be in queue
        #expect(service.promptQueue.count == 1)
        if case .question = service.currentPrompt?.kind {
            // Expected
        } else {
            Issue.record("Expected question to remain unchanged")
        }
    }

    // MARK: - Always Allowed Tools (local grant persistence)

    @MainActor
    @Test("alwaysAllowedTools survives claudeState update")
    func alwaysAllowedToolsSurvivesClaudeState() async throws {
        let (service, _) = Self.makeSUT()

        // Grant Bash via Allow Always
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-1"))
        try await Task.sleep(for: .milliseconds(700))
        service.respondPermission(.allowAlways)

        // Simulate claudeState update that does NOT include Bash
        // (e.g. stale 30s sync before server records the grant)
        service.updateAllowedTools(ClaudeState.Permissions(allowedTools: ["Read"], sessionGranted: nil, mode: nil))

        // New Bash permission should still be auto-skipped via alwaysAllowedTools
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-2"))
        try await Task.sleep(for: .milliseconds(700))
        #expect(service.promptQueue.isEmpty, "Bash should remain auto-approved via alwaysAllowedTools after claudeState update")
    }

    @MainActor
    @Test("updateAllowedTools revocation removes from alwaysAllowedTools")
    func updateAllowedToolsRevocation() async throws {
        let (service, _) = Self.makeSUT()

        // First, set Bash as allowed via claudeState
        service.updateAllowedTools(ClaudeState.Permissions(allowedTools: ["Bash"], sessionGranted: nil, mode: nil))

        // Grant Bash locally via Allow Always
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-1"))
        try await Task.sleep(for: .milliseconds(700))
        service.respondPermission(.allowAlways)

        // Now server revokes Bash (it was in allowedTools, now it's not)
        service.updateAllowedTools(ClaudeState.Permissions(allowedTools: nil, sessionGranted: nil, mode: nil))

        // New Bash permission should prompt (revocation removed from alwaysAllowedTools too)
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-2"))
        try await Task.sleep(for: .milliseconds(700))
        #expect(service.promptQueue.count == 1, "Bash should prompt after server revocation")
    }

    @MainActor
    @Test("clearQueue clears alwaysAllowedTools")
    func clearQueueClearsAlwaysAllowed() async throws {
        let (service, _) = Self.makeSUT()

        // Grant Bash via Allow Always
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-1"))
        try await Task.sleep(for: .milliseconds(700))
        service.respondPermission(.allowAlways)

        // Clear queue (simulates session disconnect)
        service.clearQueue()

        // New Bash permission should prompt (alwaysAllowedTools cleared)
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-2"))
        try await Task.sleep(for: .milliseconds(700))
        #expect(service.promptQueue.count == 1, "Bash should prompt after clearQueue")
    }

    @MainActor
    @Test("clearLocalGrants clears alwaysAllowedTools at session-start")
    func clearLocalGrantsClearsAlwaysAllowed() async throws {
        let (service, _) = Self.makeSUT()

        // Grant Bash via Allow Always
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-1"))
        try await Task.sleep(for: .milliseconds(700))
        service.respondPermission(.allowAlways)

        // Clear local grants (called at session-start)
        service.clearLocalGrants()

        // New Bash permission should prompt
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-2"))
        try await Task.sleep(for: .milliseconds(700))
        #expect(service.promptQueue.count == 1, "Bash should prompt after clearLocalGrants")
    }

    @MainActor
    @Test("cascadeAlwaysAllow adds to alwaysAllowedTools")
    func cascadeAddsToAlwaysAllowed() async throws {
        let (service, actions) = Self.makeSUT()

        // Grant Write via Allow Always
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Write", toolUseId: "tu-1"))
        try await Task.sleep(for: .milliseconds(700))
        service.respondPermission(.allowAlways)
        #expect(actions.actions.count == 1)

        // Verify Write is now auto-approved (via alwaysAllowedTools)
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Write", toolUseId: "tu-2"))
        try await Task.sleep(for: .milliseconds(700))
        #expect(service.promptQueue.isEmpty, "Write should be auto-approved after Allow Always")
        // Auto-inject should have fired
        #expect(actions.actions.count == 2)
        if case .inject(let cmd, _, _) = actions.actions[1] {
            #expect(cmd == "always")
        } else {
            Issue.record("Expected auto-inject for allowed tool")
        }
    }

    @MainActor
    @Test("MCP tool with formatted name survives updateAllowedTools with raw names")
    func mcpToolFormattedNameSurvives() async throws {
        let (service, _) = Self.makeSUT()

        // Permission arrives with formatted MCP name (as sent by server in permission_request.tool)
        service.handleClaudeOutput(ClaudeOutputData(
            type: "permission_request",
            tool: "Server: tool",
            toolUseId: "tu-1"
        ))
        try await Task.sleep(for: .milliseconds(700))
        service.respondPermission(.allowAlways)

        // claudeState update has raw MCP name in sessionGranted (not formatted name)
        service.updateAllowedTools(ClaudeState.Permissions(
            allowedTools: nil,
            sessionGranted: ["mcp__server__tool"],
            mode: nil
        ))

        // New permission with formatted name should still be auto-skipped
        // because alwaysAllowedTools stores the formatted name and claudeState
        // never had the formatted name to revoke it
        service.handleClaudeOutput(ClaudeOutputData(
            type: "permission_request",
            tool: "Server: tool",
            toolUseId: "tu-2"
        ))
        try await Task.sleep(for: .milliseconds(700))
        #expect(service.promptQueue.isEmpty, "MCP tool with formatted name should remain auto-approved")
    }

    @MainActor
    @Test("alwaysAllowedTools not affected by claudeState for tools never in allowedTools")
    func alwaysAllowedNotAffectedByUnrelatedClaudeState() async throws {
        let (service, _) = Self.makeSUT()

        // Grant Bash via Allow Always (Bash was never in server's allowedTools)
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-1"))
        try await Task.sleep(for: .milliseconds(700))
        service.respondPermission(.allowAlways)

        // Multiple claudeState updates with different tools — none include Bash
        service.updateAllowedTools(ClaudeState.Permissions(allowedTools: ["Read"], sessionGranted: nil, mode: nil))
        service.updateAllowedTools(ClaudeState.Permissions(allowedTools: ["Read", "Write"], sessionGranted: nil, mode: nil))
        service.updateAllowedTools(ClaudeState.Permissions(allowedTools: nil, sessionGranted: nil, mode: nil))

        // Bash should still be auto-approved (never was in allowedTools, so no revocation detected)
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-2"))
        try await Task.sleep(for: .milliseconds(700))
        #expect(service.promptQueue.isEmpty, "Bash should remain auto-approved across unrelated claudeState changes")
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
        if case .inject(let command, _, _) = capture.actions[1] {
            #expect(command == "fix the bug")
        } else {
            Issue.record("Expected inject action second")
        }
    }

    // MARK: - Permission Resolved

    @MainActor
    @Test("handlePermissionResolved removes matching prompt from queue")
    func permissionResolvedRemovesMatching() async throws {
        let (service, _) = Self.makeSUT()
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-1"))
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Write", toolUseId: "tu-2"))
        try await Task.sleep(for: .milliseconds(700))
        #expect(service.promptQueue.count == 2)

        service.handlePermissionResolved(toolUseId: "tu-1")
        #expect(service.promptQueue.count == 1)
        #expect(service.promptQueue[0].toolUseId == "tu-2")
    }

    @MainActor
    @Test("handlePermissionResolved with non-matching toolUseId does not remove anything")
    func permissionResolvedNonMatching() async throws {
        let (service, _) = Self.makeSUT()
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-1"))
        try await Task.sleep(for: .milliseconds(700))
        #expect(service.promptQueue.count == 1)

        service.handlePermissionResolved(toolUseId: "tu-unknown")
        #expect(service.promptQueue.count == 1)
        #expect(service.promptQueue[0].toolUseId == "tu-1")
    }

    @MainActor
    @Test("handlePermissionResolved with non-matching toolUseId does not remove pending buffer items")
    func permissionResolvedDoesNotRemovePending() async throws {
        let (service, _) = Self.makeSUT()
        // Add two permissions — tu-1 goes to pending buffer first
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-1"))
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Write", toolUseId: "tu-2"))

        // Before coalesce flush, resolve a non-existent toolUseId
        // This should NOT remove tu-1 or tu-2 from pending (the old fallback bug)
        service.handlePermissionResolved(toolUseId: "tu-nonexistent")

        // Wait for coalesce flush
        try await Task.sleep(for: .milliseconds(700))

        // Both should still be in the queue
        #expect(service.promptQueue.count == 2)
        #expect(service.promptQueue.contains { $0.toolUseId == "tu-1" })
        #expect(service.promptQueue.contains { $0.toolUseId == "tu-2" })
    }

    // MARK: - Fallback Auto-Removal

    @MainActor
    @Test("stale prompts auto-removed after 5+ messages")
    func fallbackRemovalAfterFiveMessages() async throws {
        let (service, _) = Self.makeSUT()
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-1"))
        try await Task.sleep(for: .milliseconds(700))
        #expect(service.promptQueue.count == 1)

        // Send 5 assistant messages to trigger fallback removal (marks stale after 2, removes after 5)
        for i in 0..<5 {
            service.handleClaudeOutput(ClaudeOutputData(type: "assistant", content: "msg \(i)"))
        }
        #expect(service.promptQueue.isEmpty, "Stale permission should be auto-removed after 5 messages")
    }

    @MainActor
    @Test("stale questions also auto-removed after 5+ messages")
    func staleQuestionsAutoRemoved() {
        let (service, _) = Self.makeSUT()
        let questions = [QuestionData(question: "Pick?")]
        service.handleClaudeOutput(ClaudeOutputData(type: "ask_user_question", questions: questions))
        #expect(service.promptQueue.count == 1)

        // Send 5+ messages — stale questions are now auto-removed too
        for i in 0..<6 {
            service.handleClaudeOutput(ClaudeOutputData(type: "assistant", content: "msg \(i)"))
        }
        #expect(service.promptQueue.isEmpty, "Stale questions should be auto-removed after 5 messages")
    }

    @MainActor
    @Test("planExit is NOT auto-dismissed by fallback removal")
    func fallbackDoesNotRemovePlanExit() {
        let (service, _) = Self.makeSUT()
        service.handleClaudeOutput(ClaudeOutputData(type: "exit_plan_mode"))
        #expect(service.promptQueue.count == 1)

        // Send 10+ messages — planExit should survive
        for i in 0..<10 {
            service.handleClaudeOutput(ClaudeOutputData(type: "assistant", content: "msg \(i)"))
        }
        #expect(service.promptQueue.count == 1, "PlanExit must never be auto-removed")
        if case .planExit = service.currentPrompt?.kind {
            // Expected
        } else {
            Issue.record("Expected planExit to survive fallback removal")
        }
    }

    // MARK: - Dedup (handlePermissionRequest)

    @MainActor
    @Test("recoverFromHistory skips permissions with merged resultContent")
    func recoverSkipsMergedResults() {
        let (service, _) = Self.makeSUT()
        // Permission with merged tool_result (resultContent set by mergeOrAppendToolResult)
        var answered = Message(type: .permissionRequest, tool: "Bash", toolUseId: "tu-1")
        answered.resultContent = "command output"
        // Permission without result — genuinely unanswered
        let unanswered = Message(type: .permissionRequest, tool: "Write", toolUseId: "tu-2")

        service.recoverFromHistory([answered, unanswered], sessionStatus: .waiting)

        // Only the unanswered permission should be recovered
        #expect(service.promptQueue.count == 1)
        #expect(service.promptQueue[0].toolUseId == "tu-2")
    }

    @MainActor
    @Test("adding permission with same toolUseId replaces existing from history recovery")
    func dedupReplacesExisting() async throws {
        let (service, _) = Self.makeSUT()
        // Simulate history recovery adding a permission
        let messages = [
            Message(type: .permissionRequest, tool: "Bash", toolUseId: "tu-1"),
        ]
        service.recoverFromHistory(messages, sessionStatus: .waiting)
        #expect(service.promptQueue.count == 1)
        // Only prompt recovered — not marked stale
        #expect(service.currentPrompt?.isStale == false)

        // Now a fresh permission_request arrives with the same toolUseId
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-1"))
        try await Task.sleep(for: .milliseconds(700))

        // Should have exactly 1 prompt (deduped)
        #expect(service.promptQueue.count == 1)
        #expect(service.currentPrompt?.isStale == false)
    }

    @MainActor
    @Test("allowed tool auto-injects 'always' instead of showing prompt")
    func allowedToolAutoInjects() async throws {
        let (service, actions) = Self.makeSUT()

        // Grant Bash via claudeState permissions
        service.updateAllowedTools(ClaudeState.Permissions(allowedTools: ["Bash"], sessionGranted: nil, mode: nil))

        // Receive a permission_request for Bash (e.g., subagent prompt after approveAll)
        let data = ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-auto-1")
        service.handleClaudeOutput(data)

        // Should NOT show a prompt
        try await Task.sleep(for: .milliseconds(600))
        #expect(service.promptQueue.isEmpty)
        #expect(service.currentPrompt == nil)

        // Should have auto-injected "always" with the correct toolUseId
        #expect(actions.actions.count == 1)
        if case .inject(let cmd, let sid, let tuId) = actions.actions[0] {
            #expect(cmd == "always")
            #expect(sid == "test-session")
            #expect(tuId == "tu-auto-1")
        } else {
            Issue.record("Expected inject action")
        }
    }

    @MainActor
    @Test("allowed tool does not auto-inject without sessionId")
    func allowedToolNoInjectWithoutSession() async throws {
        let (service, actions) = Self.makeSUT()
        service.sessionId = nil // No session

        service.updateAllowedTools(ClaudeState.Permissions(allowedTools: ["Bash"], sessionGranted: nil, mode: nil))
        service.handleClaudeOutput(ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-2"))

        try await Task.sleep(for: .milliseconds(600))
        #expect(service.promptQueue.isEmpty) // Still skipped
        #expect(actions.actions.isEmpty) // No inject sent
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

    // MARK: - History Recovery: Status Timing (#35)

    @MainActor
    @Test("recoverFromHistory returns early when sessionStatus is .idle (status arrives after history)")
    func recoverDoesNothingWhenStatusIsIdle() {
        let (service, _) = Self.makeSUT()
        let messages = [
            Message(type: .permissionRequest, tool: "Bash", toolUseId: "tu-1"),
        ]
        // Simulate: history arrives before session_status — status is still .idle
        service.recoverFromHistory(messages, sessionStatus: .idle)
        #expect(service.promptQueue.isEmpty, "Should not recover when status is idle")
    }

    @MainActor
    @Test("recoverFromHistory with waiting status recovers prompts (second call after status update)")
    func recoverSucceedsWhenCalledAfterStatusUpdate() {
        let (service, _) = Self.makeSUT()
        let messages = [
            Message(type: .permissionRequest, tool: "Bash", toolUseId: "tu-1"),
        ]
        // First call with idle status (simulates history arriving before session_status)
        service.recoverFromHistory(messages, sessionStatus: .idle)
        #expect(service.promptQueue.isEmpty)

        // Second call with waiting status (simulates AppCoordinator re-calling when status changes)
        service.recoverFromHistory(messages, sessionStatus: .waiting)
        #expect(service.promptQueue.count == 1)
        if case .permission(let tool, _, _) = service.currentPrompt?.kind {
            #expect(tool == "Bash")
        } else {
            Issue.record("Expected Bash permission to be recovered")
        }
    }

    @MainActor
    @Test("recoverFromHistory skips permission_request matching a permission_resolved in history")
    func recoverSkipsPermissionResolved() {
        let (service, _) = Self.makeSUT()
        let messages = [
            Message(type: .permissionRequest, tool: "Bash", toolUseId: "tu-1"),
            Message(type: .permissionResolved, toolUseId: "tu-1"),  // Already resolved
            Message(type: .permissionRequest, tool: "Write", toolUseId: "tu-2"),  // Still pending
        ]
        service.recoverFromHistory(messages, sessionStatus: .waiting)
        // Only Write should be recovered — Bash was resolved
        #expect(service.promptQueue.count == 1)
        #expect(service.promptQueue[0].toolUseId == "tu-2")
    }

    @MainActor
    @Test("recoverFromHistory handles cross-boundary: permission_resolved earlier in history")
    func recoverHandlesCrossBoundaryResolution() {
        let (service, _) = Self.makeSUT()
        // Both resolve AND request in the history — resolved should win
        let messages = [
            Message(type: .permissionResolved, toolUseId: "tu-stale"),
            Message(type: .permissionRequest, tool: "Bash", toolUseId: "tu-stale"),  // Shows up after resolved due to log ordering
            Message(type: .permissionRequest, tool: "Write", toolUseId: "tu-pending"),
        ]
        service.recoverFromHistory(messages, sessionStatus: .waiting)
        // Only Write should be recovered — Bash's toolUseId was in permission_resolved
        #expect(service.promptQueue.count == 1)
        #expect(service.promptQueue[0].toolUseId == "tu-pending")
    }

    // MARK: - lastSeenPermission (#42)

    @MainActor
    @Test("lastSeenPermission is set on permission_request")
    func lastSeenPermissionSet() {
        let (service, _) = Self.makeSUT()
        #expect(service.lastSeenPermission == nil)

        let data = ClaudeOutputData(type: "permission_request", tool: "Bash", input: ["command": .string("rm -rf /")])
        service.handleClaudeOutput(data)

        #expect(service.lastSeenPermission?.tool == "Bash")
        #expect(service.lastSeenPermission?.command == "rm -rf /")
    }

    @MainActor
    @Test("lastSeenPermission is set even for auto-approved tools")
    func lastSeenPermissionSetForAutoApproved() {
        let (service, _) = Self.makeSUT()
        // Pre-allow tool
        service.updateAllowedTools(ClaudeState.Permissions(allowedTools: ["Read"], sessionGranted: nil, mode: nil))

        let data = ClaudeOutputData(type: "permission_request", content: "/some/file.txt", tool: "Read")
        service.handleClaudeOutput(data)

        // Should still track it even though auto-approved
        #expect(service.lastSeenPermission?.tool == "Read")
        #expect(service.lastSeenPermission?.command == "/some/file.txt")
    }

    @MainActor
    @Test("lastSeenPermission is cleared on clearQueue")
    func lastSeenPermissionClearedOnClearQueue() {
        let (service, _) = Self.makeSUT()
        let data = ClaudeOutputData(type: "permission_request", tool: "Bash", input: ["command": .string("ls")])
        service.handleClaudeOutput(data)
        #expect(service.lastSeenPermission != nil)

        service.clearQueue()
        #expect(service.lastSeenPermission == nil)
    }
}

// MARK: - Test Helpers

/// Captures ClientAction calls for test verification
@MainActor
private final class ActionCapture {
    var actions: [ClientAction] = []
}
