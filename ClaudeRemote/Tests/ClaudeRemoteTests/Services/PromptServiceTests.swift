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
        let permData = ClaudeOutputData(type: "permission_request", tool: "Bash")
        service.handleClaudeOutput(permData)
        #expect(service.currentPrompt == nil)

        // tool_result arrives before 500ms
        let resultData = ClaudeOutputData(type: "tool_result", content: "done")
        service.handleClaudeOutput(resultData)

        // Wait past the 500ms window
        try await Task.sleep(for: .milliseconds(600))
        // Should still be nil — was suppressed
        #expect(service.currentPrompt == nil)
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
        let data = ClaudeOutputData(type: "permission_request", tool: "Bash")
        service.handleClaudeOutput(data)
        try await Task.sleep(for: .milliseconds(600))
        #expect(service.currentPrompt != nil)

        // tool_result arrives
        service.handleClaudeOutput(ClaudeOutputData(type: "tool_result"))
        #expect(service.currentPrompt == nil)
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
            Message(type: .permissionRequest, tool: "Bash"),
            Message(type: .toolResult, content: "done"),
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
}

// MARK: - Test Helpers

/// Captures ClientAction calls for test verification
@MainActor
private final class ActionCapture {
    var actions: [ClientAction] = []
}
