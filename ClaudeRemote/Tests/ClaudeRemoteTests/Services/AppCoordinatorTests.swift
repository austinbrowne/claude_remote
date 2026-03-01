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
        state.confirmSessionSwitch(sessionId: "s1")
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
        state.confirmSessionSwitch(sessionId: "s1")
        let coordinator = AppCoordinator(state: state)
        let data = ClaudeOutputData(type: "assistant", content: "")
        coordinator.webSocketDidReceiveMessage(.claudeOutput(sessionId: "s1", data: data))
        #expect(state.messages.isEmpty)
    }

    @MainActor
    @Test("claude_output filters nil-content assistant messages")
    func claudeOutputFiltersNil() {
        let state = AppState()
        state.confirmSessionSwitch(sessionId: "s1")
        let coordinator = AppCoordinator(state: state)
        let data = ClaudeOutputData(type: "assistant", content: nil)
        coordinator.webSocketDidReceiveMessage(.claudeOutput(sessionId: "s1", data: data))
        #expect(state.messages.isEmpty)
    }

    @MainActor
    @Test("claude_output tool message is appended")
    func claudeOutputTool() {
        let state = AppState()
        state.confirmSessionSwitch(sessionId: "s1")
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
        state.confirmSessionSwitch(sessionId: "s1")
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
        state.confirmSessionSwitch(sessionId: "s1")
        let coordinator = AppCoordinator(state: state)
        let data = ClaudeOutputData(type: "user", content: "from elsewhere")
        coordinator.webSocketDidReceiveMessage(.claudeOutput(sessionId: "s1", data: data))
        #expect(state.messages.count == 1)
    }

    @MainActor
    @Test("claude_output status_update updates sessionStatus")
    func claudeOutputStatusUpdate() {
        let state = AppState()
        state.confirmSessionSwitch(sessionId: "s1")
        let coordinator = AppCoordinator(state: state)
        let data = ClaudeOutputData(type: "status_update", content: "Processing", status: "processing")
        coordinator.webSocketDidReceiveMessage(.claudeOutput(sessionId: "s1", data: data))
        #expect(state.sessionStatus == .processing)
    }

    @MainActor
    @Test("claude_output ignores messages from different session")
    func claudeOutputIgnoresDifferentSession() {
        let state = AppState()
        state.confirmSessionSwitch(sessionId: "sess-1")
        let coordinator = AppCoordinator(state: state)
        let data = ClaudeOutputData(type: "assistant", content: "From other session")
        coordinator.webSocketDidReceiveMessage(.claudeOutput(sessionId: "sess-2", data: data))
        #expect(state.messages.isEmpty)
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

    // MARK: - Context Percentage

    @MainActor
    @Test("contextPercentage does not append message to chat")
    func contextPercentageNoMessage() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        coordinator.webSocketDidReceiveMessage(.contextPercentage(sessionId: nil, percentage: 42))
        #expect(state.messages.isEmpty)
    }

    @MainActor
    @Test("contextPercentage updates state.contextPercentage")
    func contextPercentageUpdatesState() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        coordinator.webSocketDidReceiveMessage(.contextPercentage(sessionId: nil, percentage: 50))
        #expect(state.contextPercentage == 0.5)
    }

    @MainActor
    @Test("contextPercentage ignores messages from different session")
    func contextPercentageIgnoresDifferentSession() {
        let state = AppState()
        state.confirmSessionSwitch(sessionId: "sess-1")
        let coordinator = AppCoordinator(state: state)
        coordinator.webSocketDidReceiveMessage(.contextPercentage(sessionId: "sess-2", percentage: 50))
        #expect(state.contextPercentage == 0)
    }

    @MainActor
    @Test("contextPercentage crossing 90% fires warning toast")
    func contextPercentageCrossing90() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        // Set below 90% first
        state.contextPercentage = 0.85
        state.currentToast = nil
        // Now push above 90%
        coordinator.webSocketDidReceiveMessage(.contextPercentage(sessionId: nil, percentage: 92))
        #expect(state.contextPercentage == 0.92)
        #expect(state.currentToast != nil)
        #expect(state.currentToast?.message.contains("compact") == true)
        #expect(state.currentToast?.style == .warning)
    }

    @MainActor
    @Test("contextPercentage already above 90% does not re-fire toast")
    func contextPercentageAlreadyAbove90() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        // Already above 90%
        state.contextPercentage = 0.92
        state.currentToast = nil
        // Update again still above 90%
        coordinator.webSocketDidReceiveMessage(.contextPercentage(sessionId: nil, percentage: 95))
        #expect(state.contextPercentage == 0.95)
        // Toast should NOT fire (already was above 90%)
        #expect(state.currentToast == nil)
    }

    @MainActor
    @Test("legacy tokenUsage is ignored (no-op)")
    func legacyTokenUsageIgnored() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        coordinator.webSocketDidReceiveMessage(.tokenUsage(sessionId: nil, input: 100_000, output: 500))
        #expect(state.contextPercentage == 0)
        #expect(state.messages.isEmpty)
    }

    // MARK: - Tasks

    @MainActor
    @Test("taskCreate appends task")
    func taskCreate() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        coordinator.webSocketDidReceiveMessage(.taskCreate(id: "t1", subject: "Do stuff", description: "Details", activeForm: "Doing stuff", status: "pending", owner: nil))
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
        coordinator.webSocketDidReceiveMessage(.taskUpdate(taskId: "t1", status: "completed", subject: "New", activeForm: "Doing new", description: "New desc", owner: nil))
        #expect(state.tasks[0].subject == "New")
        #expect(state.tasks[0].status == "completed")
        #expect(state.tasks[0].activeForm == "Doing new")
        #expect(state.tasks[0].description == "New desc")
    }

    @MainActor
    @Test("taskUpdate for unknown ID does nothing")
    func taskUpdateUnknownId() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        coordinator.webSocketDidReceiveMessage(.taskUpdate(taskId: "missing", status: "done", subject: nil, activeForm: nil, description: nil, owner: nil))
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
    @Test("subagentStarting appends message with starting status and registers pending")
    func subagentStarting() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        coordinator.webSocketDidReceiveMessage(.subagentStarting(description: "Exploring code", agentType: "Explore"))
        #expect(state.messages.count == 1)
        #expect(state.messages[0].type == .subagentStarting)
        #expect(state.messages[0].content == "Exploring code")
        #expect(state.messages[0].tool == "Explore")
        #expect(state.messages[0].subagentStatus == "starting")
        #expect(state.pendingSubagentMessages.count == 1)
        #expect(state.pendingSubagentMessages[0].description == "Exploring code")
        #expect(state.pendingSubagentMessages[0].messageIndex == 0)
    }

    @MainActor
    @Test("subagentStart correlates to pending message and sets running status")
    func subagentStart() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        // First, create a pending subagent_starting message
        coordinator.webSocketDidReceiveMessage(.subagentStarting(description: "Research", agentType: "Explore"))
        #expect(state.pendingSubagentMessages.count == 1)
        // Now correlate via subagent_start
        coordinator.webSocketDidReceiveMessage(.subagentStart(agentId: "a1", sessionId: nil, description: "Research", agentType: "Explore", teamName: nil, memberName: nil))
        #expect(state.activeSubagents["a1"] != nil)
        #expect(state.activeSubagents["a1"]?.description == "Research")
        #expect(state.activeSubagents["a1"]?.agentType == "Explore")
        // Correlation should have linked the message
        #expect(state.subagentMessageMap["a1"] == 0)
        #expect(state.messages[0].subagentStatus == "running")
        #expect(state.messages[0].subagentAgentId == "a1")
        // Pending should be consumed
        #expect(state.pendingSubagentMessages.isEmpty)
    }

    @MainActor
    @Test("subagentOutput is suppressed from chat messages")
    func subagentOutput() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        let data = ClaudeOutputData(type: "assistant", content: "Found it")
        coordinator.webSocketDidReceiveMessage(.subagentOutput(agentId: "a1", sessionId: nil, data: data))
        #expect(state.messages.isEmpty)
    }

    @MainActor
    @Test("subagentStop marks agent and inline message as completed")
    func subagentStop() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        // Set up: starting -> start -> stop
        coordinator.webSocketDidReceiveMessage(.subagentStarting(description: "test", agentType: "general"))
        coordinator.webSocketDidReceiveMessage(.subagentStart(agentId: "a1", sessionId: nil, description: "test", agentType: "general", teamName: nil, memberName: nil))
        #expect(state.messages[0].subagentStatus == "running")
        coordinator.webSocketDidReceiveMessage(.subagentStop(agentId: "a1"))
        #expect(state.activeSubagents["a1"]?.status == "completed")
        #expect(state.messages[0].subagentStatus == "completed")
    }

    // MARK: - Subagent Correlation (New Tests)

    @MainActor
    @Test("parallel subagent correlation: 3 starting + 3 start correctly correlate by description")
    func parallelSubagentCorrelation() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        // 3 subagents starting
        coordinator.webSocketDidReceiveMessage(.subagentStarting(description: "Security review", agentType: "Plan"))
        coordinator.webSocketDidReceiveMessage(.subagentStarting(description: "Code analysis", agentType: "Explore"))
        coordinator.webSocketDidReceiveMessage(.subagentStarting(description: "Performance check", agentType: "Bash"))
        #expect(state.messages.count == 3)
        #expect(state.pendingSubagentMessages.count == 3)
        // Correlate in different order
        coordinator.webSocketDidReceiveMessage(.subagentStart(agentId: "b2", sessionId: nil, description: "Code analysis", agentType: "Explore", teamName: nil, memberName: nil))
        coordinator.webSocketDidReceiveMessage(.subagentStart(agentId: "b1", sessionId: nil, description: "Security review", agentType: "Plan", teamName: nil, memberName: nil))
        coordinator.webSocketDidReceiveMessage(.subagentStart(agentId: "b3", sessionId: nil, description: "Performance check", agentType: "Bash", teamName: nil, memberName: nil))
        // All should be correlated
        #expect(state.pendingSubagentMessages.isEmpty)
        #expect(state.subagentMessageMap["b1"] == 0)
        #expect(state.subagentMessageMap["b2"] == 1)
        #expect(state.subagentMessageMap["b3"] == 2)
        #expect(state.messages[0].subagentStatus == "running")
        #expect(state.messages[1].subagentStatus == "running")
        #expect(state.messages[2].subagentStatus == "running")
    }

    @MainActor
    @Test("subagentStart with no matching pending still tracks in activeSubagents")
    func subagentStartNoMatchingPending() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        // No subagentStarting was sent first
        coordinator.webSocketDidReceiveMessage(.subagentStart(agentId: "a1", sessionId: nil, description: "Mystery agent", agentType: "general", teamName: nil, memberName: nil))
        #expect(state.activeSubagents["a1"] != nil)
        #expect(state.activeSubagents["a1"]?.description == "Mystery agent")
        // No message map entry since no pending message matched
        #expect(state.subagentMessageMap["a1"] == nil)
    }

    @MainActor
    @Test("subagentTool updates both activeSubagents and inline message")
    func subagentToolUpdatesInlineCard() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        // Full lifecycle: starting -> start -> tool
        coordinator.webSocketDidReceiveMessage(.subagentStarting(description: "Research", agentType: "Explore"))
        coordinator.webSocketDidReceiveMessage(.subagentStart(agentId: "a1", sessionId: nil, description: "Research", agentType: "Explore", teamName: nil, memberName: nil))
        coordinator.webSocketDidReceiveMessage(.subagentTool(agentId: "a1", tool: "Read", input: nil))
        #expect(state.activeSubagents["a1"]?.currentTool == "Read")
        #expect(state.messages[0].subagentCurrentTool == "Read")
        #expect(state.messages[0].subagentStatus == "running")
    }

    @MainActor
    @Test("session switch clears pendingSubagentMessages and subagentMessageMap")
    func sessionSwitchClearsSubagentState() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        coordinator.webSocketDidReceiveMessage(.subagentStarting(description: "test", agentType: "general"))
        coordinator.webSocketDidReceiveMessage(.subagentStart(agentId: "a1", sessionId: nil, description: "test", agentType: "general", teamName: nil, memberName: nil))
        #expect(!state.subagentMessageMap.isEmpty)
        // Switch session
        state.beginSessionSwitch(to: "new-session")
        #expect(state.pendingSubagentMessages.isEmpty)
        #expect(state.subagentMessageMap.isEmpty)
        #expect(state.messages.isEmpty)
    }

    @MainActor
    @Test("updateSubagentMessage with out-of-bounds index does nothing")
    func updateSubagentMessageOutOfBounds() {
        let state = AppState()
        // No messages exist
        state.updateSubagentMessage(at: 5, status: "running", tool: "Bash")
        #expect(state.messages.isEmpty)
        // Add one message, try index beyond it
        state.appendMessage(Message(type: .assistant, content: "hello"))
        state.updateSubagentMessage(at: 10, status: "running", tool: "Bash")
        #expect(state.messages[0].subagentStatus == nil)
    }

    @MainActor
    @Test("suppressed subagentOutput with data does not increase message count")
    func subagentOutputSuppressedWithData() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        // Pre-existing message
        state.appendMessage(Message(type: .assistant, content: "existing"))
        let initialCount = state.messages.count
        // Send multiple subagent outputs
        let data1 = ClaudeOutputData(type: "assistant", content: "Result 1")
        let data2 = ClaudeOutputData(type: "tool", content: "Tool output", tool: "Bash")
        coordinator.webSocketDidReceiveMessage(.subagentOutput(agentId: "a1", sessionId: nil, data: data1))
        coordinator.webSocketDidReceiveMessage(.subagentOutput(agentId: "a1", sessionId: nil, data: data2))
        #expect(state.messages.count == initialCount)
    }

    @MainActor
    @Test("subagentOutput routes permission_request to prompt queue (server auto-approve fallback)")
    func subagentOutputRoutesPermission() async throws {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        state.activeSubagents["a1"] = SubagentInfo(description: "Security review", agentType: "general")
        let data = ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-sub-1")
        coordinator.webSocketDidReceiveMessage(.subagentOutput(agentId: "a1", sessionId: nil, data: data))
        // Wait for coalescing timer to flush
        try await Task.sleep(for: .milliseconds(700))
        // Permission_request should be in prompt queue — server broadcasts as fallback when auto-approve fails
        #expect(coordinator.promptService.promptQueue.count == 1)
        if case .permission(let tool, _, _) = coordinator.promptService.currentPrompt?.kind {
            #expect(tool == "Bash")
        } else {
            Issue.record("Expected permission prompt")
        }
        // Agent description should be attached
        #expect(coordinator.promptService.currentPrompt?.agentDescription == "Security review")
    }

    @MainActor
    @Test("subagentOutput routes ask_user_question to prompt queue")
    func subagentOutputRoutesQuestion() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        let questions = [QuestionData(question: "Which approach?", options: [QuestionOption(label: "A")])]
        let data = ClaudeOutputData(type: "ask_user_question", questions: questions)
        coordinator.webSocketDidReceiveMessage(.subagentOutput(agentId: "a1", sessionId: nil, data: data))
        // Questions show immediately
        #expect(coordinator.promptService.promptQueue.count == 1)
        if case .question(let qs) = coordinator.promptService.currentPrompt?.kind {
            #expect(qs[0].question == "Which approach?")
        } else {
            Issue.record("Expected question prompt")
        }
    }

    @MainActor
    @Test("session switch clears prompt queue")
    func sessionSwitchClearsPromptQueue() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        // Add a question prompt to the queue
        let questions = [QuestionData(question: "test")]
        coordinator.promptService.handleClaudeOutput(ClaudeOutputData(type: "ask_user_question", questions: questions))
        #expect(coordinator.promptService.promptQueue.count == 1)

        // Switch session
        coordinator.watchSession("new-session")
        #expect(coordinator.promptService.promptQueue.isEmpty)
    }

    @MainActor
    @Test("two subagents full lifecycle: starting → start → tool → stop")
    func twoSubagentsFullLifecycle() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)

        // Both start
        coordinator.webSocketDidReceiveMessage(.subagentStarting(description: "Security review", agentType: "Plan"))
        coordinator.webSocketDidReceiveMessage(.subagentStarting(description: "Code analysis", agentType: "Explore"))
        #expect(state.messages.count == 2)
        #expect(state.messages[0].subagentStatus == "starting")
        #expect(state.messages[1].subagentStatus == "starting")
        #expect(state.pendingSubagentMessages.count == 2)

        // Both correlate
        coordinator.webSocketDidReceiveMessage(.subagentStart(agentId: "a1", sessionId: nil, description: "Security review", agentType: "Plan", teamName: nil, memberName: nil))
        coordinator.webSocketDidReceiveMessage(.subagentStart(agentId: "a2", sessionId: nil, description: "Code analysis", agentType: "Explore", teamName: nil, memberName: nil))
        #expect(state.messages[0].subagentStatus == "running")
        #expect(state.messages[0].subagentAgentId == "a1")
        #expect(state.messages[1].subagentStatus == "running")
        #expect(state.messages[1].subagentAgentId == "a2")
        #expect(state.pendingSubagentMessages.isEmpty)

        // Tool updates on each
        coordinator.webSocketDidReceiveMessage(.subagentTool(agentId: "a1", tool: "Grep", input: nil))
        coordinator.webSocketDidReceiveMessage(.subagentTool(agentId: "a2", tool: "Read", input: nil))
        #expect(state.messages[0].subagentCurrentTool == "Grep")
        #expect(state.messages[1].subagentCurrentTool == "Read")

        // Outputs suppressed — message count stays at 2
        let output1 = ClaudeOutputData(type: "assistant", content: "Found vulnerability")
        let output2 = ClaudeOutputData(type: "assistant", content: "Code looks clean")
        coordinator.webSocketDidReceiveMessage(.subagentOutput(agentId: "a1", sessionId: nil, data: output1))
        coordinator.webSocketDidReceiveMessage(.subagentOutput(agentId: "a2", sessionId: nil, data: output2))
        #expect(state.messages.count == 2)

        // a2 finishes first
        coordinator.webSocketDidReceiveMessage(.subagentStop(agentId: "a2"))
        #expect(state.messages[1].subagentStatus == "completed")
        #expect(state.messages[1].subagentCurrentTool == nil)
        #expect(state.messages[0].subagentStatus == "running")  // a1 still running

        // a1 gets another tool update then finishes
        coordinator.webSocketDidReceiveMessage(.subagentTool(agentId: "a1", tool: "Bash", input: nil))
        #expect(state.messages[0].subagentCurrentTool == "Bash")
        coordinator.webSocketDidReceiveMessage(.subagentStop(agentId: "a1"))
        #expect(state.messages[0].subagentStatus == "completed")
        #expect(state.messages[0].subagentCurrentTool == nil)

        // Both tracked in activeSubagents as completed
        #expect(state.activeSubagents["a1"]?.status == "completed")
        #expect(state.activeSubagents["a2"]?.status == "completed")

        // Still only 2 messages total — no output noise
        #expect(state.messages.count == 2)
    }

    @MainActor
    @Test("subagent_starting via claude_output creates card with status and registers for correlation")
    func subagentStartingViaClaudeOutput() {
        let state = AppState()
        state.confirmSessionSwitch(sessionId: "s1")
        let coordinator = AppCoordinator(state: state)
        // Simulate subagent_starting arriving as claude_output (older server / history fallback)
        let data = ClaudeOutputData(type: "subagent_starting", content: "Security review", tool: "Plan")
        coordinator.webSocketDidReceiveMessage(.claudeOutput(sessionId: "s1", data: data))
        #expect(state.messages.count == 1)
        #expect(state.messages[0].type == .subagentStarting)
        #expect(state.messages[0].content == "Security review")
        #expect(state.messages[0].tool == "Plan")
        #expect(state.messages[0].subagentStatus == "starting")
        // Should be registered for correlation
        #expect(state.pendingSubagentMessages.count == 1)
        #expect(state.pendingSubagentMessages[0].description == "Security review")
    }

    @MainActor
    @Test("subagent_starting via claude_output correlates with subsequent subagent_start")
    func subagentStartingViaClaudeOutputCorrelation() {
        let state = AppState()
        state.confirmSessionSwitch(sessionId: "s1")
        let coordinator = AppCoordinator(state: state)
        // subagent_starting via claude_output
        let data = ClaudeOutputData(type: "subagent_starting", content: "Research code", tool: "Explore")
        coordinator.webSocketDidReceiveMessage(.claudeOutput(sessionId: "s1", data: data))
        // subagent_start correlates
        coordinator.webSocketDidReceiveMessage(.subagentStart(agentId: "a1", sessionId: nil, description: "Research code", agentType: "Explore", teamName: nil, memberName: nil))
        #expect(state.subagentMessageMap["a1"] == 0)
        #expect(state.messages[0].subagentStatus == "running")
        #expect(state.messages[0].subagentAgentId == "a1")
        #expect(state.pendingSubagentMessages.isEmpty)
        // Tool update should propagate
        coordinator.webSocketDidReceiveMessage(.subagentTool(agentId: "a1", tool: "Read", input: nil))
        #expect(state.messages[0].subagentCurrentTool == "Read")
        // Stop should complete the card
        coordinator.webSocketDidReceiveMessage(.subagentStop(agentId: "a1"))
        #expect(state.messages[0].subagentStatus == "completed")
        #expect(state.messages[0].subagentCurrentTool == nil)
    }

    // MARK: - Mode Change

    @MainActor
    @Test("modeChange updates sessionMode")
    func modeChangeUpdatesMode() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        #expect(state.sessionMode == .defaultMode)
        coordinator.webSocketDidReceiveMessage(.modeChange(sessionId: nil, mode: "plan"))
        #expect(state.sessionMode == .plan)
    }

    @MainActor
    @Test("modeChange to acceptEdits")
    func modeChangeAcceptEdits() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        coordinator.webSocketDidReceiveMessage(.modeChange(sessionId: nil, mode: "acceptEdits"))
        #expect(state.sessionMode == .acceptEdits)
        #expect(state.sessionMode.label == "Accept Edits")
    }

    @MainActor
    @Test("modeChange ignores different session")
    func modeChangeIgnoresDifferentSession() {
        let state = AppState()
        state.confirmSessionSwitch(sessionId: "sess-1")
        let coordinator = AppCoordinator(state: state)
        coordinator.webSocketDidReceiveMessage(.modeChange(sessionId: "sess-2", mode: "plan"))
        #expect(state.sessionMode == .defaultMode)
    }

    @MainActor
    @Test("modeChange accepts matching session")
    func modeChangeMatchingSession() {
        let state = AppState()
        state.confirmSessionSwitch(sessionId: "sess-1")
        let coordinator = AppCoordinator(state: state)
        coordinator.webSocketDidReceiveMessage(.modeChange(sessionId: "sess-1", mode: "plan"))
        #expect(state.sessionMode == .plan)
    }

    @MainActor
    @Test("modeChange ignores unknown mode string")
    func modeChangeUnknownMode() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        coordinator.webSocketDidReceiveMessage(.modeChange(sessionId: nil, mode: "nonexistent"))
        #expect(state.sessionMode == .defaultMode)
    }

    @MainActor
    @Test("modeToggleResult does not advance mode optimistically")
    func modeToggleResultNoOptimistic() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        #expect(state.sessionMode == .defaultMode)
        coordinator.webSocketDidReceiveMessage(.modeToggleResult(success: true, error: nil))
        // Mode should NOT change — it waits for server mode_change
        #expect(state.sessionMode == .defaultMode)
    }

    @MainActor
    @Test("modeToggleResult failure shows toast")
    func modeToggleResultFailure() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        coordinator.webSocketDidReceiveMessage(.modeToggleResult(success: false, error: "TTY not found"))
        #expect(state.currentToast?.message == "TTY not found")
        #expect(state.currentToast?.style == .warning)
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

    // MARK: - History + Status Ordering (#35)

    @MainActor
    @Test("history arrives before session_status: prompts recover when status later becomes waiting")
    func historyBeforeStatusRecovery() {
        // Reproduces #35: history arrives first (status still .idle), then session_status = waiting
        let state = AppState()
        state.confirmSessionSwitch(sessionId: "s1")
        let coordinator = AppCoordinator(state: state)

        // Step 1: history arrives — includes unanswered permission_request
        let historyData: [ClaudeOutputData] = [
            ClaudeOutputData(type: "assistant", content: "Let me run that"),
            ClaudeOutputData(type: "permission_request", tool: "Bash",
                            input: ["command": .string("git status")], toolUseId: "tu-1"),
        ]
        coordinator.webSocketDidReceiveMessage(.history(sessionId: "s1", data: historyData))

        // At this point status is still .idle — recoverFromHistory should not restore yet
        #expect(coordinator.promptService.promptQueue.isEmpty,
                "Prompt should not appear before session status is known")

        // Step 2: session_status = waiting arrives (normal server ordering)
        coordinator.webSocketDidReceiveMessage(.sessionStatus(sessionId: "s1", status: "waiting", lastActive: nil))

        // Now the prompt should be recovered
        #expect(coordinator.promptService.promptQueue.count == 1,
                "Permission should be recovered after session_status = waiting")
        if case .permission(let tool, _, _) = coordinator.promptService.currentPrompt?.kind {
            #expect(tool == "Bash")
        } else {
            Issue.record("Expected Bash permission to be recovered")
        }
    }

    @MainActor
    @Test("history arrives before claude_state: prompts recover when claude_state reports waiting")
    func historyBeforeClaudeStateRecovery() {
        let state = AppState()
        state.confirmSessionSwitch(sessionId: "s1")
        let coordinator = AppCoordinator(state: state)

        // History arrives first
        let historyData: [ClaudeOutputData] = [
            ClaudeOutputData(type: "permission_request", tool: "Write", toolUseId: "tu-2"),
        ]
        coordinator.webSocketDidReceiveMessage(.history(sessionId: "s1", data: historyData))
        #expect(coordinator.promptService.promptQueue.isEmpty)

        // claude_state reports waiting status
        let claudeState = ClaudeState(session: nil, status: "waiting", mode: nil,
                                       contextPercentage: nil, permissions: nil, subagents: nil,
                                       tasks: nil, lastActivity: nil, team: nil)
        coordinator.webSocketDidReceiveMessage(.claudeState(sessionId: "s1", state: claudeState))

        #expect(coordinator.promptService.promptQueue.count == 1,
                "Permission should be recovered via claude_state status=waiting")
        if case .permission(let tool, _, _) = coordinator.promptService.currentPrompt?.kind {
            #expect(tool == "Write")
        } else {
            Issue.record("Expected Write permission to be recovered")
        }
    }

    @MainActor
    @Test("session_status waiting when no pending prompts in history: does not add spurious prompts")
    func sessionStatusWaitingNoPrompts() {
        let state = AppState()
        state.confirmSessionSwitch(sessionId: "s1")
        let coordinator = AppCoordinator(state: state)

        // History with only answered permission (tool_result follows)
        let historyData: [ClaudeOutputData] = [
            ClaudeOutputData(type: "permission_request", tool: "Bash", toolUseId: "tu-1"),
            ClaudeOutputData(type: "tool_result", content: "done", toolUseId: "tu-1"),
        ]
        coordinator.webSocketDidReceiveMessage(.history(sessionId: "s1", data: historyData))

        // session_status = waiting arrives
        coordinator.webSocketDidReceiveMessage(.sessionStatus(sessionId: "s1", status: "waiting", lastActive: nil))

        // No prompts should appear (the permission was answered)
        #expect(coordinator.promptService.promptQueue.isEmpty,
                "No prompt should be recovered for answered permission")
    }
}
