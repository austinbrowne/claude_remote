import SwiftUI
@preconcurrency import MarkdownUI

/// Displays file content with appropriate rendering based on file type
struct FileContentView: View {
    let filePath: String
    let fileName: String
    let fileSize: Int?
    let sessionId: String
    let serverURL: String
    let token: String
    let documentService: DocumentService

    @State private var fileContent: FileContent?
    @State private var isLoading = true
    @State private var error: String?

    private static let syntaxHighlighter = SharedSyntaxHighlighter()

    var body: some View {
        Group {
            if isLoading {
                ProgressView("Loading...")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error {
                errorView(error)
            } else if let fileContent {
                contentView(fileContent)
            }
        }
        .navigationTitle(fileName)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                if let content = fileContent?.content {
                    Button {
                        copyToClipboard(content)
                    } label: {
                        Image(systemName: "doc.on.doc")
                    }
                }
            }
        }
        .task {
            await loadContent()
        }
    }

    // MARK: - Content Rendering

    @ViewBuilder
    private func contentView(_ file: FileContent) -> some View {
        if let fileError = file.error {
            // Server returned an error (binary file, too large, etc.)
            VStack(spacing: 12) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 40))
                    .foregroundStyle(.orange)
                Text(fileError)
                    .foregroundStyle(.secondary)
                if let size = fileSize {
                    Text(FileEntry.formatSize(size))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let content = file.content {
            let ext = (fileName as NSString).pathExtension.lowercased()
            if ext == "md" {
                markdownView(content)
            } else if file.language != nil {
                codeView(content, language: file.language)
            } else {
                plainTextView(content)
            }
        }
    }

    private func markdownView(_ content: String) -> some View {
        ScrollView {
            Markdown(content)
                .markdownTheme(.claudeRemote)
                .markdownCodeSyntaxHighlighter(Self.syntaxHighlighter)
                .textSelection(.enabled)
                .padding()
        }
    }

    private func codeView(_ content: String, language: String?) -> some View {
        ScrollView {
            CodeBlockView(code: content, language: language)
                .padding()
        }
    }

    private func plainTextView(_ content: String) -> some View {
        ScrollView {
            Text(content)
                .font(.system(.body, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
        }
    }

    private func errorView(_ message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 40))
                .foregroundStyle(.orange)
            Text(message)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Retry") {
                Task { await loadContent() }
            }
            .buttonStyle(.bordered)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Data Loading

    private func loadContent() async {
        isLoading = true
        error = nil
        do {
            fileContent = try await documentService.fetchFileContent(
                serverURL: serverURL,
                token: token,
                sessionId: sessionId,
                path: filePath
            )
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    // MARK: - Helpers

    private func copyToClipboard(_ text: String) {
        #if canImport(UIKit)
        UIPasteboard.general.string = text
        #elseif canImport(AppKit)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #endif
    }

}
