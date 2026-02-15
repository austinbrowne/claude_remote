import Testing
import Foundation
@testable import ClaudeRemote

@Suite("ToolCardHelpers")
struct ToolCardHelpersTests {

    // MARK: - toolIcon

    @Test("toolIcon returns correct SF Symbol per tool")
    func toolIconMappings() {
        #expect(ToolCardHelpers.toolIcon(for: "Read") == "doc.text")
        #expect(ToolCardHelpers.toolIcon(for: "Write") == "pencil")
        #expect(ToolCardHelpers.toolIcon(for: "Edit") == "text.badge.plus")
        #expect(ToolCardHelpers.toolIcon(for: "MultiEdit") == "text.badge.plus")
        #expect(ToolCardHelpers.toolIcon(for: "Bash") == "terminal")
        #expect(ToolCardHelpers.toolIcon(for: "Glob") == "folder.badge.questionmark")
        #expect(ToolCardHelpers.toolIcon(for: "Grep") == "magnifyingglass")
        #expect(ToolCardHelpers.toolIcon(for: "WebFetch") == "globe")
        #expect(ToolCardHelpers.toolIcon(for: "WebSearch") == "magnifyingglass.circle")
        #expect(ToolCardHelpers.toolIcon(for: "Task") == "person.2")
    }

    @Test("toolIcon returns wrench for unknown tools")
    func toolIconUnknown() {
        #expect(ToolCardHelpers.toolIcon(for: "CustomTool") == "wrench")
        #expect(ToolCardHelpers.toolIcon(for: nil) == "wrench")
    }

    // MARK: - borderColor

    @Test("borderColor returns red when resultIsError")
    func borderColorError() {
        let color = ToolCardHelpers.borderColor(resultIsError: true, type: .tool)
        #expect(color == .red)
    }

    @Test("borderColor returns secondary for toolResult type")
    func borderColorToolResult() {
        let color = ToolCardHelpers.borderColor(resultIsError: false, type: .toolResult)
        #expect(color == .secondary)
    }

    @Test("borderColor returns purple for normal tool")
    func borderColorNormal() {
        let color = ToolCardHelpers.borderColor(resultIsError: false, type: .tool)
        #expect(color == .purple)
    }

    @Test("borderColor error takes precedence over toolResult type")
    func borderColorErrorPrecedence() {
        let color = ToolCardHelpers.borderColor(resultIsError: true, type: .toolResult)
        #expect(color == .red)
    }

    // MARK: - toolSummary

    @Test("toolSummary returns file_path for Read tool")
    func toolSummaryRead() {
        let input: [String: AnyCodableValue] = ["file_path": .string("/src/main.swift")]
        let result = ToolCardHelpers.toolSummary(tool: "Read", input: input, fallbackContent: nil)
        #expect(result == "/src/main.swift")
    }

    @Test("toolSummary returns command for Bash tool")
    func toolSummaryBash() {
        let input: [String: AnyCodableValue] = ["command": .string("ls -la")]
        let result = ToolCardHelpers.toolSummary(tool: "Bash", input: input, fallbackContent: nil)
        #expect(result == "ls -la")
    }

    @Test("toolSummary returns pattern for Grep tool")
    func toolSummaryGrep() {
        let input: [String: AnyCodableValue] = ["pattern": .string("TODO")]
        let result = ToolCardHelpers.toolSummary(tool: "Grep", input: input, fallbackContent: nil)
        #expect(result == "TODO")
    }

    @Test("toolSummary returns nil for unknown tool with input")
    func toolSummaryUnknown() {
        let input: [String: AnyCodableValue] = ["key": .string("value")]
        let result = ToolCardHelpers.toolSummary(tool: "Custom", input: input, fallbackContent: nil)
        #expect(result == nil)
    }

    @Test("toolSummary falls back to content firstLine when no input")
    func toolSummaryFallback() {
        let result = ToolCardHelpers.toolSummary(tool: "Bash", input: nil, fallbackContent: "line1\nline2")
        #expect(result == "line1")
    }

    @Test("toolSummary returns nil when no input and no content")
    func toolSummaryNilEverything() {
        let result = ToolCardHelpers.toolSummary(tool: "Bash", input: nil, fallbackContent: nil)
        #expect(result == nil)
    }

    // MARK: - inputLanguage

