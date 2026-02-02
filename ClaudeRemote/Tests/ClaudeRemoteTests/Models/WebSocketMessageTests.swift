import Testing
import Foundation
@testable import ClaudeRemote

@Suite("ServerMessage Decoding")
struct ServerMessageDecodingTests {

    private func decode(_ json: String) throws -> ServerMessage {
        let data = json.data(using: .utf8)!
        return try JSONDecoder().decode(ServerMessage.self, from: data)
    }

    // MARK: - auth_result

    @Test("Decode auth_result success")
    func authResultSuccess() throws {
        let msg = try decode("""
        {"type": "auth_result", "success": true}
        """)
        guard case .authResult(let success, let error) = msg else {
            Issue.record("Expected authResult")
            return
        }
        #expect(success == true)
        #expect(error == nil)
    }

    @Test("Decode auth_result failure")
    func authResultFailure() throws {
        let msg = try decode("""
        {"type": "auth_result", "success": false, "error": "Invalid token"}
        """)
        guard case .authResult(let success, let error) = msg else {
            Issue.record("Expected authResult")
            return
        }
        #expect(success == false)
        #expect(error == "Invalid token")
    }

    // MARK: - sessions

    @Test("Decode sessions list")
    func sessionsList() throws {
        let msg = try decode("""
        {
            "type": "sessions",
            "data": [
                {
                    "id": "sess-1",
                    "name": "my-project",
                    "status": "waiting",
                    "cwd": "/Users/test/project",
                    "branch": "main",
                    "lastActive": "2026-01-30T10:00:00Z",
                    "tty": "/dev/ttys004",
                    "pid": 1234
                },
                {
                    "id": "sess-2",
                    "name": "other-project",
                    "status": "idle"
                }
            ]
        }
        """)
        guard case .sessions(let data) = msg else {
            Issue.record("Expected sessions")
            return
        }
        #expect(data.count == 2)
        #expect(data[0].id == "sess-1")
        #expect(data[0].name == "my-project")
        #expect(data[0].status == .waiting)
        #expect(data[0].branch == "main")
        #expect(data[1].id == "sess-2")
        #expect(data[1].status == .idle)
    }

    @Test("Decode empty sessions list")
    func emptySessionsList() throws {
        let msg = try decode("""
        {"type": "sessions", "data": []}
        """)
        guard case .sessions(let data) = msg else {
            Issue.record("Expected sessions")
            return
        }
        #expect(data.isEmpty)
    }

    // MARK: - watching

    @Test("Decode watching confirmation")
    func watchingConfirmation() throws {
        let msg = try decode("""
        {
            "type": "watching",
            "sessionId": "sess-1",
            "session": {
                "id": "sess-1",
                "name": "my-project",
                "status": "waiting",
                "branch": "feat/test"
            }
        }
        """)
        guard case .watching(let sessionId, let session) = msg else {
            Issue.record("Expected watching")
            return
        }
        #expect(sessionId == "sess-1")
        #expect(session.name == "my-project")
        #expect(session.branch == "feat/test")
    }

    // MARK: - history

    @Test("Decode history with messages")
    func historyMessages() throws {
        let msg = try decode("""
        {
            "type": "history",
            "sessionId": "sess-1",
            "data": [
                {"type": "assistant", "content": "Hello!"},
                {"type": "user", "content": "Hi there"},
                {"type": "tool", "tool": "Bash", "input": {"command": "ls"}}
            ]
        }
        """)
        guard case .history(let sessionId, let data) = msg else {
            Issue.record("Expected history")
            return
        }
        #expect(sessionId == "sess-1")
        #expect(data.count == 3)
        #expect(data[0].type == "assistant")
        #expect(data[0].content == "Hello!")
        #expect(data[1].type == "user")
        #expect(data[1].content == "Hi there")
        #expect(data[2].type == "tool")
        #expect(data[2].tool == "Bash")
        #expect(data[2].input?["command"]?.stringValue == "ls")
    }

