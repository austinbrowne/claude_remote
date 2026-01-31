import SwiftUI

/// Root view: shows auth screen or main app
public struct ContentView: View {
    @Environment(AppState.self) private var state

    public init() {}

    public var body: some View {
        Group {
            if state.isAuthenticated {
                MainView()
            } else {
                AuthView()
            }
        }
    }
}

/// Main app view with session list and connection status
struct MainView: View {
    @Environment(AppState.self) private var state
    @State private var showSessionPicker = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                sessionHeader

                ChatView()
            }
            .navigationTitle("Claude Remote")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    connectionIndicator
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        showSessionPicker = true
                    } label: {
                        Image(systemName: "list.bullet")
                    }
                }
            }
            .sheet(isPresented: $showSessionPicker) {
                SessionPickerView()
            }
        }
    }

    private var connectionIndicator: some View {
        Circle()
            .fill(state.isConnected ? Color.green : Color.red)
            .frame(width: 10, height: 10)
    }

    private var sessionHeader: some View {
        Group {
            if let sessionId = state.currentSessionId,
               let session = state.sessions.first(where: { $0.id == sessionId }) {
                HStack {
                    Text(session.name)
                        .font(.headline)
                    if let branch = session.branch {
                        Text(branch)
                            .font(.caption)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(.blue.opacity(0.1))
                            .clipShape(Capsule())
                    }
                    Spacer()
                    SessionStatusBadge(status: session.status)
                }
                .padding(.horizontal)
                .padding(.vertical, 8)
                .background(.bar)
            }
        }
    }

}
