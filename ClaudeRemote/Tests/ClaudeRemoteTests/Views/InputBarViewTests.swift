import Testing
import Foundation
@testable import ClaudeRemote

@Suite("InputBarHelpers")
struct InputBarHelpersTests {

    // MARK: - canSend

    @Test("canSend returns true with text and session")
    func canSendTrue() {
        #expect(InputBarHelpers.canSend(text: "hello", currentSessionId: "s1") == true)
    }

    @Test("canSend returns false with empty text")
    func canSendEmptyText() {
        #expect(InputBarHelpers.canSend(text: "", currentSessionId: "s1") == false)
    }

    @Test("canSend returns false with whitespace-only text")
    func canSendWhitespaceOnly() {
        #expect(InputBarHelpers.canSend(text: "   \n  ", currentSessionId: "s1") == false)
    }

    @Test("canSend returns false with no session")
    func canSendNoSession() {
        #expect(InputBarHelpers.canSend(text: "hello", currentSessionId: nil) == false)
    }

    // MARK: - suggestions

    @Test("suggestions returns empty when text doesn't start with /")
    func suggestionsNoSlash() {
        let cmds = [SlashCommand(name: "help", description: "Help")]
        #expect(InputBarHelpers.suggestions(text: "help", commands: cmds, maxCount: 6).isEmpty)
    }

    @Test("suggestions returns all commands for bare /")
    func suggestionsBareSlash() {
        let cmds = [
            SlashCommand(name: "help", description: "Help"),
            SlashCommand(name: "compact", description: "Compact"),
        ]
        let result = InputBarHelpers.suggestions(text: "/", commands: cmds, maxCount: 6)
        #expect(result.count == 2)
    }

    @Test("suggestions filters by query")
    func suggestionsFilter() {
        let cmds = [
            SlashCommand(name: "help", description: "Help"),
            SlashCommand(name: "compact", description: "Compact"),
            SlashCommand(name: "clear", description: "Clear"),
        ]
        let result = InputBarHelpers.suggestions(text: "/com", commands: cmds, maxCount: 6)
        #expect(result.count == 1)
        #expect(result[0].name == "compact")
    }

    @Test("suggestions limits to maxCount")
    func suggestionsLimit() {
        let cmds = (1...10).map { SlashCommand(name: "cmd\($0)", description: "Cmd \($0)") }
        let result = InputBarHelpers.suggestions(text: "/", commands: cmds, maxCount: 3)
        #expect(result.count == 3)
    }

    @Test("suggestions returns empty when no commands available")
    func suggestionsEmpty() {
        let result = InputBarHelpers.suggestions(text: "/help", commands: [], maxCount: 6)
        #expect(result.isEmpty)
    }

    @Test("suggestions is case-insensitive")
    func suggestionsCaseInsensitive() {
        let cmds = [SlashCommand(name: "Help", description: "Help")]
        let result = InputBarHelpers.suggestions(text: "/hel", commands: cmds, maxCount: 6)
        #expect(result.count == 1)
    }
}
