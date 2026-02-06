#if os(iOS)
import Speech
import AVFoundation
import Observation

/// Errors from speech recognition setup
public enum SpeechError: Error, CustomStringConvertible {
    case invalidAudioFormat
    case authorizationDenied
    case authorizationPending
    case onDeviceRecognitionUnavailable

    public var description: String {
        switch self {
        case .invalidAudioFormat: return "Invalid audio format — no microphone available"
        case .authorizationDenied: return "Speech recognition permission denied"
        case .authorizationPending: return "Requesting speech recognition permission"
        case .onDeviceRecognitionUnavailable: return "On-device speech recognition unavailable"
        }
    }
}

/// Result of attempting to start trigger listening
public enum TriggerStartResult: Sendable {
    case started
    case authorizationPending
    case failed(String)
}

/// Trigger word detection state machine
public enum TriggerState: Sendable, Equatable {
    case idle
    case listening
    case capturing
    case cooldown
}

/// Voice I/O service providing speech-to-text via SFSpeechRecognizer
/// and text-to-speech via AVSpeechSynthesizer.
///
/// Supports three modes:
/// - **Manual**: Tap mic button, transcript fills text field
/// - **Auto**: TTS reads prompts aloud, listens for voice response, matches and submits
/// - **Trigger**: Always-on "Titus" wake word detection with command capture
@Observable
@MainActor
public final class SpeechService {

    // MARK: - Public State

    public private(set) var isListening = false
    public private(set) var transcript = ""
    public private(set) var isSpeaking = false
    public private(set) var triggerState: TriggerState = .idle

    /// When true, TTS reads prompts and listens for voice responses
    public var isAutoMode = false

    /// Called on each transcript update (partial or final). Used by AppCoordinator
    /// to dispatch auto-mode voice matching while recognition is active.
    public var onTranscriptUpdate: ((String) -> Void)?

    /// Called when trigger mode captures a complete command to send.
    public var onTriggerCommand: ((String) -> Void)?

    /// Called when an error occurs that should be surfaced to the user via toast.
    public var onError: ((String) -> Void)?

    /// Whether the audio engine is currently running (for external liveness checks)
    public var isAudioEngineRunning: Bool { audioEngine.isRunning }

    // MARK: - Trigger Word Config

    /// Silence duration before auto-sending captured command
    private static let silenceTimeout: TimeInterval = 3.0

    /// Cooldown after sending a command before resuming trigger listening
    private static let cooldownDuration: TimeInterval = 0.3

    // MARK: - Private State

    private let speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let audioEngine = AVAudioEngine()
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private let synthesizer = AVSpeechSynthesizer()
    private var synthesizerDelegate: SynthesizerDelegate?
    nonisolated(unsafe) private var restartTask: Task<Void, Never>?

    /// Incremented on each new recognition session so stale callbacks are ignored
    private var recognitionGeneration = 0

    /// Stored observer token for audio interruption notifications
    nonisolated(unsafe) private var interruptionObserver: (any NSObjectProtocol)?

    /// Stored observer token for media services reset notifications
    nonisolated(unsafe) private var mediaResetObserver: (any NSObjectProtocol)?

    /// Stored observer token for audio route change notifications
    nonisolated(unsafe) private var routeChangeObserver: (any NSObjectProtocol)?

    /// Retry attempt counter for exponential backoff
    private var retryCount = 0
    private static let maxRetries = 5
    nonisolated(unsafe) private var retryTask: Task<Void, Never>?

    /// Guard against concurrent restart cycles
    private var isRestarting = false

    /// Whether recognition is running in trigger mode (vs manual mode)
    private var isInTriggerMode = false

    /// Captured command text after trigger word detected
    private var capturedCommand = ""

    /// Last transcript length used to detect silence (no new text = silence)
    private var lastTranscriptLength = 0

    /// Timer task for 3-second silence auto-send
    nonisolated(unsafe) private var silenceTask: Task<Void, Never>?

