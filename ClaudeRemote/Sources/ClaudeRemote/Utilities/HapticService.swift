#if os(iOS)
import UIKit

/// Centralized haptic feedback for key user actions
public enum HapticService {
    /// Light tap — send message, toggle setting
    public static func light() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    /// Medium tap — prompt card received, session switched
    public static func medium() {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    }

    /// Heavy tap — trigger word detected
    public static func heavy() {
        UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
    }

    /// Success notification — command sent, permission granted
    public static func success() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    /// Warning notification — disconnected, error
    public static func warning() {
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }

    /// Error notification — auth failed
    public static func error() {
        UINotificationFeedbackGenerator().notificationOccurred(.error)
    }
}
#endif
