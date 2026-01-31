#if os(iOS)
import Speech
import AVFoundation
import Observation

/// Voice I/O service providing speech-to-text via SFSpeechRecognizer
/// and text-to-speech via AVSpeechSynthesizer.
///
/// Supports two modes:
/// - **Manual**: Tap mic button, transcript fills text field
/// - **Auto**: TTS reads prompts aloud, listens for voice response, matches and submits
@Observable
@MainActor
public final class SpeechService {

    // MARK: - Public State

    public private(set) var isListening = false
    public private(set) var transcript = ""
    public private(set) var isSpeaking = false

    /// When true, TTS reads prompts and listens for voice responses
    public var isAutoMode = false

    /// Called on each transcript update (partial or final). Used by AppCoordinator
    /// to dispatch auto-mode voice matching while recognition is active.
    public var onTranscriptUpdate: ((String) -> Void)?

    // MARK: - Private State

    private let speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let audioEngine = AVAudioEngine()
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private let synthesizer = AVSpeechSynthesizer()
    private var synthesizerDelegate: SynthesizerDelegate?
    private var restartTask: Task<Void, Never>?

    /// Incremented on each new recognition session so stale callbacks are ignored
    private var recognitionGeneration = 0

    /// Stored observer token for audio interruption notifications
    private var interruptionObserver: (any NSObjectProtocol)?

    // MARK: - Init

    public init() {}

    deinit {
        if let observer = interruptionObserver {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    // MARK: - Audio Session

    /// Configure the shared audio session for play-and-record
    public func configureAudioSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, options: [.defaultToSpeaker, .allowBluetooth])
        try session.setActive(true)

        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: session,
            queue: nil
        ) { [weak self] notification in
            Task { @MainActor [weak self] in
                self?.handleAudioInterruption(notification)
            }
        }
    }

    private func handleAudioInterruption(_ notification: Notification) {
        guard let info = notification.userInfo,
              let typeValue = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else { return }

        switch type {
        case .began:
            if isListening { stopListening() }
            if isSpeaking { stopSpeaking() }
        case .ended:
            let options = info[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            if AVAudioSession.InterruptionOptions(rawValue: options).contains(.shouldResume) {
                try? AVAudioSession.sharedInstance().setActive(true)
            }
        @unknown default:
            break
        }
    }

    // MARK: - Recognition (STT)

    /// Start listening for speech input
    public func startListening() throws {
        // Request authorization (retries on grant via callback)
        let authStatus = SFSpeechRecognizer.authorizationStatus()
        if authStatus == .notDetermined {
            SFSpeechRecognizer.requestAuthorization { [weak self] status in
                if status == .authorized {
                    Task { @MainActor [weak self] in
                        try? self?.startListening()
                    }
                }
            }
            return
        }
        guard authStatus == .authorized else { return }

        // Clean up any existing recognition
        teardownRecognition()

        // New generation invalidates any stale callbacks
        recognitionGeneration += 1

        beginRecognition()
    }

    /// Stop listening for speech input
    public func stopListening() {
        restartTask?.cancel()
        restartTask = nil
        recognitionGeneration += 1
        teardownRecognition()
        isListening = false
    }

    /// Toggle listening on/off
    public func toggleListening() throws {
        if isListening {
            stopListening()
        } else {
            try startListening()
        }
    }

    /// Start a new recognition session. Called by startListening and restartRecognition.
    private func beginRecognition() {
        let gen = recognitionGeneration

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        recognitionRequest = request

        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { [weak request] buffer, _ in
            request?.append(buffer)
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            teardownRecognition()
            isListening = false
            return
        }

        transcript = ""
        isListening = true

        recognitionTask = speechRecognizer?.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor [weak self] in
                guard let self, gen == self.recognitionGeneration else { return }
                if let result {
                    self.transcript = result.bestTranscription.formattedString
                    if !self.transcript.isEmpty {
                        self.onTranscriptUpdate?(self.transcript)
                    }
                }
                if error != nil || (result?.isFinal == true) {
                    self.stopListening()
                }
            }
        }

        // Schedule 55-second seamless restart (Apple's 60s limit minus 5s buffer)
        restartTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(55))
            guard !Task.isCancelled, let self, self.isListening else { return }
            self.restartRecognition()
        }
    }

    /// Seamless restart: tears down recognition and immediately begins a new session
    /// without setting isListening to false (avoids UI flicker).
    private func restartRecognition() {
        restartTask?.cancel()
        restartTask = nil
        recognitionGeneration += 1
        teardownRecognition()
        // isListening stays true — seamless from the user's perspective
        beginRecognition()
    }

    /// Tears down audio engine and recognition without changing isListening state.
    private func teardownRecognition() {
        if audioEngine.isRunning { audioEngine.stop() }
        audioEngine.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        recognitionRequest = nil
        recognitionTask?.cancel()
        recognitionTask = nil
    }

    // MARK: - Synthesis (TTS)

    /// Speak the given text and wait for completion
    public func speak(_ text: String) async {
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
    }

    /// Stop any active speech synthesis
    public func stopSpeaking() {
        synthesizer.stopSpeaking(at: .immediate)
        // Resume any pending continuation so speak() doesn't hang.
        // The lock in SynthesizerDelegate ensures no double-resume with didCancel.
        synthesizerDelegate?.resumeAndClear()
        isSpeaking = false
        synthesizerDelegate = nil
    }

    /// Speak the given text, then start listening for a response (auto-mode)
    public func speakThenListen(_ text: String) async {
        await speak(text)
        try? startListening()
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
