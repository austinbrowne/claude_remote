import Foundation

/// Result of matching a voice transcript against a prompt
public enum VoicePromptMatch: Equatable, Sendable {
    case allow
    case allowAlways
    case deny
    case option(index: Int)
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
}
