import SwiftUI
import ClaudeRemote

@main
@MainActor
struct ClaudeRemoteApp: App {
    @State private var appState: AppState
    @State private var coordinator: AppCoordinator
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let state = AppState()
        let coord = AppCoordinator(state: state)
        _appState = State(initialValue: state)
        _coordinator = State(initialValue: coord)
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(appState)
                .environment(coordinator)
                #if os(iOS)
                .environment(coordinator.speechService)
                .task {
                    // Check notification authorization status on launch
                    await coordinator.notificationService.checkAuthorizationStatus()
                    // Defer audio setup — configureAudioSession/setActive can block
                    // the main thread for seconds. Only set up if trigger is enabled,
                    // and yield first so the UI renders.
                    if coordinator.state.triggerEnabled {
                        try? await Task.sleep(for: .milliseconds(500))
                        do {
                            try coordinator.speechService.configureAudioSession(forBackground: true)
                            try coordinator.speechService.startTriggerListening()
                        } catch {
                            print("[App] Trigger startup failed: \(error)")
                            coordinator.state.triggerEnabled = false
                            SettingsStore.saveTriggerEnabled(false)
                        }
                    }
                }
                #endif
                .onChange(of: scenePhase) { _, newPhase in
                    appState.isInForeground = newPhase == .active
                }
        }
    }
}
