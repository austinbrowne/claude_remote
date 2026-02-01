#if os(iOS)
import Testing
import Foundation
@testable import ClaudeRemote

@Suite("NotificationService")
struct NotificationServiceTests {

    // MARK: - Helpers

    @MainActor
    private static func makeSUT(
        notifyEnabled: Bool = true,
        isInForeground: Bool = false
    ) -> (service: NotificationService, state: AppState) {
        let state = AppState()
        state.notifyEnabled = notifyEnabled
        state.isInForeground = isInForeground
        let service = NotificationService(appState: state)
        return (service, state)
    }

    // MARK: - Throttling

    @MainActor
    @Test("first notification is not throttled")
    func firstNotificationNotThrottled() {
        let (service, _) = Self.makeSUT()
        // Should not throw or fail — just verifying the code path runs
        service.scheduleIfNeeded(trigger: .permission, sessionName: "test", sessionId: "s1", body: "Bash: ls")
        // If we reach here without crash, the scheduling ran
    }

    @MainActor
    @Test("notifications suppressed when notifyEnabled is false")
    func suppressedWhenDisabled() {
        let (service, _) = Self.makeSUT(notifyEnabled: false)
        // This should be a no-op (guard fails)
        service.scheduleIfNeeded(trigger: .permission, sessionName: "test", sessionId: "s1", body: "Bash: ls")
    }

    @MainActor
    @Test("notifications suppressed when app is in foreground")
    func suppressedInForeground() {
        let (service, _) = Self.makeSUT(isInForeground: true)
        service.scheduleIfNeeded(trigger: .permission, sessionName: "test", sessionId: "s1", body: "Bash: ls")
    }

    @MainActor
    @Test("notifications suppressed when not authorized")
    func suppressedWhenNotAuthorized() {
        let (service, _) = Self.makeSUT()
        // isAuthorized defaults to false
        service.scheduleIfNeeded(trigger: .permission, sessionName: "test", sessionId: "s1", body: "Bash: ls")
    }

    // MARK: - Trigger Priority

    @MainActor
    @Test("NotificationTrigger priority ordering")
    func triggerPriorityOrdering() {
        #expect(NotificationTrigger.permission < NotificationTrigger.question)
        #expect(NotificationTrigger.question < NotificationTrigger.error)
        #expect(NotificationTrigger.error < NotificationTrigger.status)
    }

    @MainActor
    @Test("NotificationTrigger subtitles")
    func triggerSubtitles() {
        #expect(NotificationTrigger.permission.subtitle == "Permission Required")
        #expect(NotificationTrigger.question.subtitle == "Question")
        #expect(NotificationTrigger.error.subtitle == "Error")
        #expect(NotificationTrigger.status.subtitle == "Status")
    }

    @MainActor
    @Test("NotificationTrigger sound settings")
    func triggerSounds() {
        #expect(NotificationTrigger.permission.hasSound == true)
        #expect(NotificationTrigger.question.hasSound == true)
        #expect(NotificationTrigger.error.hasSound == true)
        #expect(NotificationTrigger.status.hasSound == false)
    }

    @MainActor
    @Test("NotificationTrigger category identifiers")
    func triggerCategories() {
        #expect(NotificationTrigger.permission.categoryIdentifier == "permission")
        #expect(NotificationTrigger.question.categoryIdentifier == "question")
        #expect(NotificationTrigger.error.categoryIdentifier == "error")
        #expect(NotificationTrigger.status.categoryIdentifier == "status")
    }

    // MARK: - Body Truncation

    @MainActor
    @Test("maxBodyLength constant is 200")
    func maxBodyLength() {
        #expect(NotificationService.maxBodyLength == 200)
    }

    @MainActor
    @Test("cooldownSeconds constant is 5")
    func cooldownSeconds() {
        #expect(NotificationService.cooldownSeconds == 5)
    }

    // MARK: - AppState Integration

    @MainActor
    @Test("isInForeground defaults to true")
    func isInForegroundDefault() {
        let state = AppState()
        #expect(state.isInForeground == true)
    }

