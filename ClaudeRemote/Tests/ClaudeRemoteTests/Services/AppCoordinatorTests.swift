import Testing
import Foundation
@testable import ClaudeRemote

@Suite("AppCoordinator")
struct AppCoordinatorTests {

    // MARK: - Connection Delegate

    @MainActor
    @Test("webSocketDidConnect sets isConnected")
    func connectSetsState() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        coordinator.webSocketDidConnect()
        #expect(state.isConnected == true)
    }

    @MainActor
    @Test("webSocketDidDisconnect clears isConnected")
    func disconnectClearsState() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        state.isConnected = true
        coordinator.webSocketDidDisconnect(code: nil)
        #expect(state.isConnected == false)
    }

    // MARK: - Auth Result

    @MainActor
    @Test("authResult failure clears auth state")
    func authFailure() {
        let state = AppState()
        state.isAuthenticated = true
        state.isConnected = true
        let coordinator = AppCoordinator(state: state)
        coordinator.webSocketDidReceiveMessage(.authResult(success: false, error: "bad token"))
        #expect(state.isAuthenticated == false)
        #expect(state.isConnected == false)
    }

    @MainActor
    @Test("authResult success sets isAuthenticated")
    func authSuccess() {
        let state = AppState()
        state.isConnected = true
        let coordinator = AppCoordinator(state: state)
        #expect(state.isAuthenticated == false)
        coordinator.webSocketDidReceiveMessage(.authResult(success: true, error: nil))
        #expect(state.isAuthenticated == true)
        #expect(state.isConnected == true)
    }

    // MARK: - Sessions

    @MainActor
    @Test("sessions message updates state.sessions")
    func sessionsUpdate() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        let sessions = [
            Session(id: "s1", name: "Session 1"),
            Session(id: "s2", name: "Session 2"),
        ]
        coordinator.webSocketDidReceiveMessage(.sessions(data: sessions))
        #expect(state.sessions.count == 2)
        #expect(state.sessions[0].id == "s1")
    }

    // MARK: - Watching

    @MainActor
    @Test("watching message confirms session switch")
    func watchingConfirms() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        state.beginSessionSwitch(to: "s1")
        let session = Session(id: "s1", name: "Session 1")
        coordinator.webSocketDidReceiveMessage(.watching(sessionId: "s1", session: session))
        #expect(state.currentSessionId == "s1")
        #expect(state.sessionSwitchState == .active)
    }

    // MARK: - History

    @MainActor
    @Test("history clears messages then appends entries")
    func historyLoadsMessages() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        // Pre-existing message
        state.appendMessage(Message(type: .assistant, content: "old"))
        #expect(state.messages.count == 1)

        let entries = [
            ClaudeOutputData(type: "assistant", content: "Hello"),
            ClaudeOutputData(type: "user", content: "Hi"),
        ]
        coordinator.webSocketDidReceiveMessage(.history(sessionId: "s1", data: entries))
        #expect(state.messages.count == 2)
        #expect(state.messages[0].type == .assistant)
        #expect(state.messages[0].content == "Hello")
        #expect(state.messages[1].type == .user)
    }

    @MainActor
    @Test("history filters empty assistant messages")
    func historyFiltersEmpty() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        let entries = [
            ClaudeOutputData(type: "assistant", content: nil),
            ClaudeOutputData(type: "assistant", content: ""),
            ClaudeOutputData(type: "assistant", content: "valid"),
        ]
        coordinator.webSocketDidReceiveMessage(.history(sessionId: "s1", data: entries))
        #expect(state.messages.count == 1)
        #expect(state.messages[0].content == "valid")
    }

    // MARK: - Claude Output

    @MainActor
    @Test("claude_output appends assistant message")
    func claudeOutputAssistant() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        let data = ClaudeOutputData(type: "assistant", content: "Hello world")
        coordinator.webSocketDidReceiveMessage(.claudeOutput(sessionId: "s1", data: data))
        #expect(state.messages.count == 1)
        #expect(state.messages[0].type == .assistant)
        #expect(state.messages[0].content == "Hello world")
    }

    @MainActor
    @Test("claude_output filters empty assistant messages")
    func claudeOutputFiltersEmpty() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        let data = ClaudeOutputData(type: "assistant", content: "")
        coordinator.webSocketDidReceiveMessage(.claudeOutput(sessionId: "s1", data: data))
        #expect(state.messages.isEmpty)
    }

    @MainActor
    @Test("claude_output filters nil-content assistant messages")
    func claudeOutputFiltersNil() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        let data = ClaudeOutputData(type: "assistant", content: nil)
        coordinator.webSocketDidReceiveMessage(.claudeOutput(sessionId: "s1", data: data))
        #expect(state.messages.isEmpty)
    }

    @MainActor
    @Test("claude_output tool message is appended")
    func claudeOutputTool() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        let data = ClaudeOutputData(
            type: "tool",
            content: nil,
            tool: "Bash",
            input: ["command": .string("ls")]
        )
        coordinator.webSocketDidReceiveMessage(.claudeOutput(sessionId: "s1", data: data))
        #expect(state.messages.count == 1)
        #expect(state.messages[0].type == .tool)
        #expect(state.messages[0].tool == "Bash")
    }

    @MainActor
    @Test("claude_output deduplicates user messages")
    func claudeOutputDedup() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        state.trackSentMessage("my command")
        let data = ClaudeOutputData(type: "user", content: "my command")
        coordinator.webSocketDidReceiveMessage(.claudeOutput(sessionId: "s1", data: data))
        // Should be deduped
        #expect(state.messages.isEmpty)
    }

    @MainActor
    @Test("claude_output does not dedup untracked user messages")
    func claudeOutputNoDedup() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        let data = ClaudeOutputData(type: "user", content: "from elsewhere")
        coordinator.webSocketDidReceiveMessage(.claudeOutput(sessionId: "s1", data: data))
        #expect(state.messages.count == 1)
    }

    @MainActor
    @Test("claude_output status_update updates sessionStatus")
    func claudeOutputStatusUpdate() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        let data = ClaudeOutputData(type: "status_update", content: "Processing", status: "processing")
        coordinator.webSocketDidReceiveMessage(.claudeOutput(sessionId: "s1", data: data))
        #expect(state.sessionStatus == .processing)
    }

    // MARK: - Session Status

    @MainActor
    @Test("sessionStatus updates state")
    func sessionStatus() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        coordinator.webSocketDidReceiveMessage(.sessionStatus(sessionId: "s1", status: "waiting", lastActive: nil))
        #expect(state.sessionStatus == .waiting)
    }

    @MainActor
    @Test("statusUpdate updates state")
    func statusUpdate() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        coordinator.webSocketDidReceiveMessage(.statusUpdate(status: "active"))
        #expect(state.sessionStatus == .active)
    }

    @MainActor
    @Test("unknown status becomes .unknown")
    func unknownStatus() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        coordinator.webSocketDidReceiveMessage(.statusUpdate(status: "never_seen_before"))
        #expect(state.sessionStatus == .unknown)
    }

    // MARK: - Token Usage

    @MainActor
    @Test("tokenUsage appends formatted message")
    func tokenUsage() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        coordinator.webSocketDidReceiveMessage(.tokenUsage(input: 1500, output: 200))
        #expect(state.messages.count == 1)
        #expect(state.messages[0].type == .tokenUsage)
        #expect(state.messages[0].content == "1.5k in / 200 out")
    }

    @MainActor
    @Test("tokenUsage formats millions")
    func tokenUsageMillions() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        coordinator.webSocketDidReceiveMessage(.tokenUsage(input: 2_500_000, output: nil))
        #expect(state.messages[0].content == "2.5M in / 0 out")
    }

    @MainActor
    @Test("tokenUsage handles nil values")
    func tokenUsageNil() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        coordinator.webSocketDidReceiveMessage(.tokenUsage(input: nil, output: nil))
        #expect(state.messages[0].content == "0 in / 0 out")
    }

    // MARK: - Tasks

    @MainActor
    @Test("taskCreate appends task")
    func taskCreate() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        coordinator.webSocketDidReceiveMessage(.taskCreate(id: "t1", subject: "Do stuff", description: "Details", activeForm: "Doing stuff", status: "pending"))
        #expect(state.tasks.count == 1)
        #expect(state.tasks[0].id == "t1")
        #expect(state.tasks[0].subject == "Do stuff")
    }

    @MainActor
    @Test("taskUpdate modifies existing task")
    func taskUpdate() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        state.tasks.append(TaskItem(id: "t1", subject: "Old", status: "pending"))
        coordinator.webSocketDidReceiveMessage(.taskUpdate(taskId: "t1", status: "completed", subject: "New"))
        #expect(state.tasks[0].subject == "New")
        #expect(state.tasks[0].status == "completed")
    }

    @MainActor
    @Test("taskUpdate for unknown ID does nothing")
    func taskUpdateUnknownId() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        coordinator.webSocketDidReceiveMessage(.taskUpdate(taskId: "missing", status: "done", subject: nil))
        #expect(state.tasks.isEmpty)
    }

    @MainActor
    @Test("taskList replaces all tasks")
    func taskList() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        state.tasks.append(TaskItem(id: "old", subject: "Old"))
        let newTasks = [TaskItem(id: "t1", subject: "A"), TaskItem(id: "t2", subject: "B")]
        coordinator.webSocketDidReceiveMessage(.taskList(tasks: newTasks))
        #expect(state.tasks.count == 2)
        #expect(state.tasks[0].id == "t1")
    }

    // MARK: - Subagents

    @MainActor
    @Test("subagentStarting appends message")
    func subagentStarting() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        coordinator.webSocketDidReceiveMessage(.subagentStarting(description: "Exploring code", agentType: "Explore"))
        #expect(state.messages.count == 1)
        #expect(state.messages[0].type == .subagentStarting)
        #expect(state.messages[0].content == "Exploring code")
        #expect(state.messages[0].tool == "Explore")
    }

    @MainActor
    @Test("subagentStart tracks in activeSubagents")
    func subagentStart() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        coordinator.webSocketDidReceiveMessage(.subagentStart(agentId: "a1", sessionId: nil, description: "Research", agentType: "Explore"))
        #expect(state.activeSubagents["a1"] != nil)
        #expect(state.activeSubagents["a1"]?.description == "Research")
        #expect(state.activeSubagents["a1"]?.agentType == "Explore")
    }

    @MainActor
    @Test("subagentOutput appends message with subagent flag")
    func subagentOutput() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        let data = ClaudeOutputData(type: "assistant", content: "Found it")
        coordinator.webSocketDidReceiveMessage(.subagentOutput(agentId: "a1", sessionId: nil, data: data))
        #expect(state.messages.count == 1)
        #expect(state.messages[0].isSubagent == true)
        #expect(state.messages[0].subagentId == "a1")
    }

    @MainActor
    @Test("subagentStop marks agent as completed")
    func subagentStop() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        state.activeSubagents["a1"] = SubagentInfo(description: "test", agentType: "general")
        coordinator.webSocketDidReceiveMessage(.subagentStop(agentId: "a1"))
        #expect(state.activeSubagents["a1"]?.status == "completed")
    }

    // MARK: - Error

    @MainActor
    @Test("error message appends status update")
    func errorMessage() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        coordinator.webSocketDidReceiveMessage(.error(code: "500", message: "Something broke", details: nil))
        #expect(state.messages.count == 1)
        #expect(state.messages[0].type == .statusUpdate)
        #expect(state.messages[0].content == "Error: Something broke")
    }

    // MARK: - No-op Messages

    @MainActor
    @Test("pong does not modify state")
    func pongNoOp() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        coordinator.webSocketDidReceiveMessage(.pong(timestamp: 123456))
        #expect(state.messages.isEmpty)
        #expect(state.tasks.isEmpty)
    }

    // MARK: - Debug Mode

    @MainActor
    @Test("debug mode prepends debug message before routing")
    func debugModeAddsMessage() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        // Set after init since init calls SettingsStore.load which resets it
        state.debugMode = true
        coordinator.webSocketDidReceiveMessage(.statusUpdate(status: "active"))
        let debugMessages = state.messages.filter { ($0.content ?? "").hasPrefix("[DEBUG]") }
        #expect(debugMessages.count == 1)
        #expect(debugMessages[0].content?.contains("status_update") == true)
    }

    @MainActor
    @Test("debug mode off does not add debug messages")
    func debugModeOff() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        state.debugMode = false
        coordinator.webSocketDidReceiveMessage(.statusUpdate(status: "active"))
        let debugMessages = state.messages.filter { ($0.content ?? "").hasPrefix("[DEBUG]") }
        #expect(debugMessages.isEmpty)
    }

    // MARK: - Toast on Connect/Disconnect

    @MainActor
    @Test("connect shows success toast")
    func connectToast() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        coordinator.webSocketDidConnect()
        #expect(state.currentToast != nil)
        #expect(state.currentToast?.message == "Connected")
        #expect(state.currentToast?.style == .success)
    }

    @MainActor
    @Test("disconnect shows warning toast")
    func disconnectToast() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        coordinator.webSocketDidDisconnect(code: nil)
        #expect(state.currentToast != nil)
        #expect(state.currentToast?.message == "Disconnected")
        #expect(state.currentToast?.style == .warning)
    }

    @MainActor
    @Test("auth failure shows error toast")
    func authFailureToast() {
        let state = AppState()
        state.isAuthenticated = true
        let coordinator = AppCoordinator(state: state)
        coordinator.webSocketDidReceiveMessage(.authResult(success: false, error: "bad"))
        #expect(state.currentToast != nil)
        #expect(state.currentToast?.style == .error)
    }
}
