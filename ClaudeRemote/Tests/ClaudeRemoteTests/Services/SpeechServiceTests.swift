import Testing
import Foundation
@testable import ClaudeRemote

@Suite("VoicePromptMatcher – Voice Prompt Matching")
struct VoicePromptMatcherTests {

    // MARK: - Helpers

    private static func permissionKind(
        tool: String? = "Bash",
        command: String? = "ls"
    ) -> PromptKind {
        .permission(tool: tool, command: command, isDestructive: false)
    }

    private static func questionKind(options: [String]) -> PromptKind {
        let opts = options.map { QuestionOption(label: $0) }
        let q = QuestionData(question: "Pick one", options: opts)
        return .question(questions: [q])
    }

    // MARK: - Permission: Allow Keywords

    @Test("'yes' matches .allow for permission")
    func yesMatchesAllow() {
        let result = VoicePromptMatcher.match(
            transcript: "yes",
            promptKind: Self.permissionKind()
        )
        #expect(result == .allow)
    }

    @Test("'allow' matches .allow for permission")
    func allowMatchesAllow() {
        let result = VoicePromptMatcher.match(
            transcript: "allow",
            promptKind: Self.permissionKind()
        )
        #expect(result == .allow)
    }

    @Test("'approve' matches .allow for permission")
    func approveMatchesAllow() {
        let result = VoicePromptMatcher.match(
            transcript: "approve",
            promptKind: Self.permissionKind()
        )
        #expect(result == .allow)
    }

    @Test("'okay' matches .allow for permission")
    func okayMatchesAllow() {
        let result = VoicePromptMatcher.match(
            transcript: "okay",
            promptKind: Self.permissionKind()
        )
        #expect(result == .allow)
    }

    // MARK: - Permission: Allow Always Keywords

    @Test("'always' matches .allowAlways for permission")
    func alwaysMatchesAllowAlways() {
        let result = VoicePromptMatcher.match(
            transcript: "always",
            promptKind: Self.permissionKind()
        )
        #expect(result == .allowAlways)
    }

    @Test("'allow always' matches .allowAlways for permission")
    func allowAlwaysMatchesAllowAlways() {
        let result = VoicePromptMatcher.match(
            transcript: "allow always",
            promptKind: Self.permissionKind()
        )
        #expect(result == .allowAlways)
    }

    // MARK: - Permission: Deny Keywords

    @Test("'no' matches .deny for permission")
    func noMatchesDeny() {
        let result = VoicePromptMatcher.match(
            transcript: "no",
            promptKind: Self.permissionKind()
        )
        #expect(result == .deny)
    }

    @Test("'deny' matches .deny for permission")
    func denyMatchesDeny() {
        let result = VoicePromptMatcher.match(
            transcript: "deny",
            promptKind: Self.permissionKind()
        )
        #expect(result == .deny)
    }

    @Test("'reject' matches .deny for permission")
    func rejectMatchesDeny() {
        let result = VoicePromptMatcher.match(
            transcript: "reject",
            promptKind: Self.permissionKind()
        )
        #expect(result == .deny)
    }

    @Test("'cancel' matches .deny for permission")
    func cancelMatchesDeny() {
        let result = VoicePromptMatcher.match(
            transcript: "cancel",
            promptKind: Self.permissionKind()
        )
        #expect(result == .deny)
    }

    // MARK: - Permission: No Match

    @Test("gibberish returns .noMatch for permission")
    func gibberishNoMatch() {
        let result = VoicePromptMatcher.match(
            transcript: "flibbertigibbet",
            promptKind: Self.permissionKind()
        )
        #expect(result == .noMatch)
    }

    // MARK: - Permission: Case Insensitivity

    @Test("'YES' matches .allow (case insensitive)")
    func uppercaseYesMatchesAllow() {
        let result = VoicePromptMatcher.match(
            transcript: "YES",
            promptKind: Self.permissionKind()
        )
        #expect(result == .allow)
    }

    @Test("'Allow Always' matches .allowAlways (case insensitive)")
    func mixedCaseAllowAlways() {
        let result = VoicePromptMatcher.match(
            transcript: "Allow Always",
            promptKind: Self.permissionKind()
        )
        #expect(result == .allowAlways)
    }

    // MARK: - Permission: Whitespace

    @Test("leading/trailing whitespace: ' allow ' matches .allow")
    func whitespaceAllow() {
        let result = VoicePromptMatcher.match(
            transcript: "  allow  ",
            promptKind: Self.permissionKind()
        )
        #expect(result == .allow)
    }

