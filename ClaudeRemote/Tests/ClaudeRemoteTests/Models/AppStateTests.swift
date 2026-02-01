import Testing
import Foundation
@testable import ClaudeRemote

@Suite("AppState")
struct AppStateTests {

    @MainActor
    @Test("Initial state")
    func initialState() {
        let state = AppState()
        #expect(state.isAuthenticated == false)
        #expect(state.isConnected == false)
        #expect(state.sessions.isEmpty)
        #expect(state.currentSessionId == nil)
        #expect(state.sessionSwitchState == .idle)
        #expect(state.messages.isEmpty)
        #expect(state.sessionStatus == .idle)
        #expect(state.activeSubagents.isEmpty)
        #expect(state.tasks.isEmpty)
        #expect(state.ttsEnabled == false)
        #expect(state.triggerEnabled == false)
        #expect(state.speechRate == 1.0)
        #expect(state.debugMode == false)
    }

    // MARK: - Message Management

    @MainActor
    @Test("appendMessage adds message")
    func appendMessage() {
        let state = AppState()
        let msg = Message(type: .assistant, content: "Hello")
        state.appendMessage(msg)
        #expect(state.messages.count == 1)
        #expect(state.messages[0].content == "Hello")
    }

    @MainActor
    @Test("appendMessage trims to max")
    func appendMessageTrims() {
        let state = AppState()
        for i in 0..<(AppState.maxMessages + 50) {
            state.appendMessage(Message(type: .assistant, content: "msg \(i)"))
        }
        #expect(state.messages.count == AppState.maxMessages)
        // First message should be msg 50 (oldest 50 trimmed)
        #expect(state.messages[0].content == "msg 50")
    }

    @MainActor
    @Test("clearMessages removes all")
    func clearMessages() {
        let state = AppState()
        state.appendMessage(Message(type: .assistant, content: "Hello"))
        state.appendMessage(Message(type: .user, content: "Hi"))
        state.tasks.append(TaskItem(id: "t1", subject: "Test task", status: "pending"))
        state.clearMessages()
        #expect(state.messages.isEmpty)
        #expect(state.tasks.isEmpty)
    }

    // MARK: - Deduplication

    @MainActor
    @Test("Track and dedup message")
    func trackAndDedup() {
        let state = AppState()
        state.trackSentMessage("hello world")
        #expect(state.shouldDedupeMessage("hello world") == true)
        // Second check should not dedup (already consumed)
        #expect(state.shouldDedupeMessage("hello world") == false)
    }

    @MainActor
    @Test("Dedup is case-preserving but whitespace-normalized")
    func dedupNormalization() {
        let state = AppState()
        state.trackSentMessage("hello   world")
        #expect(state.shouldDedupeMessage("hello world") == true)
    }

    @MainActor
    @Test("Different messages are not deduped")
    func noDedupForDifferent() {
        let state = AppState()
        state.trackSentMessage("hello")
        #expect(state.shouldDedupeMessage("goodbye") == false)
    }

    @MainActor
    @Test("normalizeForDedup trims and collapses whitespace")
    func normalizeForDedup() {
        #expect(AppState.normalizeForDedup("  hello   world  ") == "hello world")
        #expect(AppState.normalizeForDedup("no\nchange") == "no change")
        #expect(AppState.normalizeForDedup("tabs\there") == "tabs here")
    }

    // MARK: - Session Switching

    @MainActor
    @Test("Session switch state machine: normal flow")
    func sessionSwitchNormal() {
        let state = AppState()
        #expect(state.sessionSwitchState == .idle)

        state.beginSessionSwitch(to: "sess-1")
        #expect(state.sessionSwitchState == .switching)
        #expect(state.pendingSessionId == "sess-1")

        state.confirmSessionSwitch(sessionId: "sess-1")
        #expect(state.sessionSwitchState == .active)
        #expect(state.currentSessionId == "sess-1")
        #expect(state.pendingSessionId == nil)
    }

    @MainActor
    @Test("Session switch: wrong session ID does not confirm")
    func sessionSwitchWrongId() {
        let state = AppState()
        state.beginSessionSwitch(to: "sess-1")
        state.confirmSessionSwitch(sessionId: "sess-2")
        // Should still be switching since IDs don't match
        #expect(state.sessionSwitchState == .switching)
        #expect(state.currentSessionId == nil)
    }

    @MainActor
    @Test("Session switch: confirm from idle (reconnection)")
    func sessionSwitchFromIdle() {
        let state = AppState()
        // Simulate reconnection where we go directly from idle to active
        state.confirmSessionSwitch(sessionId: "sess-1")
        #expect(state.sessionSwitchState == .active)
        #expect(state.currentSessionId == "sess-1")
    }

    // MARK: - Context Window

    @MainActor
    @Test("contextPercentage returns 0 when no tokens used")
    func contextPercentageZero() {
        let state = AppState()
        #expect(state.contextPercentage == 0)
    }

    @MainActor
    @Test("contextPercentage returns correct ratio")
    func contextPercentageRatio() {
        let state = AppState()
        state.contextTokensUsed = 100_000
        #expect(state.contextPercentage == 0.5)
    }

    @MainActor
    @Test("contextPercentage caps at 1.0")
    func contextPercentageCapped() {
        let state = AppState()
        state.contextTokensUsed = 300_000
        #expect(state.contextPercentage == 1.0)
    }