    @Test("Decode empty history")
    func emptyHistory() throws {
        let msg = try decode("""
        {"type": "history", "sessionId": "sess-1", "data": []}
        """)
        guard case .history(let sessionId, let data) = msg else {
            Issue.record("Expected history")
            return
        }
        #expect(sessionId == "sess-1")
        #expect(data.isEmpty)
    }

    // MARK: - claude_output

    @Test("Decode claude_output with assistant message")
    func claudeOutputAssistant() throws {
        let msg = try decode("""
        {
            "type": "claude_output",
            "sessionId": "sess-1",
            "data": {"type": "assistant", "content": "Here's the answer."}
        }
        """)
        guard case .claudeOutput(let sessionId, let data) = msg else {
            Issue.record("Expected claudeOutput")
            return
        }
        #expect(sessionId == "sess-1")
        #expect(data.type == "assistant")
        #expect(data.content == "Here's the answer.")
    }

    @Test("Decode claude_output with tool message")
    func claudeOutputTool() throws {
        let msg = try decode("""
        {
            "type": "claude_output",
            "sessionId": "sess-1",
            "data": {
                "type": "tool",
                "tool": "Read",
                "input": {"file_path": "/tmp/test.txt"}
            }
        }
        """)
        guard case .claudeOutput(_, let data) = msg else {
            Issue.record("Expected claudeOutput")
            return
        }
        #expect(data.type == "tool")
        #expect(data.tool == "Read")
        #expect(data.input?["file_path"]?.stringValue == "/tmp/test.txt")
    }

    @Test("Decode claude_output with tool_result")
    func claudeOutputToolResult() throws {
        let msg = try decode("""
        {
            "type": "claude_output",
            "sessionId": "sess-1",
            "data": {
                "type": "tool_result",
                "content": "file contents here",
                "language": "swift"
            }
        }
        """)
        guard case .claudeOutput(_, let data) = msg else {
            Issue.record("Expected claudeOutput")
            return
        }
        #expect(data.type == "tool_result")
        #expect(data.content == "file contents here")
        #expect(data.language == "swift")
    }

    @Test("Decode claude_output with user message")
    func claudeOutputUser() throws {
        let msg = try decode("""
        {
            "type": "claude_output",
            "sessionId": "sess-1",
            "data": {"type": "user", "content": "hello"}
        }
        """)
        guard case .claudeOutput(_, let data) = msg else {
            Issue.record("Expected claudeOutput")
            return
        }
        #expect(data.type == "user")
        #expect(data.content == "hello")
    }

    @Test("Decode claude_output with status_update")
    func claudeOutputStatusUpdate() throws {
        let msg = try decode("""
        {
            "type": "claude_output",
            "sessionId": "sess-1",
            "data": {"type": "status_update", "status": "processing"}
        }
        """)
        guard case .claudeOutput(_, let data) = msg else {
            Issue.record("Expected claudeOutput")
            return
        }
        #expect(data.type == "status_update")
        #expect(data.status == "processing")
    }

    @Test("Decode claude_output with permission_request")
    func claudeOutputPermissionRequest() throws {
        let msg = try decode("""
        {
            "type": "claude_output",
            "sessionId": "sess-1",
            "data": {
                "type": "permission_request",
                "tool": "Bash",
                "input": {"command": "rm -rf /tmp/test"}
            }
        }
        """)
        guard case .claudeOutput(_, let data) = msg else {
            Issue.record("Expected claudeOutput")
            return
        }
        #expect(data.type == "permission_request")
        #expect(data.tool == "Bash")
        #expect(data.input?["command"]?.stringValue == "rm -rf /tmp/test")
    }

