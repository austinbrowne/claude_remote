import SwiftUI

/// Sheet container for the document viewer with NavigationStack
struct DocumentViewerSheet: View {
    @Environment(AppState.self) private var state
    @Environment(\.dismiss) private var dismiss

    private let documentService = DocumentService()

    var body: some View {
        NavigationStack {
            Group {
                if let sessionId = state.currentSessionId, let token = loadToken() {
                    FileTreeView(
                        path: ".",
                        sessionId: sessionId,
                        serverURL: state.serverURL,
                        token: token,
                        documentService: documentService
                    )
                } else if state.currentSessionId == nil {
                    ContentUnavailableView(
                        "No Session",
                        systemImage: "doc.text",
                        description: Text("Select a session to browse files.")
                    )
                } else {
                    ContentUnavailableView(
                        "Not Authenticated",
                        systemImage: "lock",
                        description: Text("Connect to a server first.")
                    )
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
        }
        .presentationDetents([.large])
    }

    /// Load auth token from Keychain for the current server URL
    private func loadToken() -> String? {
        let keychain = KeychainService()
        let token = keychain.load(for: state.serverURL)
        guard let token, !token.isEmpty else { return nil }
        return token
    }
}