    @MainActor
    @Test("beginSessionSwitch resets contextTokensUsed")
    func sessionSwitchResetsContext() {
        let state = AppState()
        state.contextTokensUsed = 150_000
        #expect(state.contextPercentage > 0)
        state.beginSessionSwitch(to: "sess-2")
        #expect(state.contextTokensUsed == 0)
        #expect(state.contextPercentage == 0)
    }

    // MARK: - mergeOrAppendToolResult

    @MainActor
    @Test("mergeOrAppendToolResult merges by toolUseId")
    func mergeToolResultByToolUseId() {
        let state = AppState()
        let toolMsg = Message(type: .tool, content: nil, tool: "Bash", toolUseId: "tu-1")
        state.appendMessage(toolMsg)
        #expect(state.messages.count == 1)
        #expect(state.messages[0].resultContent == nil)

        let resultMsg = Message(type: .toolResult, content: "output here", toolUseId: "tu-1")
        state.mergeOrAppendToolResult(resultMsg)
        // Should merge, not append
        #expect(state.messages.count == 1)
        #expect(state.messages[0].resultContent == "output here")
    }

    @MainActor
    @Test("mergeOrAppendToolResult appends when no matching toolUseId")
    func mergeToolResultNoMatch() {
        let state = AppState()
        let toolMsg = Message(type: .tool, content: nil, tool: "Bash", toolUseId: "tu-1")
        state.appendMessage(toolMsg)

        let resultMsg = Message(type: .toolResult, content: "output", toolUseId: "tu-999")
        state.mergeOrAppendToolResult(resultMsg)
        // Should append as new message
        #expect(state.messages.count == 2)
    }

    @MainActor
    @Test("mergeOrAppendToolResult appends when no toolUseId")
    func mergeToolResultNilToolUseId() {
        let state = AppState()
        let resultMsg = Message(type: .toolResult, content: "standalone result")
        state.mergeOrAppendToolResult(resultMsg)
        #expect(state.messages.count == 1)
        #expect(state.messages[0].content == "standalone result")
    }

    @MainActor
    @Test("mergeOrAppendToolResult matches permissionRequest type")
    func mergeToolResultMatchesPermissionRequest() {
        let state = AppState()
        let permMsg = Message(type: .permissionRequest, content: "Allow?", tool: "Bash", toolUseId: "tu-1")
        state.appendMessage(permMsg)

        let resultMsg = Message(type: .toolResult, content: "allowed", toolUseId: "tu-1")
        state.mergeOrAppendToolResult(resultMsg)
        // Should merge into the permissionRequest
        #expect(state.messages.count == 1)
        #expect(state.messages[0].resultContent == "allowed")
    }

    @MainActor
    @Test("mergeOrAppendToolResult merges into last matching message")
    func mergeToolResultLastMatch() {
        let state = AppState()
        // Two tool messages with the same toolUseId (shouldn't happen, but tests lastIndex)
        let first = Message(type: .tool, content: "first", tool: "Bash", toolUseId: "tu-1")
        let second = Message(type: .tool, content: "second", tool: "Bash", toolUseId: "tu-1")
        state.appendMessage(first)
        state.appendMessage(second)

        let resultMsg = Message(type: .toolResult, content: "result", toolUseId: "tu-1")
        state.mergeOrAppendToolResult(resultMsg)
        // Should merge into the LAST match (index 1)
        #expect(state.messages.count == 2)
        #expect(state.messages[0].resultContent == nil)
        #expect(state.messages[1].resultContent == "result")
    }

    @MainActor
    @Test("mergeOrAppendToolResult sets resultIsError")
    func mergeToolResultSetsError() {
        let state = AppState()
        let toolMsg = Message(type: .tool, content: nil, tool: "Bash", toolUseId: "tu-1")
        state.appendMessage(toolMsg)

        let resultMsg = Message(type: .toolResult, content: "error output", toolUseId: "tu-1", resultIsError: true)
        state.mergeOrAppendToolResult(resultMsg)
        #expect(state.messages[0].resultIsError == true)
        #expect(state.messages[0].resultContent == "error output")
    }

    // MARK: - Filtering

    @MainActor
    @Test("appendMessage filters '(no content)' messages")
    func appendMessageFiltersNoContent() {
        let state = AppState()
        state.appendMessage(Message(type: .assistant, content: "(no content)"))
        #expect(state.messages.isEmpty)
    }

    @MainActor
    @Test("appendMessage filters '(no content)' with whitespace")
    func appendMessageFiltersNoContentWhitespace() {
        let state = AppState()
        state.appendMessage(Message(type: .assistant, content: "  (no content)  "))
        #expect(state.messages.isEmpty)
    }

    // MARK: - Dedup Expiration

    @MainActor
    @Test("dedup expires after window")
    func dedupExpires() {
        let state = AppState()
        // Manually insert an expired entry
        let key = AppState.normalizeForDedup("old message")
        state.recentUserMessages[key] = Date().addingTimeInterval(-(AppState.dedupWindow + 1))

        // Tracking a new message triggers cleanup
        state.trackSentMessage("new message")

        // The old entry should be cleaned up
        #expect(state.shouldDedupeMessage("old message") == false)
        // The new entry should still be valid
        #expect(state.shouldDedupeMessage("new message") == true)
    }

    // MARK: - Constants

    @MainActor
    @Test("maxMessages constant is 500")
    func maxMessagesConstant() {
        #expect(AppState.maxMessages == 500)
    }

    @MainActor
    @Test("dedupWindow constant is 10 seconds")
    func dedupWindowConstant() {
        #expect(AppState.dedupWindow == 10)
    }
}