    @Test("Decode claude_output with ask_user_question")
    func claudeOutputAskUserQuestion() throws {
        let msg = try decode("""
        {
            "type": "claude_output",
            "sessionId": "sess-1",
            "data": {
                "type": "ask_user_question",
                "questions": [
                    {
                        "question": "Which approach?",
                        "header": "Approach",
                        "options": [
                            {"label": "Option A", "description": "First approach"},
                            {"label": "Option B", "description": "Second approach"}
                        ],
                        "multiSelect": false
                    }
                ]
            }
        }
        """)
        guard case .claudeOutput(_, let data) = msg else {
            Issue.record("Expected claudeOutput")
            return
        }
        #expect(data.type == "ask_user_question")
        #expect(data.questions?.count == 1)
        #expect(data.questions?[0].question == "Which approach?")
        #expect(data.questions?[0].options?.count == 2)
        #expect(data.questions?[0].options?[0].label == "Option A")
        #expect(data.questions?[0].multiSelect == false)
    }

    // MARK: - session_status

    @Test("Decode session_status")
    func sessionStatus() throws {
        let msg = try decode("""
        {
            "type": "session_status",
            "sessionId": "sess-1",
            "status": "processing",
            "lastActive": "2026-01-30T10:00:00Z"
        }
        """)
        guard case .sessionStatus(let sessionId, let status, let lastActive) = msg else {
            Issue.record("Expected sessionStatus")
            return
        }
        #expect(sessionId == "sess-1")
        #expect(status == "processing")
        #expect(lastActive == "2026-01-30T10:00:00Z")
    }

    @Test("Decode session_status without lastActive")
    func sessionStatusNoLastActive() throws {
        let msg = try decode("""
        {"type": "session_status", "sessionId": "sess-1", "status": "idle"}
        """)
        guard case .sessionStatus(_, _, let lastActive) = msg else {
            Issue.record("Expected sessionStatus")
            return
        }
        #expect(lastActive == nil)
    }

    // MARK: - status_update (top-level)

    @Test("Decode top-level status_update")
    func statusUpdate() throws {
        let msg = try decode("""
        {"type": "status_update", "status": "waiting"}
        """)
        guard case .statusUpdate(let status) = msg else {
            Issue.record("Expected statusUpdate")
            return
        }
        #expect(status == "waiting")
    }

    // MARK: - token_usage

    @Test("Decode token_usage")
    func tokenUsage() throws {
        let msg = try decode("""
        {"type": "token_usage", "input": 1500, "output": 300}
        """)
        guard case .tokenUsage(let sessionId, let input, let output) = msg else {
            Issue.record("Expected tokenUsage")
            return
        }
        #expect(sessionId == nil)
        #expect(input == 1500)
        #expect(output == 300)
    }

    @Test("Decode token_usage with sessionId")
    func tokenUsageWithSessionId() throws {
        let msg = try decode("""
        {"type": "token_usage", "sessionId": "sess-1", "input": 150000, "output": 5000}
        """)
        guard case .tokenUsage(let sessionId, let input, let output) = msg else {
            Issue.record("Expected tokenUsage")
            return
        }
        #expect(sessionId == "sess-1")
        #expect(input == 150000)
        #expect(output == 5000)
    }

    // MARK: - context_percentage

    @Test("Decode context_percentage")
    func contextPercentage() throws {
        let msg = try decode("""
        {"type": "context_percentage", "sessionId": "sess-1", "percentage": 42}
        """)
        guard case .contextPercentage(let sessionId, let percentage) = msg else {
            Issue.record("Expected contextPercentage")
            return
        }
        #expect(sessionId == "sess-1")
        #expect(percentage == 42)
    }

    @Test("Decode context_percentage without sessionId")
    func contextPercentageNoSessionId() throws {
        let msg = try decode("""
        {"type": "context_percentage", "percentage": 85}
        """)
        guard case .contextPercentage(let sessionId, let percentage) = msg else {
            Issue.record("Expected contextPercentage")
            return
        }
        #expect(sessionId == nil)
        #expect(percentage == 85)
    }

    // MARK: - task_create

