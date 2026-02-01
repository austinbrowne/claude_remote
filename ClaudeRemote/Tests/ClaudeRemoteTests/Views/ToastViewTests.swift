import Testing
import Foundation
@testable import ClaudeRemote

@Suite("ToastItem")
struct ToastItemTests {

    @Test("ToastItem initializes with correct values")
    func initialization() {
        let toast = ToastItem(message: "Connected", icon: "wifi", style: .success)
        #expect(toast.message == "Connected")
        #expect(toast.icon == "wifi")
        #expect(toast.style == .success)
    }

    @Test("ToastItem equality based on id")
    func equality() {
        let a = ToastItem(message: "A", icon: "wifi", style: .info)
        let b = ToastItem(message: "A", icon: "wifi", style: .info)
        // Different instances have different UUIDs
        #expect(a != b)
        // Same instance equals itself
        #expect(a == a)
    }

    @Test("ToastItem identifiable id is unique")
    func uniqueIds() {
        let a = ToastItem(message: "Same", icon: "wifi", style: .info)
        let b = ToastItem(message: "Same", icon: "wifi", style: .info)
        #expect(a.id != b.id)
    }

    @Test("ToastStyle cases exist")
    func styleCases() {
        let styles: [ToastItem.ToastStyle] = [.info, .success, .warning, .error]
        #expect(styles.count == 4)
    }
}

@Suite("AppState Toast")
struct AppStateToastTests {

    @MainActor
    @Test("showToast sets currentToast")
    func showToast() {
        let state = AppState()
        #expect(state.currentToast == nil)
        state.showToast("Hello", icon: "star", style: .info)
        #expect(state.currentToast != nil)
        #expect(state.currentToast?.message == "Hello")
        #expect(state.currentToast?.icon == "star")
        #expect(state.currentToast?.style == .info)
    }

    @MainActor
    @Test("showToast replaces existing toast")
    func replacesToast() {
        let state = AppState()
        state.showToast("First", icon: "1.circle", style: .info)
        let firstId = state.currentToast?.id
        state.showToast("Second", icon: "2.circle", style: .warning)
        #expect(state.currentToast?.message == "Second")
        #expect(state.currentToast?.id != firstId)
    }

    @MainActor
    @Test("showToast default style is info")
    func defaultStyle() {
        let state = AppState()
        state.showToast("Test", icon: "star")
        #expect(state.currentToast?.style == .info)
    }
}
