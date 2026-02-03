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
                    // Audio session is configured lazily when trigger/mic is first used
                    // via setTriggerEnabled or startListening — NOT on launch.
                    // Calling setActive on MainActor at startup hangs the UI after crashes.
                }
                #endif
                .onChange(of: scenePhase) { _, newPhase in
                    appState.isInForeground = newPhase == .active
                    #if os(iOS)
                    if newPhase == .active {
                        coordinator.restoreTriggerIfNeeded()
                    }
                    #endif
                }
        }
    }
}