    @Test("Decode task_create")
    func taskCreate() throws {
        let msg = try decode("""
        {
            "type": "task_create",
            "id": "task-1",
            "subject": "Fix the bug",
            "description": "There's a bug in auth",
            "activeForm": "Fixing the bug",
            "status": "pending"
        }
        """)
        guard case .taskCreate(let id, let subject, let description, let activeForm, let status) = msg else {
            Issue.record("Expected taskCreate")
            return
        }
        #expect(id == "task-1")
        #expect(subject == "Fix the bug")
        #expect(description == "There's a bug in auth")
        #expect(activeForm == "Fixing the bug")
        #expect(status == "pending")
    }

    // MARK: - task_update

    @Test("Decode task_update")
    func taskUpdate() throws {
        let msg = try decode("""
        {"type": "task_update", "taskId": "task-1", "status": "completed", "subject": "Fixed the bug", "activeForm": "Fixing bug", "description": "Fix the login bug"}
        """)
        guard case .taskUpdate(let taskId, let status, let subject, let activeForm, let description) = msg else {
            Issue.record("Expected taskUpdate")
            return
        }
        #expect(taskId == "task-1")
        #expect(status == "completed")
        #expect(subject == "Fixed the bug")
        #expect(activeForm == "Fixing bug")
        #expect(description == "Fix the login bug")
    }

    // MARK: - task_list

    @Test("Decode task_list")
    func taskList() throws {
        let msg = try decode("""
        {
            "type": "task_list",
            "tasks": [
                {"id": "1", "subject": "Task A", "status": "completed"},
                {"id": "2", "subject": "Task B", "status": "in_progress", "activeForm": "Working on B"}
            ]
        }
        """)
        guard case .taskList(let tasks) = msg else {
            Issue.record("Expected taskList")
            return
        }
        #expect(tasks.count == 2)
        #expect(tasks[0].id == "1")
        #expect(tasks[0].subject == "Task A")
        #expect(tasks[1].activeForm == "Working on B")
    }

    // MARK: - subagent messages

    @Test("Decode subagent_starting")
    func subagentStarting() throws {
        let msg = try decode("""
        {"type": "subagent_starting", "description": "Exploring codebase", "agentType": "Explore"}
        """)
        guard case .subagentStarting(let description, let agentType) = msg else {
            Issue.record("Expected subagentStarting")
            return
        }
        #expect(description == "Exploring codebase")
        #expect(agentType == "Explore")
    }

    @Test("Decode subagent_start")
    func subagentStart() throws {
        let msg = try decode("""
        {
            "type": "subagent_start",
            "agentId": "agent-abc",
            "sessionId": "sess-1",
            "description": "Exploring codebase",
            "agentType": "Explore"
        }
        """)
        guard case .subagentStart(let agentId, let sessionId, let description, let agentType) = msg else {
            Issue.record("Expected subagentStart")
            return
        }
        #expect(agentId == "agent-abc")
        #expect(sessionId == "sess-1")
        #expect(description == "Exploring codebase")
        #expect(agentType == "Explore")
    }

    @Test("Decode subagent_output")
    func subagentOutput() throws {
        let msg = try decode("""
        {
            "type": "subagent_output",
            "agentId": "agent-abc",
            "sessionId": "sess-1",
            "data": {"type": "assistant", "content": "Found the file"}
        }
        """)
        guard case .subagentOutput(let agentId, _, let data) = msg else {
            Issue.record("Expected subagentOutput")
            return
        }
        #expect(agentId == "agent-abc")
        #expect(data?.type == "assistant")
        #expect(data?.content == "Found the file")
    }

    @Test("Decode subagent_tool")
    func subagentTool() throws {
        let msg = try decode("""
        {"type": "subagent_tool", "agentId": "agent-abc", "tool": "Read", "input": "/tmp/test.txt"}
        """)
        guard case .subagentTool(let agentId, let tool, let input) = msg else {
            Issue.record("Expected subagentTool")
            return
        }
        #expect(agentId == "agent-abc")
        #expect(tool == "Read")
        #expect(input == "/tmp/test.txt")
    }

