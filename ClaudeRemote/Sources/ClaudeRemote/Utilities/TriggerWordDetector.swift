import Foundation

/// Pure logic for trigger word detection — platform-neutral, no hardware dependencies.
/// Extracts trigger word matching and command parsing from SpeechService for testability.
public enum TriggerWordDetector {

    /// Variants of "Titus" that SFSpeechRecognizer may produce
    public static let triggerVariants = [
        "titus", "tightest", "tidus", "tidas", "titis", "tight us"
    ]

    /// Check if the transcript contains a trigger word. Returns the text
    /// after the trigger word, or nil if no trigger found.
    public static func extractCommandAfterTrigger(_ text: String) -> String? {
        let lowered = text.lowercased()
        for variant in triggerVariants {
            if let range = lowered.range(of: variant) {
                let after = String(text[range.upperBound...])
                return after.trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        return nil
    }

    /// Check if the given text is a cancel/stop command (first word exact match).
    public static func isCancelCommand(_ text: String) -> Bool {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .split(separator: " ")
            .map(String.init)
        guard let first = words.first else { return false }
        return first == "cancel" || first == "stop"
    }

}
