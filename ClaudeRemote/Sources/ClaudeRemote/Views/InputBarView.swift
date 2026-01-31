import SwiftUI

/// Text input bar with send, escape, and mode-toggle buttons
struct InputBarView: View {
    @Environment(AppState.self) private var state
    @Environment(AppCoordinator.self) private var coordinator

    @State private var inputText = ""
    @State private var lastSendTime: Date?
    @FocusState private var isFocused: Bool

    /// Minimum interval between sends to prevent double-tap
    private static let sendCooldown: TimeInterval = 0.3

    private var canSend: Bool {
        !inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        && state.currentSessionId != nil
    }

    var body: some View {
        HStack(spacing: 8) {
            TextField("Send a message...", text: $inputText, axis: .vertical)
                .lineLimit(1...4)
                .focused($isFocused)
                .textFieldStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(.gray.opacity(0.12))
                .clipShape(RoundedRectangle(cornerRadius: 18))
                .onSubmit { send() }
                .onChange(of: inputText) { _, newValue in
                    if newValue.count > 10_000 {
                        inputText = String(newValue.prefix(10_000))
                    }
                }

            // Escape button (Ctrl+C equivalent)
            Button {
                escape()
            } label: {
                Image(systemName: "xmark.circle")
                    .font(.title3)
                    .foregroundStyle(.secondary)
            }
            .disabled(state.currentSessionId == nil)

            // Plan/Act mode toggle
            Button {
                toggleMode()
            } label: {
                Image(systemName: "arrow.triangle.swap")
                    .font(.title3)
                    .foregroundStyle(.secondary)
            }
            .disabled(state.currentSessionId == nil)

            // Send
            Button {
                send()
            } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.title2)
                    .foregroundStyle(canSend ? .blue : .secondary)
            }
            .disabled(!canSend)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private func send() {
        let trimmed = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let sessionId = state.currentSessionId else { return }

        // Enforce cooldown to prevent double-tap
        if let last = lastSendTime, Date().timeIntervalSince(last) < Self.sendCooldown {
            return
        }

        lastSendTime = Date()
        state.trackSentMessage(trimmed)
        coordinator.injectCommand(trimmed, sessionId: sessionId)
        inputText = ""
    }

    private func escape() {
        guard let sessionId = state.currentSessionId else { return }
        coordinator.escapeSession(sessionId)
    }

    private func toggleMode() {
        guard let sessionId = state.currentSessionId else { return }
        coordinator.toggleMode(sessionId)
    }
}
