import Foundation

/// UserDefaults-backed persistence for app settings.
/// Auth token is stored in Keychain (see KeychainService), not here.
@MainActor
public enum SettingsStore {
    private static let defaults = UserDefaults.standard

    // MARK: - Keys

    private enum Key {
        static let ttsEnabled = "settings.ttsEnabled"
        static let speakTools = "settings.speakTools"
        static let speechRate = "settings.speechRate"
        static let voiceIdentifier = "settings.voiceIdentifier"
        static let triggerEnabled = "triggerEnabled"  // matches existing key
        static let notifyEnabled = "settings.notifyEnabled"
        static let debugMode = "settings.debugMode"
        static let serverURL = "settings.serverURL"
        static let savedServers = "settings.savedServers"
    }

    // MARK: - Load

    /// Load all persisted settings into the given AppState
    @MainActor
    public static func load(into state: AppState) {
        state.ttsEnabled = defaults.bool(forKey: Key.ttsEnabled)
        state.speakTools = defaults.bool(forKey: Key.speakTools)
        state.notifyEnabled = defaults.bool(forKey: Key.notifyEnabled)
        state.debugMode = defaults.bool(forKey: Key.debugMode)
        state.triggerEnabled = defaults.bool(forKey: Key.triggerEnabled)
        state.voiceIdentifier = defaults.string(forKey: Key.voiceIdentifier)

        let rate = defaults.float(forKey: Key.speechRate)
        state.speechRate = rate > 0 ? rate : 1.0

        if let url = defaults.string(forKey: Key.serverURL), !url.isEmpty {
            state.serverURL = url
        }
    }

    // MARK: - Save Individual Settings

    public static func saveTTSEnabled(_ value: Bool) {
        defaults.set(value, forKey: Key.ttsEnabled)
    }

    public static func saveSpeakTools(_ value: Bool) {
        defaults.set(value, forKey: Key.speakTools)
    }

    public static func saveSpeechRate(_ value: Float) {
        defaults.set(value, forKey: Key.speechRate)
    }

    public static func saveVoiceIdentifier(_ value: String?) {
        defaults.set(value, forKey: Key.voiceIdentifier)
    }

    public static func saveTriggerEnabled(_ value: Bool) {
        defaults.set(value, forKey: Key.triggerEnabled)
    }

    public static func saveNotifyEnabled(_ value: Bool) {
        defaults.set(value, forKey: Key.notifyEnabled)
    }

    public static func saveDebugMode(_ value: Bool) {
        defaults.set(value, forKey: Key.debugMode)
    }

    public static func saveServerURL(_ value: String) {
        defaults.set(value, forKey: Key.serverURL)
    }

    // MARK: - Saved Servers

    /// Load saved servers from UserDefaults. Returns empty array on corrupt/missing data.
    public static func loadSavedServers() -> [SavedServer] {
        guard let data = defaults.data(forKey: Key.savedServers) else { return [] }
        return (try? JSONDecoder().decode([SavedServer].self, from: data)) ?? []
    }

    /// Save the saved servers list to UserDefaults.
    public static func saveSavedServers(_ servers: [SavedServer]) {
        guard let data = try? JSONEncoder().encode(servers) else { return }
        defaults.set(data, forKey: Key.savedServers)
    }

    /// Add a saved server if no duplicate URL exists. Returns true if added, false if duplicate.
    @discardableResult
    public static func addSavedServer(_ server: SavedServer) -> Bool {
        var servers = loadSavedServers()
        let canonical = URLHelper.canonicalize(server.url) ?? server.url
        if servers.contains(where: { $0.url == canonical }) {
            return false
        }
        servers.append(server)
        saveSavedServers(servers)
        return true
    }

    /// Update an existing saved server by ID.
    public static func updateSavedServer(_ server: SavedServer) {
        var servers = loadSavedServers()
        guard let index = servers.firstIndex(where: { $0.id == server.id }) else { return }
        servers[index] = server
        saveSavedServers(servers)
    }

    /// Remove a saved server by ID.
    public static func removeSavedServer(id: UUID) {
        var servers = loadSavedServers()
        servers.removeAll { $0.id == id }
        saveSavedServers(servers)
    }

    /// Find an existing saved server by canonical URL.
    public static func findSavedServer(byURL url: String) -> SavedServer? {
        let canonical = URLHelper.canonicalize(url) ?? url
        return loadSavedServers().first { $0.url == canonical }
    }
}
