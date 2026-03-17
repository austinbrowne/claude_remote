import SwiftUI
#if os(iOS)
import AVFoundation
#endif

/// Settings screen with connection, voice, notification, and developer options
struct SettingsView: View {
    @Environment(AppState.self) private var state
    @Environment(AppCoordinator.self) private var coordinator
    @Environment(\.dismiss) private var dismiss
    @State private var switchingServerId: UUID?
    @State private var editingServer: SavedServer?
    @State private var editName = ""
    @State private var showDeleteActiveAlert = false
    @State private var serverToDelete: SavedServer?

    private var savedServers: [SavedServer] {
        SettingsStore.loadSavedServers()
    }

    private var isSwitching: Bool {
        coordinator.connectionState == .switching
    }

    var body: some View {
        NavigationStack {
            Form {
                serversSection
                connectionSection
                #if os(iOS)
                voiceOutputSection
                voiceInputSection
                #endif
                notificationsSection
                developerSection
                aboutSection
            }
            .navigationTitle("Settings")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .onChange(of: state.ttsEnabled) { _, v in SettingsStore.saveTTSEnabled(v) }
            .onChange(of: state.speakTools) { _, v in SettingsStore.saveSpeakTools(v) }
            .onChange(of: state.speechRate) { _, v in SettingsStore.saveSpeechRate(v) }
            .onChange(of: state.voiceIdentifier) { _, v in SettingsStore.saveVoiceIdentifier(v) }
            .onChange(of: state.notifyEnabled) { _, v in
                SettingsStore.saveNotifyEnabled(v)
                #if os(iOS)
                if v {
                    Task {
                        let granted = await coordinator.notificationService.requestAuthorization()
                        if !granted {
                            state.notifyEnabled = false
                            SettingsStore.saveNotifyEnabled(false)
                            state.showToast("Enable notifications in iOS Settings", icon: "bell.slash", style: .warning)
                        }
                    }
                }
                #endif
            }
            .onChange(of: state.debugMode) { _, v in SettingsStore.saveDebugMode(v) }
            .sheet(item: $editingServer) { server in
                renameServerSheet(server: server)
            }
            .alert("Delete Active Server?", isPresented: $showDeleteActiveAlert) {
                Button("Delete", role: .destructive) {
                    if let server = serverToDelete {
                        _ = coordinator.deleteServer(server)
                    }
                    serverToDelete = nil
                }
                Button("Cancel", role: .cancel) {
                    serverToDelete = nil
                }
            } message: {
                Text("This will disconnect you from the current server.")
            }
        }
    }

    // MARK: - Servers

    private var serversSection: some View {
        Section {
            if savedServers.isEmpty {
                Text("No saved servers")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(savedServers) { server in
                    serverRow(server)
                }
                .onDelete { offsets in
                    let servers = savedServers
                    for index in offsets {
                        let server = servers[index]
                        let isActive = (URLHelper.canonicalize(server.url) ?? server.url) == state.serverURL
                        if isActive {
                            serverToDelete = server
                            showDeleteActiveAlert = true
                        } else {
                            SettingsStore.removeSavedServer(id: server.id)
                        }
                    }
                }
            }

            Button {
                // Disconnect and show AuthView for adding a new server
                coordinator.disconnect()
                state.userDidDisconnect = true
                state.isAuthenticated = false
                state.serverURL = ""
                SettingsStore.saveServerURL("")
            } label: {
                Label("Add Server", systemImage: "plus.circle")
            }
        } header: {
            HStack {
                Text("Servers")
                #if os(iOS)
                Spacer()
                if !savedServers.isEmpty {
                    EditButton()
                        .font(.caption)
                }
                #endif
            }
        }
        .disabled(isSwitching)
    }

