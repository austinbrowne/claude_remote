import Testing
import Foundation
@testable import ClaudeRemote

@Suite("ToolGroupHelpers")
struct ToolGroupHelpersTests {

    // MARK: - toolSummaryText

    @Test("toolSummaryText returns empty string for no messages")
    func summaryEmpty() {
        let result = ToolGroupHelpers.toolSummaryText(from: [])
        #expect(result == "")
    }

    @Test("toolSummaryText shows single tool without count")
    func summarySingleTool() {
        let messages = [Message(type: .tool, tool: "Read")]
        let result = ToolGroupHelpers.toolSummaryText(from: messages)
        #expect(result == "Read")
    }

    @Test("toolSummaryText shows multiple tools with counts in order")
    func summaryMultipleTools() {
        let messages = [
            Message(type: .tool, tool: "Read"),
            Message(type: .tool, tool: "Edit"),
            Message(type: .tool, tool: "Read"),
            Message(type: .tool, tool: "Bash"),
        ]
        let result = ToolGroupHelpers.toolSummaryText(from: messages)
        #expect(result == "Read (2) · Edit · Bash")
    }

    @Test("toolSummaryText uses 'Tool' for nil tool name")
    func summaryNilToolName() {
        let messages = [Message(type: .tool, tool: nil)]
        let result = ToolGroupHelpers.toolSummaryText(from: messages)
        #expect(result == "Tool")
    }

    @Test("toolSummaryText ignores non-tool messages")
    func summaryIgnoresNonTool() {
        let messages = [
            Message(type: .tool, tool: "Read"),
            Message(type: .assistant, content: "hello"),
            Message(type: .statusUpdate, content: "processing"),
        ]
        let result = ToolGroupHelpers.toolSummaryText(from: messages)
        #expect(result == "Read")
    }

    // MARK: - isToolGroupMessage

    @Test("isToolGroupMessage returns true for tool types")
    func isToolGroupTrueForTools() {
        #expect(ToolGroupHelpers.isToolGroupMessage(Message(type: .tool)) == true)
        #expect(ToolGroupHelpers.isToolGroupMessage(Message(type: .toolResult)) == true)
        #expect(ToolGroupHelpers.isToolGroupMessage(Message(type: .permissionRequest)) == true)
        #expect(ToolGroupHelpers.isToolGroupMessage(Message(type: .statusUpdate)) == true)
    }

    @Test("isToolGroupMessage returns false for non-tool types")
    func isToolGroupFalseForNonTools() {
        #expect(ToolGroupHelpers.isToolGroupMessage(Message(type: .assistant)) == false)
        #expect(ToolGroupHelpers.isToolGroupMessage(Message(type: .user)) == false)
        #expect(ToolGroupHelpers.isToolGroupMessage(Message(type: .tokenUsage)) == false)
    }

    // MARK: - groupMessages

    @Test("groupMessages returns empty for empty input")
    func groupEmpty() {
        let result = ToolGroupHelpers.groupMessages([])
        #expect(result.isEmpty)
    }

    @Test("groupMessages wraps non-tool messages as singles")
    func groupNonToolMessages() {
        let messages = [
            Message(type: .assistant, content: "hello"),
            Message(type: .user, content: "world"),
        ]
        let result = ToolGroupHelpers.groupMessages(messages)
        #expect(result.count == 2)
        if case .single(let msg) = result[0] {
            #expect(msg.type == .assistant)
        } else {
            Issue.record("Expected single")
        }
    }

    @Test("groupMessages groups consecutive tool messages")
    func groupConsecutiveTools() {
        let messages = [
            Message(type: .tool, tool: "Read"),
            Message(type: .tool, tool: "Edit"),
            Message(type: .tool, tool: "Bash"),
        ]
        let result = ToolGroupHelpers.groupMessages(messages)
        #expect(result.count == 1)
        if case .toolGroup(let msgs) = result[0] {
            #expect(msgs.count == 3)
        } else {
            Issue.record("Expected toolGroup")
        }
    }

    @Test("groupMessages breaks group on non-tool message")
    func groupBrokenByAssistant() {
        let messages = [
            Message(type: .tool, tool: "Read"),
            Message(type: .tool, tool: "Edit"),
            Message(type: .assistant, content: "Done"),
            Message(type: .tool, tool: "Bash"),
        ]
        let result = ToolGroupHelpers.groupMessages(messages)
        #expect(result.count == 3) // toolGroup, single assistant, toolGroup
        if case .toolGroup(let first) = result[0] {
            #expect(first.count == 2)
        } else {
            Issue.record("Expected toolGroup")
        }
        if case .single(let mid) = result[1] {
            #expect(mid.type == .assistant)
        } else {
            Issue.record("Expected single")
        }
        if case .toolGroup(let last) = result[2] {
            #expect(last.count == 1)
        } else {
            Issue.record("Expected toolGroup")
        }
    }

    @Test("groupMessages renders single statusUpdate as single, not group")
    func groupSingleStatusUpdate() {
        let messages = [
            Message(type: .statusUpdate, content: "Thinking..."),
        ]
        let result = ToolGroupHelpers.groupMessages(messages)
        #expect(result.count == 1)
        if case .single(let msg) = result[0] {
            #expect(msg.type == .statusUpdate)
        } else {
            Issue.record("Expected single for lone statusUpdate")
        }
    }

    @Test("groupMessages filters out tokenUsage messages")
    func groupFiltersTokenUsage() {
        let messages = [
            Message(type: .assistant, content: "hello"),
            Message(type: .tokenUsage, content: "1000 tokens"),
            Message(type: .assistant, content: "world"),
        ]
        let result = ToolGroupHelpers.groupMessages(messages)
        #expect(result.count == 2) // tokenUsage filtered out
        if case .single(let first) = result[0] {
            #expect(first.content == "hello")
        } else {
            Issue.record("Expected single")
        }
    }

    @Test("groupMessages filters out unknown messages")
    func groupFiltersUnknown() {
        let messages = [
            Message(type: .assistant, content: "hello"),
            Message(type: .unknown, content: "exit_plan_mode"),
            Message(type: .assistant, content: "world"),
        ]
        let result = ToolGroupHelpers.groupMessages(messages)
        #expect(result.count == 2) // unknown filtered out
    }

    @Test("groupMessages does not break tool groups when unknown appears between tools")
    func groupUnknownDoesNotBreakToolGroup() {
        let messages = [
            Message(type: .tool, tool: "Read"),
            Message(type: .unknown, content: "some noise"),
            Message(type: .tool, tool: "Edit"),
        ]
        let result = ToolGroupHelpers.groupMessages(messages)
        // unknown is transparent — skipped entirely, so Read and Edit stay in one group
        #expect(result.count == 1)
        if case .toolGroup(let group) = result[0] {
            #expect(group.count == 2) // Read + Edit together
        } else {
            Issue.record("Expected toolGroup")
        }
    }
}