    /// Stored cooldown task — cancellable when trigger is stopped
    nonisolated(unsafe) private var cooldownTask: Task<Void, Never>?

    /// True when trigger listening is paused for higher-priority audio
    private var triggerPaused = false

    // MARK: - Init

    public init() {}

    deinit {
        silenceTask?.cancel()
        restartTask?.cancel()
        cooldownTask?.cancel()
        retryTask?.cancel()
        if let observer = interruptionObserver {
            NotificationCenter.default.removeObserver(observer)
        }
        if let observer = mediaResetObserver {
            NotificationCenter.default.removeObserver(observer)
        }
        if let observer = routeChangeObserver {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    // MARK: - Audio Session

    /// Whether the audio session has been configured at least once.
    /// Internal so AppCoordinator can reset it on foreground return.
    var audioSessionConfigured = false

    /// Configure the shared audio session for play-and-record.
    /// Pass `forBackground: true` when trigger mode is active to add `.mixWithOthers`.
    /// Safe to call multiple times — skips `setActive` if already active.
    public func configureAudioSession(forBackground: Bool = false) throws {
        let session = AVAudioSession.sharedInstance()
        var options: AVAudioSession.CategoryOptions = [.defaultToSpeaker, .allowBluetooth]
        if forBackground {
            options.insert(.mixWithOthers)
        }
        try session.setCategory(.playAndRecord, options: options)
        // Only call setActive on first configuration — once active, the session
        // stays active until we explicitly deactivate or iOS interrupts (handled
        // by the interruption handler which reactivates on resume).
        if !audioSessionConfigured {
            try session.setActive(true)
        }
        audioSessionConfigured = true

        // Only register interruption observer once
        if interruptionObserver == nil {
            interruptionObserver = NotificationCenter.default.addObserver(
                forName: AVAudioSession.interruptionNotification,
                object: session,
                queue: .main
            ) { [weak self] notification in
                let typeValue = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
                let optionsValue = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt
                self?.handleAudioInterruption(typeValue: typeValue, optionsValue: optionsValue)
            }
        }

        // Register media services reset observer (once only)
        if mediaResetObserver == nil {
            mediaResetObserver = NotificationCenter.default.addObserver(
                forName: AVAudioSession.mediaServicesWereResetNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                self?.handleMediaServicesReset()
            }
        }

        // Register route change observer (once only)
        if routeChangeObserver == nil {
            routeChangeObserver = NotificationCenter.default.addObserver(
                forName: AVAudioSession.routeChangeNotification,
                object: session,
                queue: .main
            ) { [weak self] notification in
                let reasonValue = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
                self?.handleRouteChange(reasonValue: reasonValue)
            }
        }
    }

    /// Ensure the audio session is configured before using the audio engine.
    /// Called lazily from beginRecognition — avoids blocking app launch.
    private func ensureAudioSession(forBackground: Bool = false) throws {
        if !audioSessionConfigured {
            try configureAudioSession(forBackground: forBackground)
        }
    }

    private func handleAudioInterruption(typeValue: UInt?, optionsValue: UInt?) {
        guard let typeValue, let type = AVAudioSession.InterruptionType(rawValue: typeValue) else { return }

        switch type {
        case .began:
            if isListening { stopListening() }
            if isSpeaking { stopSpeaking() }
            if triggerState == .listening || triggerState == .capturing {
                stopTriggerListening()
                triggerPaused = true
            }
        case .ended:
            let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue ?? 0)
            if options.contains(.shouldResume) {
                // Reactivate audio session off main thread to avoid blocking UI.
                // Resume trigger listening on MainActor once activation succeeds.
                Task.detached { [weak self] in
                    try? AVAudioSession.sharedInstance().setActive(true)
                    await MainActor.run {
                        guard let self else { return }
                        if self.triggerPaused {
                            self.triggerPaused = false
                            try? self.startTriggerListening()
                        }
                    }
                }
            }
        @unknown default:
            break
        }
    }

    /// Handle iOS media services reset — the audio engine is now invalid and must be recreated.
    private func handleMediaServicesReset() {
        print("[Speech] Media services were reset — recreating audio engine")
        teardownRecognition()

        // The old audio engine is dead. Create a new one.
        recreateAudioEngine()
        audioSessionConfigured = false

        // Restart trigger if it was active
        if isInTriggerMode && (triggerState == .listening || triggerState == .capturing) {
            scheduleRetry()
        }
    }

    /// Replace the audio engine after media services reset.
    /// AVAudioEngine is invalidated when media services reset — it cannot be reused.
    private func recreateAudioEngine() {
        if audioEngine.isRunning { audioEngine.stop() }
        audioEngine.inputNode.removeTap(onBus: 0)
        audioEngine.reset()
    }

    /// Handle audio route changes (headphones, Bluetooth, etc.)
    private func handleRouteChange(reasonValue: UInt?) {
        guard let reasonValue,
              let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue) else { return }

        switch reason {
        case .oldDeviceUnavailable, .newDeviceAvailable:
            print("[Speech] Audio route changed (reason: \(reason.rawValue)) — restarting recognition")
            if isInTriggerMode && (triggerState == .listening || triggerState == .capturing) {
                restartTriggerRecognition()
            } else if isListening {
                restartRecognition()
            }
        default:
            break
        }
    }

