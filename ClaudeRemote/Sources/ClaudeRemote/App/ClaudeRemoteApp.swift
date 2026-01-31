import SwiftUI

@main
@MainActor
struct ClaudeRemoteApp: App {
    @State private var appState: AppState
    @State private var coordinator: AppCoordinator

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
        }
    }
}