    // MARK: - Permission: False Positive Prevention

    @Test("'not sure' does not match .deny (first-word exact matching)")
    func notSureNoMatch() {
        let result = VoicePromptMatcher.match(
            transcript: "not sure",
            promptKind: Self.permissionKind()
        )
        #expect(result == .noMatch)
    }

    @Test("'notice' does not match .deny")
    func noticeNoMatch() {
        let result = VoicePromptMatcher.match(
            transcript: "notice",
            promptKind: Self.permissionKind()
        )
        #expect(result == .noMatch)
    }

    @Test("'nobody' does not match .deny")
    func nobodyNoMatch() {
        let result = VoicePromptMatcher.match(
            transcript: "nobody",
            promptKind: Self.permissionKind()
        )
        #expect(result == .noMatch)
    }

    // MARK: - Question: Option Matching

    @Test("exact option label matches first option")
    func exactOptionMatch() {
        let result = VoicePromptMatcher.match(
            transcript: "Option A",
            promptKind: Self.questionKind(options: ["Option A", "Option B", "Option C"])
        )
        #expect(result == .option(index: 0))
    }

    @Test("exact option label matches second option")
    func secondOptionMatch() {
        let result = VoicePromptMatcher.match(
            transcript: "Option B",
            promptKind: Self.questionKind(options: ["Option A", "Option B", "Option C"])
        )
        #expect(result == .option(index: 1))
    }

    @Test("case-insensitive option match")
    func caseInsensitiveOptionMatch() {
        let result = VoicePromptMatcher.match(
            transcript: "option a",
            promptKind: Self.questionKind(options: ["Option A", "Option B"])
        )
        #expect(result == .option(index: 0))
    }

    @Test("partial match — transcript contains option label")
    func partialContainsMatch() {
        let result = VoicePromptMatcher.match(
            transcript: "I think Option B is the best",
            promptKind: Self.questionKind(options: ["Option A", "Option B"])
        )
        #expect(result == .option(index: 1))
    }

    @Test("no option match returns .noMatch")
    func noOptionMatch() {
        let result = VoicePromptMatcher.match(
            transcript: "something unrelated",
            promptKind: Self.questionKind(options: ["Option A", "Option B"])
        )
        #expect(result == .noMatch)
    }

    // MARK: - Edge Cases

    @Test("empty transcript returns .noMatch for permission")
    func emptyTranscriptPermission() {
        let result = VoicePromptMatcher.match(
            transcript: "",
            promptKind: Self.permissionKind()
        )
        #expect(result == .noMatch)
    }

    @Test("empty transcript returns .noMatch for question")
    func emptyTranscriptQuestion() {
        let result = VoicePromptMatcher.match(
            transcript: "",
            promptKind: Self.questionKind(options: ["A", "B"])
        )
        #expect(result == .noMatch)
    }

    @Test("empty options list returns .noMatch")
    func emptyOptionsNoMatch() {
        let result = VoicePromptMatcher.match(
            transcript: "something",
            promptKind: Self.questionKind(options: [])
        )
        #expect(result == .noMatch)
    }

    @Test("'allow' with question prompt does not match permission keywords")
    func allowWithQuestionPrompt() {
        let result = VoicePromptMatcher.match(
            transcript: "allow",
            promptKind: Self.questionKind(options: ["Run tests", "Skip tests"])
        )
        #expect(result == .noMatch)
    }

    @Test("multi-word transcript with permission keyword at start")
    func multiWordPermissionKeyword() {
        let result = VoicePromptMatcher.match(
            transcript: "yes please go ahead",
            promptKind: Self.permissionKind()
        )
        #expect(result == .allow)
    }

    @Test("option label that is a substring of transcript matches")
    func optionSubstringMatch() {
        let result = VoicePromptMatcher.match(
            transcript: "go with TypeScript",
            promptKind: Self.questionKind(options: ["JavaScript", "TypeScript", "Python"])
        )
        #expect(result == .option(index: 1))
    }

    @Test("whitespace-only transcript returns .noMatch")
    func whitespaceOnlyNoMatch() {
        let result = VoicePromptMatcher.match(
            transcript: "   ",
            promptKind: Self.permissionKind()
        )
        #expect(result == .noMatch)
    }

    @Test("single-character transcript returns .noMatch for questions (min 2 chars)")
    func singleCharNoMatch() {
        let result = VoicePromptMatcher.match(
            transcript: "a",
            promptKind: Self.questionKind(options: ["Alpha", "Beta"])
        )
        #expect(result == .noMatch)
    }
}
