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

    /// Fallback approval row state (shown when session is waiting but no prompt card appeared)
    @State private var showFallbackApproval = false
    @State private var fallbackDebounceTask: Task<Void, Never>?
    /// Timestamp when fallback conditions first became true (anti-starvation)
    @State private var fallbackConditionsMetAt: Date?

    /// Minimum interval between sends to prevent double-tap
    private static let sendCooldown: TimeInterval = 0.3
    /// Debounce delay before showing fallback approval row.
    /// Kept short (800ms) so fallback appears quickly when prompt card system fails.
    private static let fallbackDebounceMs: Int = 800
    static let maxSuggestions = 6

    private var canSend: Bool {
        InputBarHelpers.canSend(text: inputText, currentSessionId: state.currentSessionId)
    }

    /// Filtered slash command suggestions based on current input
    private var suggestions: [SlashCommand] {
        InputBarHelpers.suggestions(text: inputText, commands: state.slashCommands, maxCount: Self.maxSuggestions)
    }

    /// Suggestion chips from the current AskUserQuestion prompt
    private var questionChips: [QuestionOption] {
        InputBarHelpers.questionChips(from: coordinator.promptService.currentPrompt)
    }

    var body: some View {
        VStack(spacing: 0) {
            // Autocomplete suggestions
            if !suggestions.isEmpty && isFocused {
                suggestionList
            }

            // Question suggestion chips
            if !questionChips.isEmpty {
                suggestionChipRow
            }

            // Fallback approval row (when prompt card system fails)
            if showFallbackApproval {
                fallbackApprovalRow
                    .animation(.easeInOut(duration: 0.25), value: showFallbackApproval)
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
                            icon: modeIcon,
                            label: state.sessionMode.label,
                            tint: modeTint,
                            action: toggleMode
                        )

                        #if os(iOS)
                        utilityButton(
                            icon: speechService.isListening
                                ? (coordinator.isVoiceLoopActive ? "mic.badge.xmark" : "mic.fill")
                                : "mic",
                            label: speechService.isListening
                                ? (coordinator.isVoiceLoopActive ? "Voice Loop" : "Listening")
                                : "Mic",
                            tint: speechService.isListening
                                ? (coordinator.isVoiceLoopActive ? .green : .red)
                                : .secondary,
                            pulsing: speechService.isListening,
                            action: {
                                // Tap mic during voice loop → exit loop
                                if coordinator.isVoiceLoopActive && speechService.isListening {
                                    coordinator.exitVoiceLoop()
                                } else {
                                    do {
                                        try speechService.toggleListening()
                                    } catch {
                                        state.showToast("Mic unavailable: \(error.localizedDescription)", icon: "mic.slash", style: .warning)
                                    }
                                }
                            }
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
                        .submitLabel(.send)
                        .onSubmit { send() }
                        .onChange(of: inputText) { _, newValue in
                            // On iOS, Return in a vertical TextField inserts a newline
                            // instead of triggering .onSubmit. Detect and submit instead.
                            // Check both \n and \r — hardware vs software keyboards differ.
                            if newValue.hasSuffix("\n") || newValue.hasSuffix("\r") {
                                // Strip only the trailing newline, preserve any mid-text newlines
                                var trimmed = newValue
                                while trimmed.hasSuffix("\n") || trimmed.hasSuffix("\r") {
                                    trimmed = String(trimmed.dropLast())
                                }
                                inputText = trimmed
                                send()
                                return
                            }
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
        .onChange(of: speechService.isListening) { wasListening, isListening in
            // Clear text field after auto-send or manual stop
            if wasListening && !isListening && !speechService.transcript.isEmpty {
                inputText = ""
            }
        }
        .onChange(of: isFocused) { _, focused in
            // Tapping text field exits voice loop
            if focused && coordinator.isVoiceLoopActive {
                coordinator.exitVoiceLoop()
            }
        }
        #endif
        .onAppear { updateFallbackApproval() }
        .onDisappear { fallbackDebounceTask?.cancel(); fallbackDebounceTask = nil; fallbackConditionsMetAt = nil }
        .onChange(of: state.sessionStatus) { _, _ in updateFallbackApproval() }
        .onChange(of: coordinator.promptService.currentPrompt) { _, _ in updateFallbackApproval() }
        .onChange(of: state.currentSessionId) { _, _ in updateFallbackApproval() }
        .onChange(of: coordinator.promptService.lastRespondedAt) { _, _ in updateFallbackApproval() }
    }

    // MARK: - Question Suggestion Chips

    private var suggestionChipRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Suggestions")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .padding(.leading, 14)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(Array(questionChips.enumerated()), id: \.offset) { _, option in
                        Button {
                            inputText = option.value ?? option.label
                            isFocused = true
                            #if os(iOS)
                            HapticService.light()
                            #endif
                        } label: {
                            Text(InputBarHelpers.truncatedLabel(option.label))
                                .font(.subheadline)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                                .background(.secondary.opacity(0.15))
                                .clipShape(Capsule())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(option.label)
                    }
                }
                .padding(.horizontal, 14)
            }
        }
        .padding(.top, 6)
    }

    // MARK: - Fallback Approval

    private var fallbackApprovalRow: some View {
        let lastPerm = coordinator.promptService.lastSeenPermission
        let toolName = lastPerm?.tool
        let command = lastPerm?.command

        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                    .font(.title3)

                VStack(alignment: .leading, spacing: 2) {
                    Text(toolName.map { "\($0) needs approval" } ?? "Waiting for approval")
                        .font(.subheadline)
                        .fontWeight(.semibold)

                    if let command, !command.isEmpty {
                        Text(command)
                            .font(.system(.caption, design: .monospaced))
                            .lineLimit(2)
                            .foregroundStyle(.secondary)
                    }
                }

                Spacer()
            }

            HStack(spacing: 10) {
                Button {
                    injectFallback("y")
                } label: {
                    Label("Allow", systemImage: "checkmark.circle.fill")
                        .font(.subheadline)
                        .fontWeight(.medium)
                }
                .buttonStyle(.borderedProminent)
                .tint(.blue)

                Button {
                    injectFallback("always")
                } label: {
                    Label("Always", systemImage: "checkmark.circle.badge.checkmark")
                        .font(.subheadline)
                        .fontWeight(.medium)
                }
                .buttonStyle(.bordered)

                Button {
                    injectFallback("n")
                } label: {
                    Label("Deny", systemImage: "xmark.circle.fill")
                        .font(.subheadline)
                        .fontWeight(.medium)
                }
                .buttonStyle(.bordered)
                .tint(.red)

                Spacer()
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(.orange.opacity(0.1))
                .overlay(
                    RoundedRectangle(cornerRadius: 12)
                        .strokeBorder(.orange.opacity(0.3), lineWidth: 1)
                )
        )
        .padding(.horizontal, 8)
        .padding(.top, 4)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    private func injectFallback(_ command: String) {
        guard let sessionId = state.currentSessionId else { return }
        coordinator.injectCommand(command, sessionId: sessionId)
        // Dismiss any prompt card that appeared late (prevents double-approval)
        if coordinator.promptService.currentPrompt != nil {
            coordinator.promptService.clearQueue()
        }
        showFallbackApproval = false
        fallbackDebounceTask?.cancel()
        fallbackDebounceTask = nil
        fallbackConditionsMetAt = nil
        #if os(iOS)
        HapticService.medium()
        #endif
    }

    private func updateFallbackApproval() {
        let conditionsMet = InputBarHelpers.shouldShowFallbackApproval(
            sessionStatus: state.sessionStatus,
            currentPrompt: coordinator.promptService.currentPrompt,
            currentSessionId: state.currentSessionId,
            lastRespondedAt: coordinator.promptService.lastRespondedAt
        )

        if conditionsMet {
            // Track when conditions first became true (anti-starvation)
            if fallbackConditionsMetAt == nil {
                fallbackConditionsMetAt = Date()
            }

            // Anti-starvation: if conditions have been met for > 1.5s and timer
            // keeps getting cancelled/restarted by onChange triggers, force show
            if let firstMet = fallbackConditionsMetAt,
               Date().timeIntervalSince(firstMet) > 1.5 {
                showFallbackApproval = true
                fallbackDebounceTask?.cancel()
                fallbackDebounceTask = nil
                return
            }

            // Start debounce timer only if not already showing or timing
            if !showFallbackApproval && fallbackDebounceTask == nil {
                fallbackDebounceTask = Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(Self.fallbackDebounceMs))
                    guard !Task.isCancelled else { return }
                    showFallbackApproval = true
                    fallbackDebounceTask = nil
                }
            }
        } else {
            // Cancel timer and hide immediately
            fallbackDebounceTask?.cancel()
            fallbackDebounceTask = nil
            fallbackConditionsMetAt = nil
            showFallbackApproval = false
        }
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

    // MARK: - Mode Display

    private var modeIcon: String {
        switch state.sessionMode {
        case .defaultMode: "arrow.triangle.swap"
        case .acceptEdits: "pencil.circle"
        case .plan: "doc.text"
        }
    }

    private var modeTint: Color {
        switch state.sessionMode {
        case .defaultMode: .secondary
        case .acceptEdits: .green
        case .plan: .orange
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
        state.currentActivity = "Sending..."
        coordinator.injectCommand(trimmed, sessionId: sessionId)
        inputText = ""
        isFocused = false
        #if os(iOS)
        // Cancel silence timer to prevent double-send, and stop mic
        speechService.cancelManualSilenceTimer()
        if speechService.isListening { speechService.stopListening() }
        HapticService.light()
        #endif
    }

    private func escape() {
        guard let sessionId = state.currentSessionId else { return }
        coordinator.escapeSession(sessionId)
    }

    private func toggleMode() {
        guard let sessionId = state.currentSessionId else { return }
        guard state.sessionStatus == .waiting else {
            state.showToast("Mode toggle requires an active prompt", icon: "arrow.triangle.swap", style: .info)
            return
        }
        coordinator.toggleMode(sessionId)
    }
}

