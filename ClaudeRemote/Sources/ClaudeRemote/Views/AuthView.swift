import SwiftUI

/// Authentication screen for entering server URL and token
public struct AuthView: View {
    @Environment(AppState.self) private var state
    @Environment(AppCoordinator.self) private var coordinator
    @State private var serverURL = ""
    @State private var token = ""
    @State private var isConnecting = false
    @State private var errorMessage: String?
    @State private var didAttemptAutoConnect = false
    @State private var tokenFieldFocusHint: String?
    @State private var showSaveSheet = false
    @State private var saveServerName = ""

    public init() {}

    /// True when the server URL uses plain HTTP to a non-localhost host.
    private var isInsecureRemote: Bool {
        AuthHelpers.isInsecureRemote(serverURL)
    }

    private var savedServers: [SavedServer] {
        SettingsStore.loadSavedServers()
    }

    public var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Server URL", text: $serverURL)
                        .textContentType(.URL)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif

                    SecureField(tokenFieldFocusHint ?? "Auth Token", text: $token)
                        .textContentType(.password)

                    if isInsecureRemote {
                        Text("Warning: Token will be sent in cleartext over the network")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }
                } header: {
                    Text("Connection")
                } footer: {
                    Text("Enter the server URL and auth token from your .env file.")
                }

                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                    }
                }

                Section {
                    Button {
                        connectAction()
                    } label: {
                        HStack {
                            Text("Connect")
                            if isConnecting {
                                Spacer()
                                ProgressView()
                            }
                        }
                    }
                    .disabled(token.count < 32 || serverURL.isEmpty || isConnecting)
                }

                // MARK: - Saved Servers
                Section {
                    if savedServers.isEmpty {
                        Text("No saved servers yet")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(savedServers) { server in
                            Button {
                                selectSavedServer(server)
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(server.name)
                                            .foregroundStyle(.primary)
                                        Text(server.url)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Image(systemName: "arrow.right.circle")
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                } header: {
                    Text("Saved Servers")
                }

                Section {
                    Text("The server runs on your Mac. Make sure you're on the same network or use a Cloudflare tunnel.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Claude Remote")
            .onChange(of: state.isConnected) { _, isConnected in
                if !isConnected { isConnecting = false }
            }
            .onAppear {
                // Pre-fill saved URL
                let savedURL = state.serverURL
                if !savedURL.isEmpty {
                    serverURL = savedURL
                } else {
                    serverURL = "http://localhost:3456"
                }

                // Auto-connect if we have saved credentials (skip if user explicitly disconnected)
                guard !didAttemptAutoConnect, !state.userDidDisconnect else { return }
                didAttemptAutoConnect = true

                let keychain = KeychainService()
                if !savedURL.isEmpty, let savedToken = keychain.load(for: savedURL) {
                    token = savedToken
                    isConnecting = true
                    coordinator.reconnect()
                }
            }
            .sheet(isPresented: $showSaveSheet) {
                saveServerSheet
            }
        }
    }

    // MARK: - Saved Server Selection

    private func selectSavedServer(_ server: SavedServer) {
        let keychain = KeychainService()
        let canonical = URLHelper.canonicalize(server.url) ?? server.url
        serverURL = canonical
        tokenFieldFocusHint = nil
        errorMessage = nil

        if let savedToken = keychain.load(for: canonical) {
            token = savedToken
            connectAction()
        } else {
            // No token — pre-fill URL, focus token field
            token = ""
            tokenFieldFocusHint = "Enter token for \(server.name)"
        }
    }

    // MARK: - Save Server Sheet

    private var saveServerSheet: some View {
        NavigationStack {
            Form {
                Section("Server Name") {
                    TextField("Name", text: $saveServerName)
                        #if os(iOS)
                        .textInputAutocapitalization(.words)
                        #endif
                }
            }
            .navigationTitle("Save Server")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { showSaveSheet = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        let name = saveServerName.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !name.isEmpty else { return }
                        let server = SavedServer(name: name, url: serverURL)
                        if !SettingsStore.addSavedServer(server) {
                            // Duplicate — update existing entry's name
                            if var existing = SettingsStore.findSavedServer(byURL: serverURL) {
                                existing.name = String(name.prefix(50))
                                SettingsStore.updateSavedServer(existing)
                            }
                        }
                        showSaveSheet = false
                    }
                    .disabled(saveServerName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .presentationDetents([.medium])
    }

    // MARK: - Connect

    private func connectAction() {
        errorMessage = nil
        tokenFieldFocusHint = nil

        // Use URLHelper for validation
        if let validationError = URLHelper.validate(serverURL) {
            errorMessage = validationError
            return
        }

        // Canonicalize the URL
        guard let canonical = URLHelper.canonicalize(serverURL) else {
            errorMessage = "Invalid server URL"
            return
        }
        serverURL = canonical

        guard let url = URL(string: canonical) else {
            errorMessage = "Invalid server URL"
            return
        }

        // Validate token length
        guard token.count >= 32 else {
            errorMessage = "Token must be at least 32 characters"
            return
        }

        isConnecting = true
        state.userDidDisconnect = false
        state.serverURL = canonical
        SettingsStore.saveServerURL(canonical)

        // Save token to Keychain
        let keychain = KeychainService()
        do {
            try keychain.save(token: token, for: canonical)
        } catch {
            errorMessage = "Failed to save token"
            isConnecting = false
            return
        }

        // Build WebSocket URL
        guard let wsURL = WebSocketService.webSocketURL(from: url) else {
            errorMessage = "Failed to build WebSocket URL"
            isConnecting = false
            return
        }

        coordinator.connect(url: wsURL, token: token)

        // Offer to save this server if not already saved
        if SettingsStore.findSavedServer(byURL: canonical) == nil {
            saveServerName = URLHelper.displayName(from: canonical).capitalized
            // Delay showing sheet to avoid interrupting connection
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(500))
                if state.isConnected || isConnecting {
                    showSaveSheet = true
                }
            }
        }
    }
}

// MARK: - Extracted Logic (Testable)

/// Pure validation logic extracted from AuthView for testability.
public enum AuthHelpers {

    /// True when the URL uses plain HTTP to a non-localhost host.
    public static func isInsecureRemote(_ urlString: String) -> Bool {
        guard let url = URL(string: urlString),
              url.scheme?.lowercased() == "http",
              let host = url.host?.lowercased() else {
            return false
        }
        return host != "localhost" && host != "127.0.0.1"
    }
}
