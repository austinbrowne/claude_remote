import SwiftUI

/// Syntax-highlighted code block with copy button and language label
struct CodeBlockView: View {
    let code: String
    let language: String?

    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            codeContent
        }
        .background(Color.secondaryBackground)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private var header: some View {
        HStack {
            if let lang = language, !lang.isEmpty {
                Text(lang)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .textCase(.uppercase)
            }
            Spacer()
            Button {
                copyToClipboard()
            } label: {
                Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color.tertiaryBackground)
    }

    private var codeContent: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HighlightedCodeText(code: code, language: language)
                .padding(12)
        }
    }

    private func copyToClipboard() {
        #if canImport(UIKit)
        UIPasteboard.general.string = code
        #elseif canImport(AppKit)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(code, forType: .string)
        #endif
        copied = true
        Task {
            try? await Task.sleep(for: .seconds(2))
            copied = false
        }
    }
}

/// Renders code text with syntax highlighting via shared utility
private struct HighlightedCodeText: View {
    let code: String
    let language: String?

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        if let attributed = SyntaxHighlighting.highlight(code, language: language, colorScheme: colorScheme) {
            Text(AttributedString(attributed))
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
        } else {
            Text(code)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.primary)
                .textSelection(.enabled)
        }
    }
}
