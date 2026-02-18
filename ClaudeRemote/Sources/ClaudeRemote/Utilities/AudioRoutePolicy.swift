import Foundation

/// Classifies audio route change reasons and manages audio engine teardown guards.
/// Platform-independent — uses raw UInt values matching AVAudioSession.RouteChangeReason
/// to enable unit testing on macOS (where AVAudioSession isn't available).
public enum AudioRoutePolicy {

    /// Action to take when an audio route change occurs
    public enum Action: Equatable, Sendable {
        /// Restart recognition with fresh audio session (forces reactivation)
        case restartWithReactivation
        /// No action needed — this route change doesn't affect recognition
        case ignore
    }

    /// Well-known AVAudioSession.RouteChangeReason raw values.
    /// Defined here so tests don't depend on AVFoundation.
    public enum Reason: UInt, Sendable {
        case unknown = 0
        case newDeviceAvailable = 1
        case oldDeviceUnavailable = 2
        case categoryChange = 3
        case `override` = 4
        case wakeFromSleep = 5
        case noSuitableRouteForCategory = 6
        case routeConfigurationChange = 7
    }

    /// Classify a route change reason into an action.
    /// Covers all Bluetooth-relevant reasons: device connect/disconnect,
    /// HFP profile switches (categoryChange), overrides, and reconfigurations.
    public static func classify(reasonValue: UInt) -> Action {
        guard let reason = Reason(rawValue: reasonValue) else { return .ignore }
        switch reason {
        case .newDeviceAvailable, .oldDeviceUnavailable,
             .categoryChange, .override, .routeConfigurationChange:
            return .restartWithReactivation
        case .unknown, .wakeFromSleep, .noSuitableRouteForCategory:
            return .ignore
        }
    }

    /// Whether it's safe to access the audio engine's inputNode for teardown.
    /// After media services reset, the engine is invalid and accessing inputNode
    /// can throw an ObjC exception that Swift can't catch.
    public static func canSafelyTeardown(engineValid: Bool, tapInstalled: Bool) -> (shouldStop: Bool, shouldRemoveTap: Bool) {
        guard engineValid else { return (shouldStop: false, shouldRemoveTap: false) }
        return (shouldStop: true, shouldRemoveTap: tapInstalled)
    }
}
