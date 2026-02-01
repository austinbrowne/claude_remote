import SwiftUI

/// Main chat view displaying the message list with auto-scroll
struct ChatView: View {
    @Environment(AppState.self) private var state

    @State private var isNearBottom = true
    @State private var showNewMessageIndicator = false
    @State private var scrollDebounceTask: Task<Void, Never>?

    var body: some View {
        if state.currentSessionId == nil {
            emptyState
        } else if state.messages.isEmpty {
            waitingState
        } else {
            messageList
        }
    }

    private var messageList: some View {
        ScrollViewReader { proxy in
            ZStack(alignment: .bottom) {
                ScrollView {
                    VStack(spacing: 0) {
                        TaskProgressView()

                        LazyVStack(spacing: 0) {
                            ForEach(state.messages) { message in
                                MessageView(message: message)
                                    .id(message.id)
                            }
                        }
                    }
                    .padding(.vertical, 8)

                    // Bottom anchor: tracks visibility to detect scroll position
                    Color.clear
                        .frame(height: 1)
                        .id("bottom")
                        .onAppear {
                            isNearBottom = true
                            showNewMessageIndicator = false
                        }
                        .onDisappear {
                            // Don't mark as scrolled-away while a debounced scroll is
                            // pending — the layout shift from new messages temporarily
                            // pushes the anchor off-screen, but the pending scroll will
                            // bring it back. Without this guard, rapid message bursts
                            // permanently break auto-scroll.
                            if scrollDebounceTask == nil {
                                isNearBottom = false
                            }
                        }
                }
                .defaultScrollAnchor(.bottom)
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: state.messages.count) { oldCount, newCount in
                    guard newCount > oldCount else {
                        // Messages were cleared (session switch)
                        isNearBottom = true
                        showNewMessageIndicator = false
                        return
                    }
                    // History just loaded — jump to bottom after layout
                    if oldCount == 0 && newCount > 0 {
                        scrollDebounceTask?.cancel()
                        scrollDebounceTask = Task { @MainActor in
                            try? await Task.sleep(for: .milliseconds(50))
                            guard !Task.isCancelled else { return }
                            proxy.scrollTo("bottom", anchor: .bottom)
                            scrollDebounceTask = nil
                        }
                        return
                    }
                    if isNearBottom {
                        // Debounce scroll to prevent animation stacking during rapid streaming
                        scrollDebounceTask?.cancel()
                        scrollDebounceTask = Task { @MainActor in
                            try? await Task.sleep(for: .milliseconds(100))
                            guard !Task.isCancelled else { return }
                            withAnimation(.easeOut(duration: 0.2)) {
                                proxy.scrollTo("bottom", anchor: .bottom)
                            }
                            scrollDebounceTask = nil
                        }
                    } else {
                        showNewMessageIndicator = true
                    }
                }

                if showNewMessageIndicator {
                    newMessagesBanner(proxy: proxy)
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "terminal")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)
            Text("No session selected")
                .font(.title3)
                .foregroundStyle(.secondary)
            Text("Select a session to view its output.")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Current session looked up from state
    private var currentSession: Session? {
        guard let id = state.currentSessionId else { return nil }
        return state.sessions.first { $0.id == id }
    }

    private var waitingState: some View {
        VStack(spacing: 16) {
            if let session = currentSession {
                sessionInfoCard(session)
            }

            VStack(spacing: 8) {
                ProgressView()
                Text("Waiting for output...")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func sessionInfoCard(_ session: Session) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "terminal")
                .font(.system(size: 36))
                .foregroundStyle(.secondary)

            Text(session.name)
                .font(.title3)
                .fontWeight(.semibold)

            VStack(spacing: 6) {
                if let branch = session.branch {
                    Label(branch, systemImage: "arrow.triangle.branch")
                        .font(.subheadline)
                        .foregroundStyle(.blue)
                }

                if let cwd = session.cwd {
                    Label(shortenPath(cwd), systemImage: "folder")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                SessionStatusBadge(status: session.status)
            }
        }
        .padding()
    }

    /// Shorten a path to last two components for display
    private func shortenPath(_ path: String) -> String {
        let components = path.split(separator: "/")
        if components.count <= 2 { return path }
        return components.suffix(2).joined(separator: "/")
    }

    private func newMessagesBanner(proxy: ScrollViewProxy) -> some View {
        Button {
            isNearBottom = true
            showNewMessageIndicator = false
            withAnimation(.easeOut(duration: 0.3)) {
                proxy.scrollTo("bottom", anchor: .bottom)
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "arrow.down")
                    .font(.caption)
                Text("New messages")
                    .font(.caption)
                    .fontWeight(.medium)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(.ultraThinMaterial)
            .clipShape(Capsule())
            .shadow(radius: 4)
        }
        .buttonStyle(.plain)
        .padding(.bottom, 12)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }
}
