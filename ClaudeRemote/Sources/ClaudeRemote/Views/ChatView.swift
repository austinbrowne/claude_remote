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
                            isNearBottom = false
                        }
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: state.messages.count) { oldCount, newCount in
                    guard newCount > oldCount else {
                        // Messages were cleared (session switch)
                        isNearBottom = true
                        showNewMessageIndicator = false
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

    private var waitingState: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Waiting for output...")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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
