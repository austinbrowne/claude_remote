import Foundation

/// Result of matching a voice transcript against a prompt
public enum VoicePromptMatch: Equatable, Sendable {
    case allow
    case allowAlways
    case deny
    case option(index: Int)
    case planExitOption(PlanExitOption)
    case noMatch
}

/// Pure voice transcript matching logic — platform-neutral, no hardware dependencies.
///
/// Uses first-word exact matching for permissions to avoid false positives
/// (e.g., "not sure" no longer matches "no" via prefix).
public enum VoicePromptMatcher {

    /// Match a voice transcript against a prompt's expected responses.
    public static func match(
        transcript: String,
        promptKind: PromptKind
    ) -> VoicePromptMatch {
        let cleaned = transcript.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !cleaned.isEmpty else { return .noMatch }

        switch promptKind {
        case .permission:
            return matchPermissionResponse(cleaned)

        case .question(let questions):
            guard let question = questions.first,
                  let options = question.options, !options.isEmpty else {
                return .noMatch
            }
            return matchQuestionResponse(cleaned, options: options)

        case .planExit:
            return matchPlanExitResponse(cleaned)
        }
    }

    // MARK: - Private

    private static func matchPermissionResponse(_ cleaned: String) -> VoicePromptMatch {
        let words = cleaned.split(separator: " ").map(String.init)
        guard let firstWord = words.first else { return .noMatch }

        // Check "always" / "allow always" before "allow" to avoid partial match
        if firstWord == "always" {
            return .allowAlways
        }
        if firstWord == "allow" && words.count >= 2 && words[1] == "always" {
            return .allowAlways
        }

        if ["allow", "yes", "approve", "okay"].contains(firstWord) {
            return .allow
        }
        if ["deny", "no", "reject", "cancel"].contains(firstWord) {
            return .deny
        }

        return .noMatch
    }

    private static func matchQuestionResponse(
        _ cleaned: String,
        options: [QuestionOption]
    ) -> VoicePromptMatch {
        // Require minimum 2 characters to reduce false positives from short partials
        guard cleaned.count >= 2 else { return .noMatch }

        for (index, option) in options.enumerated() {
            let label = option.label.lowercased()
            // Transcript contains the option label
            if cleaned.localizedCaseInsensitiveContains(label) {
                return .option(index: index)
            }
            // Option label contains the full transcript (for short voice responses)
            if label.localizedCaseInsensitiveContains(cleaned) {
                return .option(index: index)
            }
        }
        return .noMatch
    }

    private static func matchPlanExitResponse(_ cleaned: String) -> VoicePromptMatch {
        let words = cleaned.split(separator: " ").map(String.init)
        guard let firstWord = words.first else { return .noMatch }

        // "accept" / "approve" / "yes" → accept with preserve context (safest default)
        if ["accept", "approve", "yes", "okay"].contains(firstWord) {
            // Check for "clear" to distinguish clear context option
            if cleaned.contains("clear") {
                return .planExitOption(.acceptClearContext)
            }
            // Check for "manual" to distinguish manual approve option
            if cleaned.contains("manual") {
                return .planExitOption(.manualApprove)
            }
            return .planExitOption(.acceptPreserveContext)
        }

        // "clear" alone maps to clear context
        if firstWord == "clear" {
            return .planExitOption(.acceptClearContext)
        }

        // "manual" alone maps to manual approve
        if firstWord == "manual" {
            return .planExitOption(.manualApprove)
        }

        // "reject" / "no" / "changes" / "modify" → request changes (requires text, not auto-applied)
        if ["reject", "no", "changes", "modify", "change"].contains(firstWord) {
            return .noMatch // Can't do requestChanges via voice without text input
        }

        return .noMatch
    }

    // MARK: - Voice Loop Stop Commands

    /// Stop phrases that exit the voice loop. Requires entire transcript to match exactly.
    /// Uses straight apostrophe — iOS speech recognition smart quotes are normalized before comparison.
    public static let stopPhrases = ["stop listening", "that's all"]

    /// Check if the transcript is a voice loop stop command.
    /// Requires the ENTIRE transcript (trimmed, lowercased) to match a stop phrase exactly.
    /// This prevents false positives from sentences containing stop words
    /// (e.g., "I'm done with the tests" does NOT match).
    /// Normalizes smart quotes and uses locale-invariant lowercasing for reliability.
    public static func isStopCommand(_ transcript: String) -> Bool {
        let cleaned = normalizeForComparison(transcript)
        return !cleaned.isEmpty && stopPhrases.contains(cleaned)
    }

    /// Normalize a transcript for comparison: trim whitespace, lowercase with English locale,
    /// and replace smart/curly quotes with straight quotes (iOS speech recognition produces these).
    private static func normalizeForComparison(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased(with: Locale(identifier: "en"))
            .replacingOccurrences(of: "\u{2018}", with: "'") // left single quote
            .replacingOccurrences(of: "\u{2019}", with: "'") // right single quote (curly apostrophe)
    }
}
