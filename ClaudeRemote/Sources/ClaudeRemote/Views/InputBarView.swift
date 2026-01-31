import SwiftUI

/// Text input bar with send, escape, mode-toggle, mic buttons, and slash command autocomplete
struct InputBarView: View {
    @Environment(AppState.self) private var state
    @Environment(AppCoordinator.self) private var coordinator

    #if os(iOS)
    @Environment(SpeechService.self) private var speechService
    #endif

    @State private var inputText = ""
    @State private var lastSendTime: Date?
    @FocusState private var isFocused: Bool

    /// Minimum interval between sends to prevent double-tap
    private static let sendCooldown: TimeInterval = 0.3
    private static let maxSuggestions = 6

    private var canSend: Bool {
        !inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        && state.currentSessionId != nil
    }

    /// Filtered slash command suggestions based on current input
    private var suggestions: [SlashCommand] {
        guard inputText.hasPrefix("/"), !state.slashCommands.isEmpty else { return [] }
        let query = String(inputText.dropFirst()).lowercased()
        if query.isEmpty {
            return Array(state.slashCommands.prefix(Self.maxSuggestions))
        }
        return state.slashCommands
            .filter { $0.name.lowercased().contains(query) }
            .prefix(Self.maxSuggestions)
            .map { $0 }
    }

    var body: some View {
        VStack(spacing: 0) {
            // Autocomplete suggestions
            if !suggestions.isEmpty && isFocused {
                suggestionList
            }

            VStack(spacing: 6) {
                // Utility row: session actions with proper touch targets
                if state.currentSessionId != nil {
                    HStack(spacing: 8) {
                        utilityButton(
                            icon: "xmark.circle",
                            label: "Escape",
                            tint: .secondary,
                            action: escape
                        )

                        utilityButton(
                            icon: "arrow.triangle.swap",
                            label: "Plan/Act",
                            tint: .secondary,
                            action: toggleMode
                        )

                        #if os(iOS)
                        utilityButton(
                            icon: speechService.isListening ? "mic.fill" : "mic",
                            label: speechService.isListening ? "Listening" : "Mic",
                            tint: speechService.isListening ? .red : .secondary,
                            pulsing: speechService.isListening,
                            action: { try? speechService.toggleListening() }
                        )
                        #endif
                    }
                }

                // Primary row: text field + send
                HStack(spacing: 8) {
                    TextField("Send a message...", text: $inputText, axis: .vertical)
                        .lineLimit(1...4)
                        .focused($isFocused)
                        .textFieldStyle(.plain)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                        .background(.gray.opacity(0.12))
                        .clipShape(RoundedRectangle(cornerRadius: 20))
                        .onSubmit { send() }
                        .onChange(of: inputText) { _, newValue in
                            if newValue.count > 10_000 {
                                inputText = String(newValue.prefix(10_000))
                            }
                        }

                    Button(action: send) {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 32))
                            .foregroundStyle(canSend ? .blue : .secondary)
                    }
                    .disabled(!canSend)
                    .frame(width: 44, height: 44)
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 6)
            .padding(.bottom, 8)
        }
        .background(.bar)
        #if os(iOS)
        .onChange(of: speechService.transcript) { _, newValue in
            if speechService.isListening && !newValue.isEmpty {
                inputText = newValue
            }
        }
        #endif
    }

    // MARK: - Autocomplete

    private var suggestionList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(suggestions) { command in
                    Button {
                        selectCommand(command)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("/\(command.name)")
                                .font(.subheadline)
                                .fontWeight(.medium)
                                .fontDesign(.monospaced)
                            if !command.description.isEmpty {
                                Text(command.description)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .frame(maxHeight: 200)
        .background(.ultraThinMaterial)
    }

    private func selectCommand(_ command: SlashCommand) {
        inputText = "/\(command.name) "
    }

    // MARK: - Utility Buttons

    private func utilityButton(
        icon: String,
        label: String,
        tint: Color,
        pulsing: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: icon)
                    .font(.subheadline)
                    .symbolEffect(.pulse, isActive: pulsing)
                Text(label)
                    .font(.caption)
                    .fontWeight(.medium)
            }
            .foregroundStyle(tint)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: 36)
            .background(tint.opacity(0.1))
            .clipShape(Capsule())
        }
    }

    // MARK: - Actions

    private func send() {
        let trimmed = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let sessionId = state.currentSessionId else { return }

        // Enforce cooldown to prevent double-tap
        if let last = lastSendTime, Date().timeIntervalSince(last) < Self.sendCooldown {
            return
        }

        lastSendTime = Date()
        state.trackSentMessage(trimmed)
        // Show the message locally immediately
        let userMsg = Message(type: .user, content: trimmed)
        state.appendMessage(userMsg)
        coordinator.injectCommand(trimmed, sessionId: sessionId)
        inputText = ""
        isFocused = false
        #if os(iOS)
        HapticService.light()
        #endif
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
