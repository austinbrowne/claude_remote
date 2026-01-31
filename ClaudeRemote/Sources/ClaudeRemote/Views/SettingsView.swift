import SwiftUI
#if os(iOS)
import AVFoundation
#endif

/// Settings screen with connection, voice, notification, and developer options
struct SettingsView: View {
    @Environment(AppState.self) private var state
    @Environment(AppCoordinator.self) private var coordinator
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
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
            .onChange(of: state.notifyEnabled) { _, v in SettingsStore.saveNotifyEnabled(v) }
            .onChange(of: state.debugMode) { _, v in SettingsStore.saveDebugMode(v) }
        }
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
                    Text(state.isConnected ? "Connected" : "Disconnected")
                        .foregroundStyle(.secondary)
                }
            }

            Button("Disconnect", role: .destructive) {
                coordinator.disconnect()
                state.isAuthenticated = false
            }
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
            @Bindable var s = state
            Toggle("Trigger Word (\"Titus\")", isOn: $s.triggerEnabled)
                .onChange(of: state.triggerEnabled) { _, newValue in
                    coordinator.setTriggerEnabled(newValue)
                }
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
