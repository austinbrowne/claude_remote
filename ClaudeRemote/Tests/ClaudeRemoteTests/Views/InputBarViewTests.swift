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

    // MARK: - questionChips

    @Test("questionChips returns empty for nil prompt")
    func questionChipsNil() {
        #expect(InputBarHelpers.questionChips(from: nil).isEmpty)
    }

    @Test("questionChips returns empty for permission prompts")
    func questionChipsPermission() {
        let prompt = PromptItem(kind: .permission(tool: "Bash", command: "ls", isDestructive: false))
        #expect(InputBarHelpers.questionChips(from: prompt).isEmpty)
    }

    @Test("questionChips returns empty for plan exit prompts")
    func questionChipsPlanExit() {
        let prompt = PromptItem(kind: .planExit)
        #expect(InputBarHelpers.questionChips(from: prompt).isEmpty)
    }

    @Test("questionChips returns options for question prompts")
    func questionChipsWithOptions() {
        let options = [
            QuestionOption(label: "Option A", value: "a"),
            QuestionOption(label: "Option B", value: "b"),
        ]
        let questions = [QuestionData(question: "Pick one?", options: options)]
        let prompt = PromptItem(kind: .question(questions: questions))
        let chips = InputBarHelpers.questionChips(from: prompt)
        #expect(chips.count == 2)
        #expect(chips[0].label == "Option A")
        #expect(chips[1].value == "b")
    }

    @Test("questionChips returns empty for questions without options")
    func questionChipsNoOptions() {
        let questions = [QuestionData(question: "What do you think?")]
        let prompt = PromptItem(kind: .question(questions: questions))
        #expect(InputBarHelpers.questionChips(from: prompt).isEmpty)
    }

    @Test("questionChips returns empty for questions with empty options array")
    func questionChipsEmptyOptions() {
        let questions = [QuestionData(question: "Pick?", options: [])]
        let prompt = PromptItem(kind: .question(questions: questions))
        #expect(InputBarHelpers.questionChips(from: prompt).isEmpty)
    }

    // MARK: - truncatedLabel

    @Test("truncatedLabel returns short labels unchanged")
    func truncatedLabelShort() {
        #expect(InputBarHelpers.truncatedLabel("Hello") == "Hello")
    }

    @Test("truncatedLabel truncates long labels with ellipsis")
    func truncatedLabelLong() {
        let long = String(repeating: "a", count: 50)
        let result = InputBarHelpers.truncatedLabel(long)
        #expect(result.count == 40)
        #expect(result.hasSuffix("\u{2026}"))
    }

    @Test("truncatedLabel preserves labels at exact max length")
    func truncatedLabelExact() {
        let exact = String(repeating: "x", count: 40)
        #expect(InputBarHelpers.truncatedLabel(exact) == exact)
    }

    @Test("truncatedLabel handles emoji at boundary correctly")
    func truncatedLabelEmojiBoundary() {
        // 38 chars + family emoji (single grapheme cluster but multi-codepoint)
        let label = String(repeating: "a", count: 38) + "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}" + "extra"
        let result = InputBarHelpers.truncatedLabel(label, maxLength: 40)
        // Swift String.prefix operates on Character (grapheme clusters), so this is safe
        #expect(result.count == 40)
        #expect(result.hasSuffix("\u{2026}"))
    }

    // MARK: - shouldShowFallbackApproval

    @Test("fallback shows when waiting + no prompt + has session")
    func fallbackShowsWhenConditionsMet() {
        #expect(InputBarHelpers.shouldShowFallbackApproval(
            sessionStatus: .waiting,
            currentPrompt: nil,
            currentSessionId: "s1"
        ) == true)
    }

    @Test("fallback hidden when status is idle")
    func fallbackHiddenWhenIdle() {
        #expect(InputBarHelpers.shouldShowFallbackApproval(
            sessionStatus: .idle,
            currentPrompt: nil,
            currentSessionId: "s1"
        ) == false)
    }

    @Test("fallback hidden when status is processing")
    func fallbackHiddenWhenProcessing() {
        #expect(InputBarHelpers.shouldShowFallbackApproval(
            sessionStatus: .processing,
            currentPrompt: nil,
            currentSessionId: "s1"
        ) == false)
    }

    @Test("fallback hidden when prompt card is visible")
    func fallbackHiddenWhenPromptVisible() {
        let prompt = PromptItem(kind: .permission(tool: "Bash", command: "ls", isDestructive: false))
        #expect(InputBarHelpers.shouldShowFallbackApproval(
            sessionStatus: .waiting,
            currentPrompt: prompt,
            currentSessionId: "s1"
        ) == false)
    }

    @Test("fallback hidden when no session")
    func fallbackHiddenWhenNoSession() {
        #expect(InputBarHelpers.shouldShowFallbackApproval(
            sessionStatus: .waiting,
            currentPrompt: nil,
            currentSessionId: nil
        ) == false)
    }

    @Test("fallback hidden when question prompt is visible")
    func fallbackHiddenWhenQuestionVisible() {
        let questions = [QuestionData(question: "Pick?", options: [
            QuestionOption(label: "A", value: "a"),
        ])]
        let prompt = PromptItem(kind: .question(questions: questions))
        #expect(InputBarHelpers.shouldShowFallbackApproval(
            sessionStatus: .waiting,
            currentPrompt: prompt,
            currentSessionId: "s1"
        ) == false)
    }
}