    // MARK: - Manual Recognition (STT)

    /// Start listening for speech input (manual mic mode).
    /// On first use, requests authorization and auto-starts after grant (no double-tap).
    public func startListening() throws {
        // Pause trigger if active (manual mic takes priority)
        if triggerState == .listening || triggerState == .capturing || triggerState == .cooldown {
            stopTriggerListening()
            triggerPaused = true
        }

        let authStatus = SFSpeechRecognizer.authorizationStatus()
        if authStatus == .notDetermined {
            SFSpeechRecognizer.requestAuthorization { [weak self] status in
                DispatchQueue.main.async {
                    guard let self else { return }
                    if status == .authorized {
                        // Auto-start after authorization grant — no second tap needed
                        do {
                            try self.startListening()
                        } catch {
                            self.onError?("Mic failed: \(error.localizedDescription)")
                        }
                    } else {
                        self.onError?(SpeechError.authorizationDenied.description)
                    }
                }
            }
            return
        }
        guard authStatus == .authorized else {
            throw SpeechError.authorizationDenied
        }

        teardownRecognition()
        recognitionGeneration += 1
        isInTriggerMode = false
        try beginRecognition()
    }

    /// Stop listening for speech input (manual mic mode)
    public func stopListening() {
        restartTask?.cancel()
        restartTask = nil
        recognitionGeneration += 1
        teardownRecognition()
        isListening = false

        // Resume trigger if it was paused for manual mic
        if triggerPaused {
            triggerPaused = false
            try? startTriggerListening()
        }
    }

    /// Toggle listening on/off (manual mic)
    public func toggleListening() throws {
        if isListening {
            stopListening()
        } else {
            try startListening()
        }
    }

    // MARK: - Trigger Word Recognition

    /// Start trigger word listening (background-capable, always-on).
    /// Returns the start result so callers can handle auth deferral / failure.
    @discardableResult
    public func startTriggerListening() throws -> TriggerStartResult {
        guard triggerState == .idle || triggerState == .cooldown else { return .started }

        // Don't start if manual listening or TTS is active
        if isListening || isSpeaking { return .failed("Audio in use") }

        let authStatus = SFSpeechRecognizer.authorizationStatus()
        if authStatus == .notDetermined {
            SFSpeechRecognizer.requestAuthorization { [weak self] status in
                DispatchQueue.main.async {
                    guard let self else { return }
                    if status == .authorized {
                        do {
                            try self.startTriggerListening()
                        } catch {
                            self.onError?("Trigger word failed: \(error.localizedDescription)")
                        }
                    } else {
                        self.onError?(SpeechError.authorizationDenied.description)
                    }
                }
            }
            return .authorizationPending
        }
        guard authStatus == .authorized else {
            throw SpeechError.authorizationDenied
        }

        teardownRecognition()
        recognitionGeneration += 1
        isInTriggerMode = true
        capturedCommand = ""
        lastTranscriptLength = 0
        triggerState = .listening
        try beginRecognition()
        retryCount = 0
        return .started
    }

