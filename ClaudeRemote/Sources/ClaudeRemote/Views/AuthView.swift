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

    public init() {}

    /// True when the server URL uses plain HTTP to a non-localhost host.
    private var isInsecureRemote: Bool {
        AuthHelpers.isInsecureRemote(serverURL)
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

                    SecureField("Auth Token", text: $token)
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

                Section {
                    Text("The server runs on your Mac. Make sure you're on the same network.")
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
        }
    }

    private func connectAction() {
        errorMessage = nil

        guard let url = URL(string: serverURL) else {
            errorMessage = "Invalid server URL"
            return
        }

        // Validate URL scheme
        guard let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
            errorMessage = "URL must use http or https"
            return
        }

        // Validate URL has a host
        guard let host = url.host, !host.isEmpty else {
            errorMessage = "URL must include a host"
            return
        }

        // Validate token length
        guard token.count >= 32 else {
            errorMessage = "Token must be at least 32 characters"
            return
        }

        isConnecting = true
        state.userDidDisconnect = false
        state.serverURL = serverURL
        SettingsStore.saveServerURL(serverURL)

        // Save token to Keychain
        let keychain = KeychainService()
        do {
            try keychain.save(token: token, for: serverURL)
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
        // isAuthenticated is set by AppCoordinator when authResult(success: true) arrives
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
