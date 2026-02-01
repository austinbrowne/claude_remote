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

/// Main app view with sidebar session list and chat detail
struct MainView: View {
    @Environment(AppState.self) private var state
    @Environment(AppCoordinator.self) private var coordinator
    @State private var selectedSessionId: String?
    @State private var showSettings = false
    @State private var columnVisibility: NavigationSplitViewVisibility = .detailOnly

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            sidebar
        } detail: {
            detail
        }
        .onChange(of: selectedSessionId) { _, newId in
            guard let newId else { return }
            state.beginSessionSwitch(to: newId)
            // Collapse sidebar on iPhone after selection
            columnVisibility = .detailOnly
        }
        .onChange(of: state.pendingSessionId) { _, newId in
            guard let newId else { return }
            coordinator.watchSession(newId)
        }
        .onChange(of: state.currentSessionId) { _, newId in
            // Keep selection in sync when session confirmed
            if newId != selectedSessionId {
                selectedSessionId = newId
            }
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

    // MARK: - Sidebar

    private var sidebar: some View {
        Group {
            if state.sessions.isEmpty {
                VStack(spacing: 16) {
                    Image(systemName: "terminal")
                        .font(.system(size: 48))
                        .foregroundStyle(.secondary)
                    Text("No active sessions")
                        .font(.title3)
                    Text("Start a Claude Code session in iTerm to see it here.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding()
            } else {
                List(state.sessions, selection: $selectedSessionId) { session in
                    SessionRow(
                        session: session,
                        isSelected: session.id == state.currentSessionId
                    )
                    .tag(session.id)
                }
                .refreshable {
                    coordinator.refreshSessions()
                }
            }
        }
        .navigationTitle("Sessions")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button {
                    showSettings = true
                } label: {
                    Image(systemName: "gearshape")
                }
            }
        }
    }

    // MARK: - Detail

    private var detail: some View {
        VStack(spacing: 0) {
            if !state.isConnected {
                disconnectedBanner
            }

            contextBar

            ChatView()
                .gesture(
                    DragGesture(minimumDistance: 50)
                        .onEnded { value in
                            let horizontal = value.translation.width
                            let vertical = abs(value.translation.height)
                            guard abs(horizontal) > vertical else { return }
                            switchSession(forward: horizontal < 0)
                        }
                )
        }
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 0) {
                if let activity = state.currentActivity {
                    activityBar(activity)
                        .transition(.opacity)
                }
                if !coordinator.promptService.promptQueue.isEmpty {
                    PromptCardView()
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
                InputBarView()
            }
            .animation(.easeInOut(duration: 0.25), value: coordinator.promptService.promptQueue.count)
            .animation(.easeInOut(duration: 0.2), value: state.currentActivity != nil)
        }
        .navigationTitle(currentSessionName)
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
                sessionToolbarTitle
            }
            #endif
            ToolbarItem(placement: .confirmationAction) {
                HStack(spacing: 8) {
                    #if os(iOS)
                    triggerToggle
                    #endif
                    SubagentBadgeView()
                }
            }
        }
    }

    // MARK: - Helpers

    private var currentSession: Session? {
        guard let sessionId = state.currentSessionId else { return nil }
        return state.sessions.first { $0.id == sessionId }
    }

    private var currentSessionName: String {
        currentSession?.name ?? "Claude Remote"
    }

    #if os(iOS)
    private var sessionToolbarTitle: some View {
        VStack(spacing: 1) {
            Text(currentSessionName)
                .font(.subheadline)
                .fontWeight(.semibold)

            if let session = currentSession {
                HStack(spacing: 4) {
                    Circle()
                        .fill(session.status.color)
                        .frame(width: 6, height: 6)

                    if let branch = session.branch {
                        Text(branch)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    } else {
                        Text(session.status.rawValue)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }
    #endif

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

    private func activityBar(_ text: String) -> some View {
        HStack(spacing: 6) {
            ProgressView()
                .scaleEffect(0.7)
                .frame(width: 14, height: 14)
            Text(text)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.bar)
    }

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

    @ViewBuilder
    private var contextBar: some View {
        let pct = state.contextPercentage
        if pct >= 0.5 {
            VStack(spacing: 0) {
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Rectangle().fill(Color.secondary.opacity(0.15))
                        Rectangle()
                            .fill(contextBarColor(pct))
                            .frame(width: geo.size.width * pct)
                            .animation(.easeInOut(duration: 0.3), value: pct)
                    }
                }
                .frame(height: 3)

                HStack {
                    Text("Context: \(Int(pct * 100))%")
                        .font(.caption2)
                        .foregroundStyle(contextBarColor(pct))
                    Spacer()
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 2)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Context window \(Int(pct * 100)) percent used")
        }
    }

    private func contextBarColor(_ pct: Double) -> Color {
        switch pct {
        case ..<0.7: .green
        case 0.7..<0.9: .orange
        default: .red
        }
    }

    private func switchSession(forward: Bool) {
        guard !state.sessions.isEmpty else { return }
        guard let currentId = state.currentSessionId,
              let currentIndex = state.sessions.firstIndex(where: { $0.id == currentId }) else {
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
        selectedSessionId = nextSession.id
        #if os(iOS)
        HapticService.light()
        #endif
    }
}