    @Test("Decode subagent_tokens")
    func subagentTokens() throws {
        let msg = try decode("""
        {"type": "subagent_tokens", "agentId": "agent-abc", "input": 500, "output": 100}
        """)
        guard case .subagentTokens(let agentId, let input, let output) = msg else {
            Issue.record("Expected subagentTokens")
            return
        }
        #expect(agentId == "agent-abc")
        #expect(input == 500)
        #expect(output == 100)
    }

    @Test("Decode subagent_stop")
    func subagentStop() throws {
        let msg = try decode("""
        {"type": "subagent_stop", "agentId": "agent-abc"}
        """)
        guard case .subagentStop(let agentId) = msg else {
            Issue.record("Expected subagentStop")
            return
        }
        #expect(agentId == "agent-abc")
    }

    // MARK: - inject_result

    @Test("Decode inject_result success")
    func injectResultSuccess() throws {
        let msg = try decode("""
        {"type": "inject_result", "success": true}
        """)
        guard case .injectResult(let success, let error) = msg else {
            Issue.record("Expected injectResult")
            return
        }
        #expect(success == true)
        #expect(error == nil)
    }

    @Test("Decode inject_result failure")
    func injectResultFailure() throws {
        let msg = try decode("""
        {"type": "inject_result", "success": false, "error": "TTY not found"}
        """)
        guard case .injectResult(let success, let error) = msg else {
            Issue.record("Expected injectResult")
            return
        }
        #expect(success == false)
        #expect(error == "TTY not found")
    }

    // MARK: - escape_result

    @Test("Decode escape_result")
    func escapeResult() throws {
        let msg = try decode("""
        {"type": "escape_result", "success": true}
        """)
        guard case .escapeResult(let success, _) = msg else {
            Issue.record("Expected escapeResult")
            return
        }
        #expect(success == true)
    }

    // MARK: - mode_toggle_result

    @Test("Decode mode_toggle_result")
    func modeToggleResult() throws {
        let msg = try decode("""
        {"type": "mode_toggle_result", "success": true}
        """)
        guard case .modeToggleResult(let success, _) = msg else {
            Issue.record("Expected modeToggleResult")
            return
        }
        #expect(success == true)
    }

    // MARK: - mode_change

    @Test("Decode mode_change")
    func modeChange() throws {
        let msg = try decode("""
        {"type": "mode_change", "sessionId": "sess-1", "mode": "plan"}
        """)
        guard case .modeChange(let sessionId, let mode) = msg else {
            Issue.record("Expected modeChange")
            return
        }
        #expect(sessionId == "sess-1")
        #expect(mode == "plan")
    }

    @Test("Decode mode_change without sessionId")
    func modeChangeNoSessionId() throws {
        let msg = try decode("""
        {"type": "mode_change", "mode": "acceptEdits"}
        """)
        guard case .modeChange(let sessionId, let mode) = msg else {
            Issue.record("Expected modeChange")
            return
        }
        #expect(sessionId == nil)
        #expect(mode == "acceptEdits")
    }

    // MARK: - error

    @Test("Decode error message")
    func errorMessage() throws {
        let msg = try decode("""
        {
            "type": "error",
            "code": "RATE_LIMITED",
            "message": "Rate limit exceeded",
            "details": {"limit": 60, "window": "minute"}
        }
        """)
        guard case .error(let code, let message, let details) = msg else {
            Issue.record("Expected error")
            return
        }
        #expect(code == "RATE_LIMITED")
        #expect(message == "Rate limit exceeded")
        #expect(details?["limit"]?.intValue == 60)
        #expect(details?["window"]?.stringValue == "minute")
    }

    @Test("Decode error without details")
    func errorWithoutDetails() throws {
        let msg = try decode("""
        {"type": "error", "code": "UNAUTHORIZED", "message": "Not authenticated"}
        """)
        guard case .error(let code, let message, let details) = msg else {
            Issue.record("Expected error")
            return
        }
        #expect(code == "UNAUTHORIZED")
        #expect(message == "Not authenticated")
        #expect(details == nil)
    }

