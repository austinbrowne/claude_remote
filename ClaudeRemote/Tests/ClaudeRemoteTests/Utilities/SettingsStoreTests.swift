import Testing
import Foundation
@testable import ClaudeRemote

@Suite("SettingsStore")
struct SettingsStoreTests {

    /// Use a shared suite key to avoid test pollution
    private static let testSuiteKey = "settings.test.\(UUID().uuidString.prefix(8))"

    @MainActor
    @Test("load restores default values for fresh state")
    func loadDefaults() {
        let state = AppState()
        // Before load, everything is default
        #expect(state.ttsEnabled == false)
        #expect(state.speakTools == false)
        #expect(state.debugMode == false)
        #expect(state.speechRate == 1.0)

        // After load with no saved values, still defaults
        SettingsStore.load(into: state)
        #expect(state.ttsEnabled == false)
        #expect(state.speechRate == 1.0)
    }

    @MainActor
    @Test("save and load TTS enabled")
    func saveTTSEnabled() {
        SettingsStore.saveTTSEnabled(true)
        let state = AppState()
        SettingsStore.load(into: state)
        #expect(state.ttsEnabled == true)
        // Clean up
        SettingsStore.saveTTSEnabled(false)
    }

    @MainActor
    @Test("save and load speak tools")
    func saveSpeakTools() {
        SettingsStore.saveSpeakTools(true)
        let state = AppState()
        SettingsStore.load(into: state)
        #expect(state.speakTools == true)
        SettingsStore.saveSpeakTools(false)
    }

    @MainActor
    @Test("save and load debug mode")
    func saveDebugMode() {
        SettingsStore.saveDebugMode(true)
        let state = AppState()
        SettingsStore.load(into: state)
        #expect(state.debugMode == true)
        SettingsStore.saveDebugMode(false)
    }

    @MainActor
    @Test("save and load speech rate")
    func saveSpeechRate() {
        SettingsStore.saveSpeechRate(1.5)
        let state = AppState()
        SettingsStore.load(into: state)
        #expect(state.speechRate == 1.5)
        // Clean up — reset to 0 so default (1.0) is restored
        SettingsStore.saveSpeechRate(0)
    }

    @MainActor
    @Test("speech rate defaults to 1.0 when stored as zero")
    func speechRateDefault() {
        SettingsStore.saveSpeechRate(0)
        let state = AppState()
        SettingsStore.load(into: state)
        #expect(state.speechRate == 1.0)
    }

    @MainActor
    @Test("save and load voice identifier")
    func saveVoiceIdentifier() {
        SettingsStore.saveVoiceIdentifier("com.apple.voice.enhanced.en-US.Samantha")
        let state = AppState()
        SettingsStore.load(into: state)
        #expect(state.voiceIdentifier == "com.apple.voice.enhanced.en-US.Samantha")
        SettingsStore.saveVoiceIdentifier(nil)
    }

    @MainActor
    @Test("nil voice identifier stays nil")
    func nilVoiceIdentifier() {
        SettingsStore.saveVoiceIdentifier(nil)
        let state = AppState()
        SettingsStore.load(into: state)
        #expect(state.voiceIdentifier == nil)
    }

    @MainActor
    @Test("save and load server URL")
    func saveServerURL() {
        SettingsStore.saveServerURL("http://192.168.1.100:3456")
        let state = AppState()
        SettingsStore.load(into: state)
        #expect(state.serverURL == "http://192.168.1.100:3456")
        SettingsStore.saveServerURL("")
    }

    @MainActor
    @Test("empty server URL does not overwrite default")
    func emptyServerURL() {
        SettingsStore.saveServerURL("")
        let state = AppState()
        state.serverURL = "http://existing.local"
        SettingsStore.load(into: state)
        // Empty string should not overwrite
        #expect(state.serverURL == "http://existing.local")
    }

    @MainActor
    @Test("save and load notify enabled")
    func saveNotifyEnabled() {
        SettingsStore.saveNotifyEnabled(true)
        let state = AppState()
        SettingsStore.load(into: state)
        #expect(state.notifyEnabled == true)
        SettingsStore.saveNotifyEnabled(false)
    }

    @MainActor
    @Test("save and load trigger enabled")
    func saveTriggerEnabled() {
        SettingsStore.saveTriggerEnabled(true)
        let state = AppState()
        SettingsStore.load(into: state)
        #expect(state.triggerEnabled == true)
        SettingsStore.saveTriggerEnabled(false)
    }
}
