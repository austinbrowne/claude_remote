import SwiftUI

/// Displays a directory listing with folders and files
struct FileTreeView: View {
    let path: String
    let sessionId: String
    let serverURL: String
    let token: String
    let documentService: DocumentService

    @State private var entries: [FileEntry] = []
    @State private var isLoading = true
    @State private var error: String?

    var body: some View {
        Group {
            if isLoading {
                ProgressView("Loading...")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error {
                errorView(error)
            } else if entries.isEmpty {
                emptyView
            } else {
                fileList
            }
        }
        .navigationTitle(navigationTitle)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .task {
            await loadFiles()
        }
    }

    // MARK: - Subviews

    private var fileList: some View {
        List(entries) { entry in
            if entry.isDirectory {
                NavigationLink {
                    FileTreeView(
                        path: entry.relativePath,
                        sessionId: sessionId,
                        serverURL: serverURL,
                        token: token,
                        documentService: documentService
                    )
                } label: {
                    directoryRow(entry)
                }
            } else {
                NavigationLink {
                    FileContentView(
                        filePath: entry.relativePath,
                        fileName: entry.name,
                        fileSize: entry.size,
                        sessionId: sessionId,
                        serverURL: serverURL,
                        token: token,
                        documentService: documentService
                    )
                } label: {
                    fileRow(entry)
                }
            }
        }
        .listStyle(.plain)
    }

    private func directoryRow(_ entry: FileEntry) -> some View {
        Label {
            Text(entry.name)
        } icon: {
            Image(systemName: "folder.fill")
                .foregroundStyle(.blue)
        }
    }

    private func fileRow(_ entry: FileEntry) -> some View {
        Label {
            HStack {
                Text(entry.name)
                Spacer()
                if let size = entry.size {
                    Text(FileEntry.formatSize(size))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        } icon: {
            Image(systemName: fileIcon(for: entry.name))
                .foregroundStyle(.secondary)
        }
    }

    private var emptyView: some View {
        VStack(spacing: 12) {
            Image(systemName: "folder")
                .font(.system(size: 40))
                .foregroundStyle(.secondary)
            Text("Empty directory")
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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
                Task { await loadFiles() }
            }
            .buttonStyle(.bordered)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Data Loading

    private func loadFiles() async {
        isLoading = true
        error = nil
        do {
            entries = try await documentService.fetchFiles(
                serverURL: serverURL,
                token: token,
                sessionId: sessionId,
                path: path
            )
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    // MARK: - Helpers

    private var navigationTitle: String {
        if path == "." {
            return "Documents"
        }
        return (path as NSString).lastPathComponent
    }

    private func fileIcon(for name: String) -> String {
        let ext = (name as NSString).pathExtension.lowercased()
        switch ext {
        case "swift": return "swift"
        case "js", "ts", "jsx", "tsx": return "curlybraces"
        case "json": return "curlybraces.square"
        case "md", "txt", "rtf": return "doc.text"
        case "html", "css": return "globe"
        case "png", "jpg", "jpeg", "gif", "svg": return "photo"
        case "yml", "yaml", "toml": return "gearshape.2"
        case "sh", "bash", "zsh": return "terminal"
        default: return "doc"
        }
    }

}
