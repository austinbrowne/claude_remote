#if os(iOS)
import Foundation
import UserNotifications
import Observation

/// Notification trigger types, ordered by priority (highest first)
public enum NotificationTrigger: Int, Comparable, Sendable {
    case permission = 0
    case question = 1
    case error = 2
    case status = 3

    public static func < (lhs: Self, rhs: Self) -> Bool {
        lhs.rawValue < rhs.rawValue
    }

    public var subtitle: String {
        switch self {
        case .permission: "Permission Required"
        case .question: "Question"
        case .error: "Error"
        case .status: "Status"
        }
    }

    public var hasSound: Bool {
        switch self {
        case .permission, .question, .error: true
        case .status: false
        }
    }

    public var categoryIdentifier: String {
        switch self {
        case .permission: "permission"
        case .question: "question"
        case .error: "error"
        case .status: "status"
        }
    }
}

/// Protocol for testability — wraps UNUserNotificationCenter interactions
public protocol NotificationScheduling: Sendable {
    func requestAuthorization() async -> Bool
    func checkAuthorizationStatus() async -> Bool
    func schedule(trigger: NotificationTrigger, sessionName: String, sessionId: String, body: String)
}

/// Manages local notification authorization, scheduling, throttling, and tap handling.
@Observable
@MainActor
public final class NotificationService: NSObject {
    /// Whether the user has granted notification permission at the iOS level
    public private(set) var isAuthorized = false

    /// Callback for when user taps a notification — provides the sessionId to navigate to
    public var onNotificationTap: (@MainActor (String) -> Void)?

    /// Reference to app state for checking notifyEnabled and isInForeground
    private weak var appState: AppState?

    /// Per-session throttle tracking: sessionId → (lastSentDate, lastTriggerPriority)
    private var throttleMap: [String: (date: Date, priority: NotificationTrigger)] = [:]

    /// Throttle cooldown in seconds
    static let cooldownSeconds: TimeInterval = 5

    /// Maximum body length for notification content
    static let maxBodyLength = 200

    public init(appState: AppState) {
        self.appState = appState
        super.init()
        UNUserNotificationCenter.current().delegate = self
        registerCategories()
    }

    // MARK: - Authorization

    /// Request notification authorization. Returns true if granted.
    public func requestAuthorization() async -> Bool {
        do {
            let granted = try await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound])
            isAuthorized = granted
            return granted
        } catch {
            isAuthorized = false
            return false
        }
    }

    /// Check current authorization status (call on app launch to sync state)
    public func checkAuthorizationStatus() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        isAuthorized = settings.authorizationStatus == .authorized
        // If user revoked in iOS Settings, reset the toggle
        if !isAuthorized, let appState, appState.notifyEnabled {
            appState.notifyEnabled = false
            SettingsStore.saveNotifyEnabled(false)
        }
    }

    // MARK: - Scheduling

    /// Schedule a notification if conditions are met (enabled, backgrounded, authorized, not throttled)
    public func scheduleIfNeeded(
        trigger: NotificationTrigger,
        sessionName: String,
        sessionId: String,
        body: String
    ) {
        guard let appState, appState.notifyEnabled, !appState.isInForeground, isAuthorized else {
            return
        }

        // Throttle check: skip if same session notified recently, unless higher priority
        if let existing = throttleMap[sessionId],
           Date().timeIntervalSince(existing.date) < Self.cooldownSeconds,
           trigger >= existing.priority {
            return
        }

        // Update throttle map
        throttleMap[sessionId] = (date: Date(), priority: trigger)
        cleanupThrottleMap()

        // Build notification content
        let content = UNMutableNotificationContent()
        content.title = sessionName
        content.subtitle = trigger.subtitle
        content.body = String(body.prefix(Self.maxBodyLength))
        content.threadIdentifier = sessionId
        content.categoryIdentifier = trigger.categoryIdentifier
        content.userInfo = ["sessionId": sessionId]

        if trigger.hasSound {
            content.sound = .default
        }

        // Fire immediately
        let request = UNNotificationRequest(
            identifier: "\(sessionId)-\(UUID().uuidString)",
            content: content,
            trigger: nil
        )

        UNUserNotificationCenter.current().add(request)
    }

    // MARK: - Private

    private func registerCategories() {
        let categories: Set<UNNotificationCategory> = [
            UNNotificationCategory(identifier: "permission", actions: [], intentIdentifiers: []),
            UNNotificationCategory(identifier: "question", actions: [], intentIdentifiers: []),
            UNNotificationCategory(identifier: "error", actions: [], intentIdentifiers: []),
            UNNotificationCategory(identifier: "status", actions: [], intentIdentifiers: []),
        ]
        UNUserNotificationCenter.current().setNotificationCategories(categories)
    }

    /// Remove expired entries from throttle map
    private func cleanupThrottleMap() {
        let cutoff = Date().addingTimeInterval(-Self.cooldownSeconds * 2)
        throttleMap = throttleMap.filter { $0.value.date > cutoff }
    }
}

// MARK: - UNUserNotificationCenterDelegate

extension NotificationService: UNUserNotificationCenterDelegate {
    /// Suppress banner when app is in foreground
    public nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        // Return empty options to suppress foreground display
        return []
    }

    /// Handle notification tap — navigate to the session
    public nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let userInfo = response.notification.request.content.userInfo
        guard let sessionId = userInfo["sessionId"] as? String else { return }
        await MainActor.run {
            onNotificationTap?(sessionId)
        }
    }
}
#endif