    // MARK: - pong

    @Test("Decode pong")
    func pong() throws {
        let msg = try decode("""
        {"type": "pong", "timestamp": 1706612400000}
        """)
        guard case .pong(let timestamp) = msg else {
            Issue.record("Expected pong")
            return
        }
        #expect(timestamp == 1706612400000)
    }

    // MARK: - state

    @Test("Decode state")
    func state() throws {
        let msg = try decode("""
        {
            "type": "state",
            "clientId": "client-123",
            "watchingSessions": ["sess-1", "sess-2"],
            "settings": {"ttsEnabled": true}
        }
        """)
        guard case .state(let clientId, let watchingSessions, let settings) = msg else {
            Issue.record("Expected state")
            return
        }
        #expect(clientId == "client-123")
        #expect(watchingSessions == ["sess-1", "sess-2"])
        #expect(settings?["ttsEnabled"]?.boolValue == true)
    }

    // MARK: - unknown / forward-compat

    @Test("Decode unknown message type as .unknown")
    func unknownType() throws {
        let msg = try decode("""
        {"type": "future_feature", "someField": "someValue"}
        """)
        guard case .unknown(let type, _) = msg else {
            Issue.record("Expected unknown")
            return
        }
        #expect(type == "future_feature")
    }
}

@Suite("ClientAction Encoding")
struct ClientActionEncodingTests {

    @Test("Encode auth action")
    func encodeAuth() throws {
        let action = ClientAction.auth(token: "secret-token")
        let json = action.toJSON()
        #expect(json["action"] as? String == "auth")
        #expect(json["token"] as? String == "secret-token")
    }

    @Test("Encode watch_session action")
    func encodeWatchSession() throws {
        let action = ClientAction.watchSession(sessionId: "sess-1")
        let json = action.toJSON()
        #expect(json["action"] as? String == "watch_session")
        #expect(json["sessionId"] as? String == "sess-1")
    }

    @Test("Encode unwatch_session action")
    func encodeUnwatchSession() throws {
        let action = ClientAction.unwatchSession(sessionId: "sess-1")
        let json = action.toJSON()
        #expect(json["action"] as? String == "unwatch_session")
        #expect(json["sessionId"] as? String == "sess-1")
    }

    @Test("Encode refresh_sessions action")
    func encodeRefreshSessions() throws {
        let action = ClientAction.refreshSessions
        let json = action.toJSON()
        #expect(json["action"] as? String == "refresh_sessions")
    }

    @Test("Encode inject action")
    func encodeInject() throws {
        let action = ClientAction.inject(command: "hello world", sessionId: "sess-1")
        let json = action.toJSON()
        #expect(json["action"] as? String == "inject")
        #expect(json["command"] as? String == "hello world")
        #expect(json["sessionId"] as? String == "sess-1")
    }

    @Test("Encode escape action")
    func encodeEscape() throws {
        let action = ClientAction.escape(sessionId: "sess-1")
        let json = action.toJSON()
        #expect(json["action"] as? String == "escape")
        #expect(json["sessionId"] as? String == "sess-1")
    }

    @Test("Encode mode_toggle action")
    func encodeModeToggle() throws {
        let action = ClientAction.modeToggle(sessionId: "sess-1")
        let json = action.toJSON()
        #expect(json["action"] as? String == "mode_toggle")
        #expect(json["sessionId"] as? String == "sess-1")
    }

    @Test("Encode ping action")
    func encodePing() throws {
        let action = ClientAction.ping
        let json = action.toJSON()
        #expect(json["action"] as? String == "ping")
    }

    @Test("Encode update_settings action")
    func encodeUpdateSettings() throws {
        let settings: [String: AnyCodableValue] = [
            "ttsEnabled": .bool(true),
            "speechRate": .double(1.5)
        ]
        let action = ClientAction.updateSettings(settings: settings)
        let json = action.toJSON()
        #expect(json["action"] as? String == "update_settings")
        let s = json["settings"] as? [String: Any]
        #expect(s?["ttsEnabled"] as? Bool == true)
        #expect(s?["speechRate"] as? Double == 1.5)
    }

