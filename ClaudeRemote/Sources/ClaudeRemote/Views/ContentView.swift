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
    @Environment(AppCoordinator.self) private var coordinator
    @State private var showSessionPicker = false
    @State private var showSettings = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if !state.isConnected {
                    disconnectedBanner
                }

                sessionHeader

                ChatView()
                    .gesture(
                        DragGesture(minimumDistance: 50)
                            .onEnded { value in
                                let horizontal = value.translation.width
                                let vertical = abs(value.translation.height)
                                // Only trigger for horizontal swipes (not vertical scrolling)
                                guard abs(horizontal) > vertical else { return }
                                switchSession(forward: horizontal < 0)
                            }
                    )
            }
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 0) {
                    if coordinator.promptService.currentPrompt != nil {
                        PromptCardView()
                            .transition(.move(edge: .bottom).combined(with: .opacity))
                    }
                    InputBarView()
                }
                .animation(.easeInOut(duration: 0.25), value: coordinator.promptService.currentPrompt != nil)
            }
            .navigationTitle("Claude Remote")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    HStack(spacing: 8) {
                        connectionIndicator
                        #if os(iOS)
                        triggerIndicator
                        #endif
                    }
                }
                #if os(iOS)
                ToolbarItem(placement: .principal) {
                    triggerToggle
                }
                #endif
                ToolbarItem(placement: .confirmationAction) {
                    HStack(spacing: 12) {
                        SubagentBadgeView()
                        Button {
                            showSettings = true
                        } label: {
                            Image(systemName: "gearshape")
                        }
                        Button {
                            showSessionPicker = true
                        } label: {
                            Image(systemName: "list.bullet")
                        }
                    }
                }
            }
            .sheet(isPresented: $showSessionPicker) {
                SessionPickerView()
            }
            .sheet(isPresented: $showSettings) {
                SettingsView()
            }
            .overlay(alignment: .top) {
                ToastOverlay(toast: state.currentToast) {
                    state.currentToast = nil
                }
                .animation(.easeInOut(duration: 0.3), value: state.currentToast)
            }
        }
    }

    private var connectionIndicator: some View {
        Circle()
            .fill(state.isConnected ? Color.green : Color.red)
            .frame(width: 10, height: 10)
    }

    #if os(iOS)
    @ViewBuilder
    private var triggerIndicator: some View {
        switch coordinator.speechService.triggerState {
        case .listening:
            Image(systemName: "waveform")
                .font(.caption2)
                .foregroundStyle(.teal)
        case .capturing:
            Image(systemName: "waveform")
                .font(.caption2)
                .foregroundStyle(.red)
                .symbolEffect(.variableColor.iterative, isActive: true)
        case .idle, .cooldown:
            EmptyView()
        }
    }

    private var triggerToggle: some View {
        Button {
            coordinator.setTriggerEnabled(!state.triggerEnabled)
        } label: {
            Image(systemName: state.triggerEnabled ? "ear.fill" : "ear")
                .font(.subheadline)
                .foregroundStyle(state.triggerEnabled ? .teal : .secondary)
        }
    }
    #endif

    private var disconnectedBanner: some View {
        HStack(spacing: 8) {
            Image(systemName: "wifi.slash")
                .font(.caption)
            Text("Disconnected from server")
                .font(.caption)
                .fontWeight(.medium)
            Spacer()
            Button("Reconnect") {
                coordinator.reconnect()
            }
            .font(.caption)
            .fontWeight(.medium)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.red.opacity(0.1))
        .foregroundStyle(.red)
    }

    /// Switch to the next or previous session in the list
    private func switchSession(forward: Bool) {
        guard !state.sessions.isEmpty else { return }
        guard let currentId = state.currentSessionId,
              let currentIndex = state.sessions.firstIndex(where: { $0.id == currentId }) else {
            // No current session — select the first one
            state.beginSessionSwitch(to: state.sessions[0].id)
            return
        }

        let nextIndex: Int
        if forward {
            nextIndex = (currentIndex + 1) % state.sessions.count
        } else {
            nextIndex = (currentIndex - 1 + state.sessions.count) % state.sessions.count
        }

        let nextSession = state.sessions[nextIndex]
        state.beginSessionSwitch(to: nextSession.id)
        #if os(iOS)
        HapticService.light()
        #endif
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