    private func serverRow(_ server: SavedServer) -> some View {
        let canonical = URLHelper.canonicalize(server.url) ?? server.url
        let isActive = canonical == state.serverURL && state.isConnected
        let isThisSwitching = switchingServerId == server.id

        return Button {
            if !isActive {
                switchToServer(server)
            } else {
                editingServer = server
            }
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(server.name)
                        .foregroundStyle(.primary)
                    Text(server.url)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer()

                if isThisSwitching {
                    ProgressView()
                } else if isActive {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                }
            }
        }
        .swipeActions(edge: .trailing) {
            Button {
                editingServer = server
            } label: {
                Label("Rename", systemImage: "pencil")
            }
            .tint(.blue)
        }
    }

    private func switchToServer(_ server: SavedServer) {
        switchingServerId = server.id
        Task {
            await coordinator.switchServer(server)
            switchingServerId = nil
        }
    }

    // MARK: - Rename Sheet

    private func renameServerSheet(server: SavedServer) -> some View {
        NavigationStack {
            Form {
                Section("Server Name") {
                    TextField("Name", text: $editName)
                        #if os(iOS)
                        .textInputAutocapitalization(.words)
                        #endif
                }
                Section {
                    LabeledContent("URL") {
                        Text(server.url)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }
            .navigationTitle("Edit Server")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { editingServer = nil }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        let name = editName.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !name.isEmpty else { return }
                        var updated = server
                        updated.name = String(name.prefix(50))
                        SettingsStore.updateSavedServer(updated)
                        editingServer = nil
                    }
                    .disabled(editName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .onAppear {
                editName = server.name
            }
        }
        .presentationDetents([.medium])
    }

    // MARK: - Connection

    private var connectionSection: some View {
        Section("Connection") {
            LabeledContent("Server") {
                Text(state.serverURL.isEmpty ? "Not configured" : state.serverURL)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            LabeledContent("Token") {
                Text(maskedToken)
                    .foregroundStyle(.secondary)
                    .font(.system(.body, design: .monospaced))
            }

            LabeledContent("Status") {
                HStack(spacing: 6) {
                    Circle()
                        .fill(state.isConnected ? Color.green : Color.red)
                        .frame(width: 8, height: 8)
                    Text(statusText)
                        .foregroundStyle(.secondary)
                }
            }

            Button("Disconnect", role: .destructive) {
                coordinator.disconnect()
                state.userDidDisconnect = true
                state.isAuthenticated = false
            }
        }
    }

    private var statusText: String {
        switch coordinator.connectionState {
        case .switching: return "Switching..."
        case .connecting: return "Connecting..."
        case .connected: return "Connected"
        case .disconnected: return "Disconnected"
        }
    }

    private var maskedToken: String {
        // Show first 4 and last 4 characters
        let keychain = KeychainService()
        guard let token = keychain.load(for: state.serverURL), token.count >= 8 else {
            return "********"
        }
        let prefix = String(token.prefix(4))
        let suffix = String(token.suffix(4))
        return "\(prefix)...\(suffix)"
    }

    // MARK: - Voice Output (iOS only)

    #if os(iOS)
    private var voiceOutputSection: some View {
        Section("Voice Output") {
            @Bindable var s = state
            Toggle("Text-to-Speech", isOn: $s.ttsEnabled)

            Toggle("Speak Tool Results", isOn: $s.speakTools)
                .disabled(!state.ttsEnabled)

            Picker("Voice", selection: $s.voiceIdentifier) {
                Text("Default").tag(String?.none)
                ForEach(availableVoices, id: \.identifier) { voice in
                    Text(voiceDisplayName(voice))
                        .tag(Optional(voice.identifier))
                }
            }
            .disabled(!state.ttsEnabled)

            LabeledContent("Speech Rate") {
                Text(String(format: "%.1fx", state.speechRate))
                    .foregroundStyle(.secondary)
            }
            Slider(value: $s.speechRate, in: 0.5...2.0, step: 0.1)
                .disabled(!state.ttsEnabled)
        }
    }

    private var availableVoices: [AVSpeechSynthesisVoice] {
        AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language.hasPrefix("en") }
            .sorted { $0.name < $1.name }
    }

    private func voiceDisplayName(_ voice: AVSpeechSynthesisVoice) -> String {
        let quality = voice.quality == .enhanced ? " (Enhanced)" : ""
        return "\(voice.name)\(quality)"
    }

    private var voiceInputSection: some View {
        Section("Voice Input") {
            Toggle("Trigger Word (\"Titus\")", isOn: Binding(
                get: { state.triggerEnabled },
                set: { newValue in
                    // Route through coordinator which handles audio session,
                    // auth, and persistence. The guard inside setTriggerEnabled
                    // prevents feedback loops when it reverts on failure.
                    coordinator.setTriggerEnabled(newValue)
                }
            ))
        }
    }
    #endif

    // MARK: - Notifications

    private var notificationsSection: some View {
        Section("Notifications") {
            @Bindable var s = state
            Toggle("Push Notifications", isOn: $s.notifyEnabled)
        }
    }

    // MARK: - Developer

    private var developerSection: some View {
        Section("Developer") {
            @Bindable var s = state
            Toggle("Debug Mode", isOn: $s.debugMode)

            LabeledContent("WebSocket") {
                Text(state.isConnected ? "Connected" : "Disconnected")
                    .foregroundStyle(state.isConnected ? .green : .red)
            }

            LabeledContent("Sessions") {
                Text("\(state.sessions.count)")
                    .foregroundStyle(.secondary)
            }

            LabeledContent("Messages") {
                Text("\(state.messages.count)")
                    .foregroundStyle(.secondary)
            }

            LabeledContent("Subagents") {
                Text("\(state.activeSubagents.count)")
                    .foregroundStyle(.secondary)
            }

            LabeledContent("Tasks") {
                Text("\(state.tasks.count)")
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - About

    private var aboutSection: some View {
        Section("About") {
            LabeledContent("Version") {
                Text(appVersion)
                    .foregroundStyle(.secondary)
            }

            LabeledContent("Build") {
                Text(buildNumber)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0.0"
    }

    private var buildNumber: String {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1"
    }
}