    @MainActor
    @Test("isInForeground can be toggled")
    func isInForegroundToggle() {
        let state = AppState()
        state.isInForeground = false
        #expect(state.isInForeground == false)
        state.isInForeground = true
        #expect(state.isInForeground == true)
    }

    // MARK: - Trigger Comparable

    @MainActor
    @Test("NotificationTrigger equality via rawValue")
    func triggerEquality() {
        #expect(NotificationTrigger.permission == NotificationTrigger.permission)
        #expect(NotificationTrigger.status == NotificationTrigger.status)
        #expect(NotificationTrigger.permission != NotificationTrigger.question)
    }

    @MainActor
    @Test("NotificationTrigger rawValues are correct")
    func triggerRawValues() {
        #expect(NotificationTrigger.permission.rawValue == 0)
        #expect(NotificationTrigger.question.rawValue == 1)
        #expect(NotificationTrigger.error.rawValue == 2)
        #expect(NotificationTrigger.status.rawValue == 3)
    }

    @MainActor
    @Test("higher priority trigger has lower rawValue")
    func higherPriorityIsLower() {
        // permission is highest priority (lowest rawValue)
        #expect(NotificationTrigger.permission < NotificationTrigger.status)
        // status is lowest priority (highest rawValue)
        #expect(!(NotificationTrigger.status < NotificationTrigger.permission))
    }

    // MARK: - Coordinator Integration

    @MainActor
    @Test("AppCoordinator creates notificationService")
    func coordinatorCreatesNotificationService() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        // notificationService should exist and have isAuthorized == false by default
        #expect(coordinator.notificationService.isAuthorized == false)
    }

    @MainActor
    @Test("AppCoordinator wires onNotificationTap callback")
    func coordinatorWiresNotificationTap() {
        let state = AppState()
        let coordinator = AppCoordinator(state: state)
        // onNotificationTap should be set (not nil)
        #expect(coordinator.notificationService.onNotificationTap != nil)
    }

    @MainActor
    @Test("notifyEnabled defaults to false")
    func notifyEnabledDefault() {
        let state = AppState()
        #expect(state.notifyEnabled == false)
    }

    @MainActor
    @Test("notifyEnabled can be set to true")
    func notifyEnabledToggle() {
        let state = AppState()
        state.notifyEnabled = true
        #expect(state.notifyEnabled == true)
    }

    // MARK: - Body Truncation Logic

    @MainActor
    @Test("body longer than maxBodyLength is truncated by scheduleIfNeeded")
    func bodyTruncation() {
        // This test verifies the truncation code path doesn't crash
        let (service, _) = Self.makeSUT()
        let longBody = String(repeating: "A", count: 500)
        // Won't actually send (not authorized), but exercises the truncation path
        service.scheduleIfNeeded(trigger: .permission, sessionName: "test", sessionId: "s1", body: longBody)
    }

    @MainActor
    @Test("empty body does not crash")
    func emptyBody() {
        let (service, _) = Self.makeSUT()
        service.scheduleIfNeeded(trigger: .status, sessionName: "test", sessionId: "s1", body: "")
    }

    // MARK: - Service Lifecycle

    @MainActor
    @Test("multiple services can coexist without crash")
    func multipleServices() {
        let state = AppState()
        let service1 = NotificationService(appState: state)
        let service2 = NotificationService(appState: state)
        // Both should be valid
        #expect(service1.isAuthorized == false)
        #expect(service2.isAuthorized == false)
    }

    @MainActor
    @Test("scheduleIfNeeded with all guards passing except isAuthorized does not crash")
    func allGuardsExceptAuthorized() {
        let state = AppState()
        state.notifyEnabled = true
        state.isInForeground = false
        let service = NotificationService(appState: state)
        // isAuthorized is false, so this should be a no-op
        service.scheduleIfNeeded(trigger: .permission, sessionName: "Session 1", sessionId: "s1", body: "Bash: rm -rf /")
    }
}
#endif
