import Testing
import Foundation
@testable import ClaudeRemote

@Suite("AudioRoutePolicy – Route Change Classification")
struct AudioRouteClassificationTests {

    // MARK: - Reasons that trigger restart

    @Test("newDeviceAvailable triggers restart with reactivation")
    func newDeviceAvailable() {
        let action = AudioRoutePolicy.classify(reasonValue: AudioRoutePolicy.Reason.newDeviceAvailable.rawValue)
        #expect(action == .restartWithReactivation)
    }

    @Test("oldDeviceUnavailable triggers restart with reactivation")
    func oldDeviceUnavailable() {
        let action = AudioRoutePolicy.classify(reasonValue: AudioRoutePolicy.Reason.oldDeviceUnavailable.rawValue)
        #expect(action == .restartWithReactivation)
    }

    @Test("categoryChange triggers restart (Bluetooth HFP profile switch)")
    func categoryChange() {
        let action = AudioRoutePolicy.classify(reasonValue: AudioRoutePolicy.Reason.categoryChange.rawValue)
        #expect(action == .restartWithReactivation)
    }

    @Test("override triggers restart")
    func overrideReason() {
        let action = AudioRoutePolicy.classify(reasonValue: AudioRoutePolicy.Reason.override.rawValue)
        #expect(action == .restartWithReactivation)
    }

    @Test("routeConfigurationChange triggers restart")
    func routeConfigurationChange() {
        let action = AudioRoutePolicy.classify(reasonValue: AudioRoutePolicy.Reason.routeConfigurationChange.rawValue)
        #expect(action == .restartWithReactivation)
    }

    // MARK: - Reasons that are ignored

    @Test("unknown reason is ignored")
    func unknownIgnored() {
        let action = AudioRoutePolicy.classify(reasonValue: AudioRoutePolicy.Reason.unknown.rawValue)
        #expect(action == .ignore)
    }

    @Test("wakeFromSleep is ignored")
    func wakeFromSleepIgnored() {
        let action = AudioRoutePolicy.classify(reasonValue: AudioRoutePolicy.Reason.wakeFromSleep.rawValue)
        #expect(action == .ignore)
    }

    @Test("noSuitableRouteForCategory is ignored")
    func noSuitableRouteIgnored() {
        let action = AudioRoutePolicy.classify(reasonValue: AudioRoutePolicy.Reason.noSuitableRouteForCategory.rawValue)
        #expect(action == .ignore)
    }

    @Test("undefined raw value (99) is ignored")
    func undefinedReasonIgnored() {
        let action = AudioRoutePolicy.classify(reasonValue: 99)
        #expect(action == .ignore)
    }

    // MARK: - All Bluetooth-relevant reasons covered

    @Test("all 5 restart reasons are Bluetooth-relevant", .tags(.bluetooth))
    func allBluetoothReasons() {
        let restartReasons: [AudioRoutePolicy.Reason] = [
            .newDeviceAvailable,
            .oldDeviceUnavailable,
            .categoryChange,
            .override,
            .routeConfigurationChange
        ]
        for reason in restartReasons {
            let action = AudioRoutePolicy.classify(reasonValue: reason.rawValue)
            #expect(action == .restartWithReactivation, "Reason \(reason) should trigger restart")
        }
    }

    @Test("all 3 ignored reasons won't interfere with active recognition")
    func allIgnoredReasons() {
        let ignoredReasons: [AudioRoutePolicy.Reason] = [
            .unknown,
            .wakeFromSleep,
            .noSuitableRouteForCategory
        ]
        for reason in ignoredReasons {
            let action = AudioRoutePolicy.classify(reasonValue: reason.rawValue)
            #expect(action == .ignore, "Reason \(reason) should be ignored")
        }
    }
}

@Suite("AudioRoutePolicy – Safe Teardown Guards")
struct AudioTeardownGuardTests {

    // MARK: - Engine valid, tap installed

    @Test("valid engine with tap: should stop and remove tap")
    func validEngineWithTap() {
        let result = AudioRoutePolicy.canSafelyTeardown(engineValid: true, tapInstalled: true)
        #expect(result.shouldStop == true)
        #expect(result.shouldRemoveTap == true)
    }

    @Test("valid engine without tap: should stop but not remove tap")
    func validEngineWithoutTap() {
        let result = AudioRoutePolicy.canSafelyTeardown(engineValid: true, tapInstalled: false)
        #expect(result.shouldStop == true)
        #expect(result.shouldRemoveTap == false)
    }

    // MARK: - Engine invalid (post media services reset)

    @Test("invalid engine: should not stop or remove tap (prevents ObjC exception)")
    func invalidEngineNoAccess() {
        let result = AudioRoutePolicy.canSafelyTeardown(engineValid: false, tapInstalled: true)
        #expect(result.shouldStop == false)
        #expect(result.shouldRemoveTap == false)
    }

    @Test("invalid engine without tap: should not access engine at all")
    func invalidEngineNoTapNoAccess() {
        let result = AudioRoutePolicy.canSafelyTeardown(engineValid: false, tapInstalled: false)
        #expect(result.shouldStop == false)
        #expect(result.shouldRemoveTap == false)
    }
}

@Suite("AudioRoutePolicy – State Transition Scenarios")
struct AudioStateTransitionTests {

    /// Simulates the state machine transitions for audio engine lifecycle.
    /// This mirrors the SpeechService internal state without requiring iOS APIs.
    struct AudioState {
        var audioEngineValid = true
        var hasTapInstalled = false
        var audioSessionConfigured = false
        var isRestarting = false

