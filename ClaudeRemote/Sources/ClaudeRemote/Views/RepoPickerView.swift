import SwiftUI

/// Sheet for selecting a git repository to start a new Claude session in
struct RepoPickerView: View {
    @Environment(AppState.self) private var state
    @Environment(AppCoordinator.self) private var coordinator
    @Environment(\.dismiss) private var dismiss
    @State private var repos: [RepoItem] = []
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var launchingRepo: String?

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    ProgressView("Loading repos...")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let error = errorMessage {
                    VStack(spacing: 12) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.system(size: 36))
                            .foregroundStyle(.secondary)
                        Text(error)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .padding()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if repos.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "folder")
                            .font(.system(size: 36))
                            .foregroundStyle(.secondary)
                        Text("No git repos found")
                            .font(.subheadline)
                        Text("Configure REPOS_PATH in your server's .env file")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .padding()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    List(repos) { repo in
                        Button {
                            launchInRepo(repo.name)
                        } label: {
                            HStack {
                                Image(systemName: "folder.fill")
                                    .foregroundStyle(.blue)
                                Text(repo.name)
                                    .foregroundStyle(.primary)
                                Spacer()
                                if launchingRepo == repo.name {
                                    ProgressView()
                                }
                            }
                        }
                        .disabled(launchingRepo != nil)
                    }
                }
            }
            .navigationTitle("Select Repository")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .task { await loadRepos() }
        }
    }

    private func loadRepos() async {
        isLoading = true
        let items = await coordinator.fetchRepos()
        repos = items
        isLoading = false
        if items.isEmpty {
            errorMessage = nil // empty state handles this
        }
    }

    private func launchInRepo(_ repoName: String) {
        launchingRepo = repoName

        // Server handles everything: create terminal + start Claude + session_replaced
        coordinator.newTerminal(repoName: repoName, startClaude: true)
        state.showToast("Starting Claude in \(repoName)...", icon: "play.circle", style: .success)

        // Wait for the server to create terminal, start Claude, and send session_replaced
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(5))
            coordinator.refreshSessions()
            try? await Task.sleep(for: .seconds(1))
            dismiss()
        }
    }
}