// MARK: - Extracted Logic (Testable)

/// Pure logic extracted from InputBarView for testability.
enum InputBarHelpers {

    static func canSend(text: String, currentSessionId: String?) -> Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        && currentSessionId != nil
    }

    static func suggestions(text: String, commands: [SlashCommand], maxCount: Int) -> [SlashCommand] {
        guard text.hasPrefix("/"), !commands.isEmpty else { return [] }
        let query = String(text.dropFirst()).lowercased()
        if query.isEmpty {
            return Array(commands.prefix(maxCount))
        }
        return commands
            .filter { $0.name.lowercased().contains(query) }
            .prefix(maxCount)
            .map { $0 }
    }

    /// Extract question options as suggestion chips from the current prompt.
    /// Returns empty for non-question prompts, permissions, plan exits, or questions without options.
    static func questionChips(from prompt: PromptItem?) -> [QuestionOption] {
        guard let prompt, case .question(let questions) = prompt.kind,
              let options = questions.first?.options, !options.isEmpty else {
            return []
        }
        return options
    }

    /// Truncate long option labels for chip display.
    static func truncatedLabel(_ label: String, maxLength: Int = 40) -> String {
        if label.count <= maxLength { return label }
        return String(label.prefix(maxLength - 1)) + "\u{2026}"
    }

    /// Check if fallback approval conditions are met:
    /// session is waiting, no prompt card visible, and a session is active.
    static func shouldShowFallbackApproval(
        sessionStatus: SessionStatus,
        currentPrompt: PromptItem?,
        currentSessionId: String?,
        lastRespondedAt: Date? = nil
    ) -> Bool {
        // Don't show fallback if a prompt was responded to via the primary card
        // within the last 3 seconds (avoids flash after responding)
        if let responded = lastRespondedAt, Date().timeIntervalSince(responded) < 3.0 {
            return false
        }
        return sessionStatus == .waiting
            && currentPrompt == nil
            && currentSessionId != nil
    }
}