        /// Simulate what handleMediaServicesReset does
        mutating func handleMediaServicesReset() {
            audioEngineValid = false
            hasTapInstalled = false
            simulateTeardown()
            recreateEngine()
            audioSessionConfigured = false
        }

        /// Simulate what recreateAudioEngine does
        mutating func recreateEngine() {
            audioEngineValid = true
            hasTapInstalled = false
        }

        /// Simulate teardownRecognition guard logic
        mutating func simulateTeardown() {
            let guards = AudioRoutePolicy.canSafelyTeardown(
                engineValid: audioEngineValid,
                tapInstalled: hasTapInstalled
            )
            if guards.shouldRemoveTap {
                hasTapInstalled = false
            }
        }

        /// Simulate successful recognition start (tap installed)
        mutating func startRecognition() {
            hasTapInstalled = true
            audioSessionConfigured = true
        }

        /// Simulate route change handler
        mutating func handleRouteChange(reasonValue: UInt) -> Bool {
            let action = AudioRoutePolicy.classify(reasonValue: reasonValue)
            guard action == .restartWithReactivation else { return false }
            audioSessionConfigured = false
            return true
        }
    }

    @Test("media services reset: teardown skips inputNode, engine recreated")
    func mediaServicesResetCycle() {
        var state = AudioState()
        state.startRecognition()
        #expect(state.audioEngineValid == true)
        #expect(state.hasTapInstalled == true)

        // Media services reset — engine becomes invalid
        state.handleMediaServicesReset()

        // Engine should be recreated and valid
        #expect(state.audioEngineValid == true)
        #expect(state.hasTapInstalled == false)
        #expect(state.audioSessionConfigured == false)
    }

    @Test("normal teardown with active tap: removes tap")
    func normalTeardownRemovesTap() {
        var state = AudioState()
        state.startRecognition()
        #expect(state.hasTapInstalled == true)

        state.simulateTeardown()
        #expect(state.hasTapInstalled == false)
    }

    @Test("teardown without tap: no-op on tap removal")
    func teardownWithoutTapIsNoop() {
        var state = AudioState()
        #expect(state.hasTapInstalled == false)

        state.simulateTeardown()
        #expect(state.hasTapInstalled == false)
    }

    @Test("Bluetooth route change resets audioSessionConfigured")
    func bluetoothRouteResetsSession() {
        var state = AudioState()
        state.startRecognition()
        #expect(state.audioSessionConfigured == true)

        // Simulate Bluetooth device connecting
        let shouldRestart = state.handleRouteChange(
            reasonValue: AudioRoutePolicy.Reason.newDeviceAvailable.rawValue
        )
        #expect(shouldRestart == true)
        #expect(state.audioSessionConfigured == false)
    }

    @Test("ignored route change does not reset audioSessionConfigured")
    func ignoredRoutePreservesSession() {
        var state = AudioState()
        state.startRecognition()
        #expect(state.audioSessionConfigured == true)

        let shouldRestart = state.handleRouteChange(
            reasonValue: AudioRoutePolicy.Reason.wakeFromSleep.rawValue
        )
        #expect(shouldRestart == false)
        #expect(state.audioSessionConfigured == true)
    }

    @Test("rapid Bluetooth connect/disconnect: each resets session config")
    func rapidBluetoothChanges() {
        var state = AudioState()
        state.startRecognition()

        // First: device connects
        let r1 = state.handleRouteChange(
            reasonValue: AudioRoutePolicy.Reason.newDeviceAvailable.rawValue
        )
        #expect(r1 == true)
        #expect(state.audioSessionConfigured == false)

        // Simulate restart completing
        state.startRecognition()
        #expect(state.audioSessionConfigured == true)

        // Second: device disconnects
        let r2 = state.handleRouteChange(
            reasonValue: AudioRoutePolicy.Reason.oldDeviceUnavailable.rawValue
        )
        #expect(r2 == true)
        #expect(state.audioSessionConfigured == false)
    }

    @Test("HFP category change during active recognition triggers restart")
    func hfpCategoryChangeTriggersRestart() {
        var state = AudioState()
        state.startRecognition()

        let shouldRestart = state.handleRouteChange(
            reasonValue: AudioRoutePolicy.Reason.categoryChange.rawValue
        )
        #expect(shouldRestart == true)
        #expect(state.audioSessionConfigured == false)
    }

    @Test("full Bluetooth lifecycle: connect → record → disconnect → media reset → recover")
    func fullBluetoothLifecycle() {
        var state = AudioState()

        // 1. Connect Bluetooth
        _ = state.handleRouteChange(reasonValue: AudioRoutePolicy.Reason.newDeviceAvailable.rawValue)
        #expect(state.audioSessionConfigured == false)

        // 2. Start recording
        state.startRecognition()
        #expect(state.audioEngineValid == true)
        #expect(state.hasTapInstalled == true)
        #expect(state.audioSessionConfigured == true)

        // 3. Bluetooth disconnects
        _ = state.handleRouteChange(reasonValue: AudioRoutePolicy.Reason.oldDeviceUnavailable.rawValue)
        #expect(state.audioSessionConfigured == false)

        // 4. Media services reset (worst case)
        state.handleMediaServicesReset()
        #expect(state.audioEngineValid == true)  // New engine created
        #expect(state.hasTapInstalled == false)
        #expect(state.audioSessionConfigured == false)

        // 5. Recovery — start recording again
        state.startRecognition()
        #expect(state.audioEngineValid == true)
        #expect(state.hasTapInstalled == true)
        #expect(state.audioSessionConfigured == true)
    }
}

extension Tag {
    @Tag static var bluetooth: Self
}
