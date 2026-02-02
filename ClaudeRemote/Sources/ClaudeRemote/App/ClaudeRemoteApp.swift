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
                    let forBackground = coordinator.state.triggerEnabled
                    do {
                        try coordinator.speechService.configureAudioSession(forBackground: forBackground)
                        if forBackground {
                            try coordinator.speechService.startTriggerListening()
                        }
                    } catch {
                        // Disable trigger to prevent boot-loop crash
                        print("[App] Trigger startup failed: \(error)")
                        coordinator.state.triggerEnabled = false
                        SettingsStore.saveTriggerEnabled(false)
                    }
                    // Check notification authorization status on launch
                    await coordinator.notificationService.checkAuthorizationStatus()
                }
                #endif
                .onChange(of: scenePhase) { _, newPhase in
                    appState.isInForeground = newPhase == .active
                }
        }
    }
}
