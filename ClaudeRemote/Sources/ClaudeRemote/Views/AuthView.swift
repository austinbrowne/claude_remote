import SwiftUI

/// Authentication screen for entering server URL and token
public struct AuthView: View {
    @Environment(AppState.self) private var state
    @State private var serverURL = "http://localhost:3456"
    @State private var token = ""
    @State private var isConnecting = false
    @State private var errorMessage: String?

    public init() {}

    /// True when the server URL uses plain HTTP to a non-localhost host.
    private var isInsecureRemote: Bool {
        guard let url = URL(string: serverURL),
              url.scheme?.lowercased() == "http",
              let host = url.host?.lowercased() else {
            return false
        }
        return host != "localhost" && host != "127.0.0.1"
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
        state.serverURL = serverURL
        // The actual WebSocket connection is handled by the coordinator/service
        // For now, just store the intent
        state.isAuthenticated = true
        isConnecting = false
    }
}