    /// Stop trigger word listening
    public func stopTriggerListening() {
        cooldownTask?.cancel()
        cooldownTask = nil
        retryTask?.cancel()
        retryTask = nil
        retryCount = 0
        silenceTask?.cancel()
        silenceTask = nil
        restartTask?.cancel()
        restartTask = nil
        recognitionGeneration += 1
        teardownRecognition()
        triggerState = .idle
        isInTriggerMode = false
        capturedCommand = ""
    }

    // MARK: - Priority Arbitration

    /// Pause trigger listening for TTS playback. Call before speak().
    public func pauseTriggerForTTS() {
        if triggerState == .listening || triggerState == .capturing || triggerState == .cooldown {
            stopTriggerListening()
            triggerPaused = true
        }
    }

    /// Resume trigger listening after TTS or manual mic finishes.
    public func resumeTriggerIfPaused() {
        if triggerPaused {
            triggerPaused = false
            try? startTriggerListening()
        }
    }

    // MARK: - Recognition Core

    /// Start a new recognition session. Used by both manual and trigger modes.
    private func beginRecognition() throws {
        try ensureAudioSession(forBackground: isInTriggerMode)

        let gen = recognitionGeneration

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        if isInTriggerMode {
            // Prefer on-device recognition for always-on trigger mode (battery, privacy).
            // Fall back to server-based if on-device is unavailable on this device.
            if speechRecognizer?.supportsOnDeviceRecognition == true {
                request.requiresOnDeviceRecognition = true
            } else {
                print("[Speech] On-device recognition unavailable — falling back to server-based for trigger mode")
            }
        }
        recognitionRequest = request

        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)

        // Guard against invalid format — happens when audio session isn't ready,
        // no input route exists, or hardware isn't initialized yet.
        // installTap crashes with a CoreAudio assertion if sampleRate is 0.
        guard recordingFormat.sampleRate > 0, recordingFormat.channelCount > 0 else {
            print("[Speech] Invalid audio format: sampleRate=\(recordingFormat.sampleRate) channels=\(recordingFormat.channelCount)")
            teardownRecognition()
            if isInTriggerMode {
                scheduleRetry()
                return
            }
            isListening = false
            onError?(SpeechError.invalidAudioFormat.description)
            throw SpeechError.invalidAudioFormat
        }

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { [weak request] buffer, _ in
            request?.append(buffer)
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            print("[Speech] Audio engine failed to start: \(error)")
            teardownRecognition()
            if isInTriggerMode {
                scheduleRetry()
                return
            }
            isListening = false
            throw error
        }

        if !isInTriggerMode {
            transcript = ""
            isListening = true
        }

        recognitionTask = speechRecognizer?.recognitionTask(with: request) { result, error in
            DispatchQueue.main.async { [weak self] in
                guard let self, gen == self.recognitionGeneration else { return }
                if let result {
                    let text = result.bestTranscription.formattedString
                    if self.isInTriggerMode {
                        self.handleTriggerResult(text, isFinal: result.isFinal)
                    } else {
                        self.transcript = text
                        if !text.isEmpty {
                            self.onTranscriptUpdate?(text)
                        }
                    }
                }
                if error != nil || (result?.isFinal == true) {
                    if self.isInTriggerMode {
                        // Recognition ended — restart for next trigger window
                        self.restartTriggerRecognition()
                    } else {
                        self.stopListening()
                    }
                }
            }
        }