    @Test("inputLanguage returns bash for Bash tool")
    func inputLanguageBash() {
        #expect(ToolCardHelpers.inputLanguage(for: "Bash") == "bash")
    }

    @Test("inputLanguage returns nil for Grep tool")
    func inputLanguageGrep() {
        #expect(ToolCardHelpers.inputLanguage(for: "Grep") == nil)
    }

    @Test("inputLanguage returns json for other tools")
    func inputLanguageDefault() {
        #expect(ToolCardHelpers.inputLanguage(for: "Read") == "json")
        #expect(ToolCardHelpers.inputLanguage(for: "Edit") == "json")
        #expect(ToolCardHelpers.inputLanguage(for: nil) == "json")
    }

    // MARK: - formatToolInput

    @Test("formatToolInput returns command for Bash")
    func formatInputBash() {
        let input: [String: AnyCodableValue] = ["command": .string("echo hello")]
        let result = ToolCardHelpers.formatToolInput(input, tool: "Bash")
        #expect(result == "echo hello")
    }

    @Test("formatToolInput returns file_path for Edit with old_string")
    func formatInputEditWithDiff() {
        let input: [String: AnyCodableValue] = [
            "file_path": .string("/src/app.swift"),
            "old_string": .string("old"),
            "new_string": .string("new")
        ]
        let result = ToolCardHelpers.formatToolInput(input, tool: "Edit")
        #expect(result == "/src/app.swift")
    }

    @Test("formatToolInput returns empty for Edit with old_string but no file_path")
    func formatInputEditNoPaths() {
        let input: [String: AnyCodableValue] = [
            "old_string": .string("old"),
            "new_string": .string("new")
        ]
        let result = ToolCardHelpers.formatToolInput(input, tool: "Edit")
        #expect(result == "")
    }

    @Test("formatToolInput returns file_path for Read")
    func formatInputRead() {
        let input: [String: AnyCodableValue] = ["file_path": .string("/readme.md")]
        let result = ToolCardHelpers.formatToolInput(input, tool: "Read")
        #expect(result == "/readme.md")
    }

    // MARK: - truncateResult

    @Test("truncateResult returns original content when under threshold")
    func truncateResultShort() {
        let content = (1...10).map { "Line \($0)" }.joined(separator: "\n")
        let result = ToolCardHelpers.truncateResult(content)
        #expect(result.isTruncated == false)
        #expect(result.displayText == content)
        #expect(result.hiddenCount == 0)
    }

    @Test("truncateResult returns original at exactly threshold")
    func truncateResultAtThreshold() {
        // threshold = 20 + 5 + 3 = 28
        let content = (1...28).map { "Line \($0)" }.joined(separator: "\n")
        let result = ToolCardHelpers.truncateResult(content)
        #expect(result.isTruncated == false)
        #expect(result.displayText == content)
    }

    @Test("truncateResult truncates content exceeding threshold")
    func truncateResultLong() {
        let lines = (1...50).map { "Line \($0)" }
        let content = lines.joined(separator: "\n")
        let result = ToolCardHelpers.truncateResult(content)
        #expect(result.isTruncated == true)
        #expect(result.hiddenCount == 25) // 50 - 20 - 5
        #expect(result.displayText.hasPrefix("Line 1\n"))
        #expect(result.displayText.contains("...\n"))
        #expect(result.displayText.hasSuffix("Line 50"))
    }

    @Test("truncateResult handles empty string")
    func truncateResultEmpty() {
        let result = ToolCardHelpers.truncateResult("")
        #expect(result.isTruncated == false)
        #expect(result.displayText == "")
        #expect(result.hiddenCount == 0)
    }

    @Test("truncateResult handles single line")
    func truncateResultSingleLine() {
        let result = ToolCardHelpers.truncateResult("hello world")
        #expect(result.isTruncated == false)
        #expect(result.displayText == "hello world")
    }

    @Test("truncateResult respects custom headLines and tailLines")
    func truncateResultCustomParams() {
        let lines = (1...20).map { "Line \($0)" }
        let content = lines.joined(separator: "\n")
        // headLines=5, tailLines=3, threshold = 5+3+3 = 11
        let result = ToolCardHelpers.truncateResult(content, headLines: 5, tailLines: 3)
        #expect(result.isTruncated == true)
        #expect(result.hiddenCount == 12) // 20 - 5 - 3
    }
}
