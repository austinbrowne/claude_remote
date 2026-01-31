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
        state.clearMessages()
        #expect(state.messages.isEmpty)
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