        // Schedule 55-second seamless restart
        restartTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(55))
            guard !Task.isCancelled, let self else { return }
            if self.isInTriggerMode && (self.triggerState == .listening || self.triggerState == .capturing) {
                self.restartTriggerRecognition()
            } else if self.isListening {
                self.restartRecognition()
            }
        }
    }

    /// Seamless restart for manual recognition
    private func restartRecognition() {
        guard !isRestarting else { return }
        isRestarting = true
        defer { isRestarting = false }

        restartTask?.cancel()
        restartTask = nil
        recognitionGeneration += 1
        teardownRecognition()
        try? beginRecognition()
    }

    /// Seamless restart for trigger recognition
    private func restartTriggerRecognition() {
        guard !isRestarting else { return }
        isRestarting = true
        defer { isRestarting = false }

        restartTask?.cancel()
        restartTask = nil
        recognitionGeneration += 1
        teardownRecognition()

        // If we were capturing, the command continues in the new window
        // capturedCommand and triggerState are preserved
        guard triggerState == .listening || triggerState == .capturing else { return }
        do {
            try beginRecognition()
        } catch {
            print("[Speech] Trigger restart failed: \(error)")
            scheduleRetry()
        }
    }

    /// Schedule a retry for trigger recognition with exponential backoff.
    /// Called when beginRecognition fails in trigger mode.
    private func scheduleRetry() {
        guard retryCount < Self.maxRetries else {
            print("[Speech] Max retries (\(Self.maxRetries)) reached — trigger disabled")
            triggerState = .idle
            isInTriggerMode = false
            retryCount = 0
            // Notify user that trigger word is dead — ear icon should stop showing teal
            onError?("Trigger word stopped after \(Self.maxRetries) retries")
            return
        }

        let delay = Double(min(1 << retryCount, 16)) // 1, 2, 4, 8, 16 seconds
        retryCount += 1
        print("[Speech] Trigger retry #\(retryCount) in \(delay)s")

        retryTask?.cancel()
        retryTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self else { return }
            guard self.isInTriggerMode, self.triggerState != .idle else { return }

            do {
                self.audioSessionConfigured = false
                try self.configureAudioSession(forBackground: true)
                try self.beginRecognition()
                self.retryCount = 0 // Success — reset counter
                print("[Speech] Trigger retry succeeded")
            } catch {
                print("[Speech] Trigger retry failed: \(error)")
                self.scheduleRetry() // Try again with longer delay
            }
        }
    }

    /// Tears down audio engine and recognition without changing state.
    private func teardownRecognition() {
        if audioEngine.isRunning { audioEngine.stop() }
        audioEngine.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        recognitionRequest = nil
        recognitionTask?.cancel()
        recognitionTask = nil
    }

    // MARK: - Trigger Word Processing

    /// Process a recognition result in trigger mode
    private func handleTriggerResult(_ text: String, isFinal: Bool) {
        switch triggerState {
        case .listening:
            // Look for trigger word in the transcript
            if let commandAfterTrigger = TriggerWordDetector.extractCommandAfterTrigger(text) {
                triggerState = .capturing
                capturedCommand = commandAfterTrigger.trimmingCharacters(in: .whitespacesAndNewlines)
                lastTranscriptLength = capturedCommand.count

                if capturedCommand.isEmpty {
                    // Trigger detected but no command yet — wait for more text
                    resetSilenceTimer()
                } else {
                    // Check for cancel/stop
                    if TriggerWordDetector.isCancelCommand(capturedCommand) {
                        cancelCapture()
                        return
                    }
                    resetSilenceTimer()
                }
            }

        case .capturing:
            // Extract command text after trigger (may span recognition restarts)
            if let commandAfterTrigger = TriggerWordDetector.extractCommandAfterTrigger(text) {
                let trimmed = commandAfterTrigger.trimmingCharacters(in: .whitespacesAndNewlines)

                if TriggerWordDetector.isCancelCommand(trimmed) {
                    cancelCapture()
                    return
                }

                if trimmed.count > lastTranscriptLength {
                    // New text arrived — update and reset silence timer
                    capturedCommand = trimmed
                    lastTranscriptLength = trimmed.count
                    resetSilenceTimer()
                }
            }

        case .idle, .cooldown:
            break
        }
    }

    /// Reset the 3-second silence timer
    private func resetSilenceTimer() {
        silenceTask?.cancel()
        silenceTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(Self.silenceTimeout))
            guard !Task.isCancelled, let self else { return }
            guard self.triggerState == .capturing else { return }
            self.sendCapturedCommand()
        }
    }

    /// Send the captured command and transition to cooldown
    private func sendCapturedCommand() {
        let command = capturedCommand.trimmingCharacters(in: .whitespacesAndNewlines)
        silenceTask?.cancel()
        silenceTask = nil

        guard !command.isEmpty else {
            // Empty command — discard and return to listening
            cancelCapture()
            return
        }

        // Stop recognition during send + cooldown
        restartTask?.cancel()
        restartTask = nil
        recognitionGeneration += 1
        teardownRecognition()
        triggerState = .cooldown
        capturedCommand = ""

        onTriggerCommand?(command)

        // Brief cooldown then resume listening
        cooldownTask?.cancel()
        cooldownTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(Self.cooldownDuration))
            guard !Task.isCancelled, let self, self.triggerState == .cooldown else { return }
            self.triggerState = .idle
            try? self.startTriggerListening()
        }
    }

    /// Cancel capture and return to trigger listening
    private func cancelCapture() {
        silenceTask?.cancel()
        silenceTask = nil
        capturedCommand = ""
        lastTranscriptLength = 0

        // Restart recognition for trigger listening
        triggerState = .listening
        restartTriggerRecognition()
    }

    // MARK: - Synthesis (TTS)

    /// Speak the given text and wait for completion.
    /// Automatically pauses/resumes trigger listening.
    public func speak(_ text: String) async {
        pauseTriggerForTTS()

        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")

        let delegate = SynthesizerDelegate()
        self.synthesizerDelegate = delegate
        synthesizer.delegate = delegate

        isSpeaking = true

        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            delegate.setContinuation(continuation)
            synthesizer.speak(utterance)
        }

        isSpeaking = false
        self.synthesizerDelegate = nil

        resumeTriggerIfPaused()
    }

    /// Stop any active speech synthesis
    public func stopSpeaking() {
        synthesizer.stopSpeaking(at: .immediate)
        synthesizerDelegate?.resumeAndClear()
        isSpeaking = false
        synthesizerDelegate = nil
    }

    /// Speak the given text, then start listening for a response (auto-mode)
    public func speakThenListen(_ text: String) async {
        // Pause trigger — auto-mode response takes priority
        pauseTriggerForTTS()

        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")

        let delegate = SynthesizerDelegate()
        self.synthesizerDelegate = delegate
        synthesizer.delegate = delegate

        isSpeaking = true

        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            delegate.setContinuation(continuation)
            synthesizer.speak(utterance)
        }

        isSpeaking = false
        self.synthesizerDelegate = nil

        // Don't start listening if the task was cancelled during TTS
        // (e.g., session switch, prompt dismissed, new prompt arrived)
        guard !Task.isCancelled else {
            resumeTriggerIfPaused()
            return
        }

        // Start manual listening for prompt response (not trigger)
        try? startListening()
        // Note: trigger resumes when stopListening() is called after voice match
    }
}

// MARK: - AVSpeechSynthesizerDelegate Bridge

/// Bridges AVSpeechSynthesizerDelegate callbacks into a CheckedContinuation.
/// Uses NSLock to protect `continuation` from concurrent access between the
/// delegate callback thread and @MainActor (stopSpeaking).
private final class SynthesizerDelegate: NSObject, AVSpeechSynthesizerDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Never>?

    func setContinuation(_ c: CheckedContinuation<Void, Never>) {
        lock.lock()
        continuation = c
        lock.unlock()
    }

    func resumeAndClear() {
        lock.lock()
        let c = continuation
        continuation = nil
        lock.unlock()
        c?.resume()
    }

    func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didFinish utterance: AVSpeechUtterance
    ) {
        resumeAndClear()
    }

    func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didCancel utterance: AVSpeechUtterance
    ) {
        resumeAndClear()
    }
}

#endif
