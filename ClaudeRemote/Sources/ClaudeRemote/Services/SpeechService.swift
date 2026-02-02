#if os(iOS)
import Speech
import AVFoundation
import Observation

/// Errors from speech recognition setup
public enum SpeechError: Error {
    case invalidAudioFormat
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
        if let observer = interruptionObserver {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    // MARK: - Audio Session

    /// Whether the audio session has been configured at least once
    private var audioSessionConfigured = false

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
        // Only call setActive if not already active — setActive(true) can block
        // the main thread for seconds if the audio daemon is in a bad state.
        if !session.isOtherAudioPlaying || !audioSessionConfigured {
            try session.setActive(true)
        }
        audioSessionConfigured = true

        // Only register interruption observer once
        guard interruptionObserver == nil else { return }
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
                try? AVAudioSession.sharedInstance().setActive(true)
                if triggerPaused {
                    triggerPaused = false
                    try? startTriggerListening()
                }
            }
        @unknown default:
            break
        }
    }

    // MARK: - Manual Recognition (STT)

    /// Start listening for speech input (manual mic mode)
    public func startListening() throws {
        // Pause trigger if active (manual mic takes priority)
        if triggerState == .listening || triggerState == .capturing || triggerState == .cooldown {
            stopTriggerListening()
            triggerPaused = true
        }

        let authStatus = SFSpeechRecognizer.authorizationStatus()
        if authStatus == .notDetermined {
            SFSpeechRecognizer.requestAuthorization { status in
                if status == .authorized {
                    DispatchQueue.main.async { [weak self] in
                        try? self?.startListening()
                    }
                }
            }
            return
        }
        guard authStatus == .authorized else { return }

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

    /// Start trigger word listening (background-capable, always-on)
    public func startTriggerListening() throws {
        guard triggerState == .idle || triggerState == .cooldown else { return }

        // Don't start if manual listening or TTS is active
        if isListening || isSpeaking { return }

        let authStatus = SFSpeechRecognizer.authorizationStatus()
        if authStatus == .notDetermined {
            SFSpeechRecognizer.requestAuthorization { status in
                if status == .authorized {
                    DispatchQueue.main.async { [weak self] in
                        try? self?.startTriggerListening()
                    }
                }
            }
            return
        }
        guard authStatus == .authorized else { return }

        teardownRecognition()
        recognitionGeneration += 1
        isInTriggerMode = true
        capturedCommand = ""
        lastTranscriptLength = 0
        triggerState = .listening
        try beginRecognition()
    }

    /// Stop trigger word listening
    public func stopTriggerListening() {
        cooldownTask?.cancel()
        cooldownTask = nil
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
            request.requiresOnDeviceRecognition = true
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
                triggerState = .idle
                isInTriggerMode = false
            } else {
                isListening = false
            }
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
                triggerState = .idle
                isInTriggerMode = false
            } else {
                isListening = false
            }
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
        restartTask?.cancel()
        restartTask = nil
        recognitionGeneration += 1
        teardownRecognition()
        try? beginRecognition()
    }

    /// Seamless restart for trigger recognition
    private func restartTriggerRecognition() {
        restartTask?.cancel()
        restartTask = nil
        recognitionGeneration += 1
        teardownRecognition()

        // If we were capturing, the command continues in the new window
        // capturedCommand and triggerState are preserved
        guard triggerState == .listening || triggerState == .capturing else { return }
        try? beginRecognition()
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