    @Test("ClientAction toData produces valid JSON")
    func toDataProducesValidJSON() throws {
        let action = ClientAction.inject(command: "test", sessionId: "s1")
        let data = try action.toData()
        let parsed = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        #expect(parsed?["action"] as? String == "inject")
        #expect(parsed?["command"] as? String == "test")
    }
}

@Suite("QuestionData / TaskItem Decoding")
struct SupportTypeTests {

    @Test("Decode QuestionData with all fields")
    func decodeFullQuestion() throws {
        let json = """
        {
            "question": "Pick one",
            "header": "Choice",
            "options": [
                {"label": "A", "description": "First", "value": "a"},
                {"label": "B", "description": "Second", "value": "b"}
            ],
            "multiSelect": true
        }
        """.data(using: .utf8)!
        let q = try JSONDecoder().decode(QuestionData.self, from: json)
        #expect(q.question == "Pick one")
        #expect(q.header == "Choice")
        #expect(q.options?.count == 2)
        #expect(q.options?[0].label == "A")
        #expect(q.options?[0].value == "a")
        #expect(q.multiSelect == true)
    }

    @Test("Decode QuestionData minimal")
    func decodeMinimalQuestion() throws {
        let json = """
        {"question": "Yes or no?"}
        """.data(using: .utf8)!
        let q = try JSONDecoder().decode(QuestionData.self, from: json)
        #expect(q.question == "Yes or no?")
        #expect(q.header == nil)
        #expect(q.options == nil)
        #expect(q.multiSelect == nil)
    }

    @Test("Decode TaskItem")
    func decodeTaskItem() throws {
        let json = """
        {
            "id": "42",
            "subject": "Write tests",
            "status": "in_progress",
            "description": "Write comprehensive tests",
            "activeForm": "Writing tests"
        }
        """.data(using: .utf8)!
        let task = try JSONDecoder().decode(TaskItem.self, from: json)
        #expect(task.id == "42")
        #expect(task.subject == "Write tests")
        #expect(task.status == "in_progress")
        #expect(task.description == "Write comprehensive tests")
        #expect(task.activeForm == "Writing tests")
    }

    @Test("Decode TaskItem minimal")
    func decodeMinimalTaskItem() throws {
        let json = "{}".data(using: .utf8)!
        let task = try JSONDecoder().decode(TaskItem.self, from: json)
        #expect(task.id == nil)
        #expect(task.subject == nil)
    }
}

@Suite("ClaudeOutputData.isLocalCommand")
struct IsLocalCommandTests {

    @Test("Detects command-name tag")
    func commandNameTag() {
        let data = ClaudeOutputData(type: "user", content: "<command-name>/compact</command-name>")
        #expect(data.isLocalCommand == true)
    }

    @Test("Detects command-message tag")
    func commandMessageTag() {
        let data = ClaudeOutputData(type: "user", content: "<command-message>compact</command-message>")
        #expect(data.isLocalCommand == true)
    }

    @Test("Detects mixed command tags")
    func mixedCommandTags() {
        let data = ClaudeOutputData(type: "user", content: "<command-name>/help</command-name><command-message>help</command-message>")
        #expect(data.isLocalCommand == true)
    }

    @Test("Normal user message is not a command")
    func normalUserMessage() {
        let data = ClaudeOutputData(type: "user", content: "Hello, how are you?")
        #expect(data.isLocalCommand == false)
    }

    @Test("Assistant message with command tags is not a command")
    func assistantWithTags() {
        let data = ClaudeOutputData(type: "assistant", content: "The <command-name> tag is used for...")
        #expect(data.isLocalCommand == false)
    }

    @Test("User message with nil content is not a command")
    func nilContent() {
        let data = ClaudeOutputData(type: "user", content: nil)
        #expect(data.isLocalCommand == false)
    }
}
