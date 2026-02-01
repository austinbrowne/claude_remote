import SwiftUI
import Highlightr

/// Shared Highlightr instance for syntax highlighting across the app.
/// Uses nonisolated(unsafe) because Highlightr is only accessed from
/// SwiftUI view bodies which always run on the main thread.
enum SyntaxHighlighting {
    private static nonisolated(unsafe) let highlightr: Highlightr? = Highlightr()

    /// Highlight code with optional language and color scheme
    static func highlight(_ code: String, language: String?, colorScheme: ColorScheme = .dark) -> NSAttributedString? {
        guard let highlightr else { return nil }
        highlightr.setTheme(to: colorScheme == .dark ? "atom-one-dark" : "atom-one-light")
        if let lang = language, !lang.isEmpty {
            return highlightr.highlight(code, as: lang)
        }
        return highlightr.highlight(code)
    }
}
