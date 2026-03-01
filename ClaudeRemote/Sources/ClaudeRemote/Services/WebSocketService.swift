import Foundation
#if canImport(Network)
import Network
#endif

extension URLSessionWebSocketTask: @retroactive @unchecked Sendable {}

/// Delegate for WebSocket events
@MainActor
public protocol WebSocketServiceDelegate: AnyObject {
    func webSocketDidConnect()
    func webSocketDidDisconnect(code: Int?)
    func webSocketDidReceiveMessage(_ message: ServerMessage)
    func webSocketDidFailWithError(_ error: Error)
}

/// Manages WebSocket connection to the Claude Remote server
@MainActor
public final class WebSocketService {
    // MARK: - Configuration
    public let serverURL: URL
    private let token: String

    // MARK: - State
    public private(set) var isConnected = false
    public private(set) var reconnectAttempts = 0
    public weak var delegate: WebSocketServiceDelegate?

    // MARK: - Constants
    public static let pingIntervalSeconds: TimeInterval = 15
    public static let pongTimeoutSeconds: TimeInterval = 5
    public static let maxReconnectDelay: TimeInterval = 30
    public static let initialReconnectDelay: TimeInterval = 0.3

    // MARK: - Private
    private let decoder = JSONDecoder()
    private var webSocketTask: URLSessionWebSocketTask?
    private var urlSession: URLSession
    private var pingTask: Task<Void, Never>?
    private var receiveTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var pongDeadline: Date?
    private var lastWatchedSessionId: String?
    private var intentionalDisconnect = false

    #if canImport(Network)
    private let pathMonitor = NWPathMonitor()
    private var isNetworkAvailable = true
    #endif

    /// Factory for creating the WebSocket task (injected for testing)
    private let taskFactory: (@Sendable (URL, URLSession) -> URLSessionWebSocketTask)?

    public init(
        serverURL: URL,
        token: String,
        urlSession: URLSession = .shared,
        taskFactory: (@Sendable (URL, URLSession) -> URLSessionWebSocketTask)? = nil
    ) {
        self.serverURL = serverURL
        self.token = token
        self.urlSession = urlSession
        self.taskFactory = taskFactory
        #if canImport(Network)
        startNetworkMonitoring()
        #endif
    }

    deinit {
        #if canImport(Network)
        pathMonitor.cancel()
        #endif
    }

    // MARK: - Public API

    /// Connect to the WebSocket server
    public func connect() {
        // Tear down any existing connection to prevent duplicate server connections.
        // This handles the case where multiple reconnect attempts race, or connect()
        // is called while an old WebSocket is still alive.
        cleanup()
        intentionalDisconnect = false

        guard let wsURL = buildWebSocketURL() else {
            delegate?.webSocketDidFailWithError(
                URLError(.badURL, userInfo: [NSLocalizedDescriptionKey: "Failed to build WebSocket URL from \(serverURL)"])
            )
            return
        }

        if let factory = taskFactory {
            webSocketTask = factory(wsURL, urlSession)
        } else {
            webSocketTask = urlSession.webSocketTask(with: wsURL)
        }

        webSocketTask?.resume()
        startReceiveLoop()
        sendAuth()
    }

    /// Disconnect from the server
    public func disconnect() {
        intentionalDisconnect = true
        cleanup()
        delegate?.webSocketDidDisconnect(code: nil)
    }

    /// Send an action to the server
    public func send(_ action: ClientAction) {
        guard isConnected else { return }
        do {
            let data = try action.toData()
            let string = String(data: data, encoding: .utf8) ?? "{}"
            Task { [weak self] in
                do {
                    try await self?.webSocketTask?.send(.string(string))
                } catch {
                    await self?.handleDisconnect(error: error)
                }
            }
        } catch {
            delegate?.webSocketDidFailWithError(error)
        }
    }

    /// Track the last watched session for reconnection
    public func setLastWatchedSession(_ sessionId: String?) {
        lastWatchedSessionId = sessionId
    }

    /// Calculate reconnect delay with exponential backoff
    public func reconnectDelay() -> TimeInterval {
        let delay = Self.initialReconnectDelay * pow(2, Double(reconnectAttempts))
        return min(delay, Self.maxReconnectDelay)
    }

    /// Attempt to reconnect
    public func reconnect() {
        guard !intentionalDisconnect else { return }
        #if canImport(Network)
        guard isNetworkAvailable else { return }
        #endif

        reconnectAttempts += 1
        let delay = reconnectDelay()

        // Cancel any pending reconnect to prevent duplicate connections
        // (handleDisconnect can be called multiple times from different error paths)
        reconnectTask?.cancel()
        reconnectTask = Task {
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, !intentionalDisconnect else { return }
            connect()
        }
    }

    // MARK: - Private

    private func buildWebSocketURL() -> URL? {
        guard var components = URLComponents(url: serverURL, resolvingAgainstBaseURL: false) else {
            return nil
        }
        switch components.scheme {
        case "https", "wss": components.scheme = "wss"
        default: components.scheme = "ws"
        }
        if components.path.isEmpty || components.path == "/" {
            components.path = "/ws"
        }
        return components.url
    }

    /// Build a WebSocket URL from an HTTP server URL.
    /// Converts http(s) to ws(s) and appends /ws path if needed.
    public static func webSocketURL(from httpURL: URL) -> URL? {
        guard var components = URLComponents(url: httpURL, resolvingAgainstBaseURL: false) else {
            return nil
        }
        switch components.scheme {
        case "https", "wss": components.scheme = "wss"
        default: components.scheme = "ws"
        }
        if components.path.isEmpty || components.path == "/" {
            components.path = "/ws"
        }
        return components.url
    }

    private func sendAuth() {
        let authAction = ClientAction.auth(token: token)
        do {
            let data = try authAction.toData()
            let string = String(data: data, encoding: .utf8) ?? "{}"
            Task { [weak self] in
                do {
                    try await self?.webSocketTask?.send(.string(string))
                } catch {
                    await self?.handleDisconnect(error: error)
                }
            }
        } catch {
            delegate?.webSocketDidFailWithError(error)
        }
    }

    private func startReceiveLoop() {
        receiveTask?.cancel()
        receiveTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, let task = self.webSocketTask else { break }
                do {
                    let wsMessage = try await task.receive()
                    await self.handleReceivedMessage(wsMessage)
                } catch {
                    if !Task.isCancelled {
                        await self.handleDisconnect(error: error)
                    }
                    break
                }
            }
        }
    }

    private func handleReceivedMessage(_ wsMessage: URLSessionWebSocketTask.Message) {
        let jsonString: String
        switch wsMessage {
        case .string(let text):
            jsonString = text
        case .data(let data):
            guard let text = String(data: data, encoding: .utf8) else { return }
            jsonString = text
        @unknown default:
            return
        }

        guard let data = jsonString.data(using: .utf8) else { return }

        do {
            let message = try decoder.decode(ServerMessage.self, from: data)
            handleServerMessage(message)
        } catch {
            // Log decode error with the raw JSON for debugging.
            // Truncate to 500 chars to avoid flooding logs with large messages.
            let preview = jsonString.prefix(500)
            print("[WebSocket] Decode error: \(error.localizedDescription) — raw: \(preview)")
            delegate?.webSocketDidFailWithError(error)
        }
    }

    private func handleServerMessage(_ message: ServerMessage) {
        switch message {
        case .authResult(let success, _):
            if success {
                isConnected = true
                reconnectAttempts = 0
                startPingTimer()
                delegate?.webSocketDidConnect()
                // Re-watch last session on reconnect
                if let sessionId = lastWatchedSessionId {
                    send(.watchSession(sessionId: sessionId))
                }
            } else {
                cleanup()
                delegate?.webSocketDidDisconnect(code: 4001)
            }

        case .pong:
            pongDeadline = nil

        default:
            break
        }

        delegate?.webSocketDidReceiveMessage(message)
    }

    private func startPingTimer() {
        pingTask?.cancel()
        pingTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(WebSocketService.pingIntervalSeconds))
                guard !Task.isCancelled, let self else { break }

                self.pongDeadline = Date().addingTimeInterval(WebSocketService.pongTimeoutSeconds)
                self.send(.ping)

                // Wait for pong timeout
                try? await Task.sleep(for: .seconds(WebSocketService.pongTimeoutSeconds))
                guard !Task.isCancelled else { break }

                if let deadline = self.pongDeadline, Date() >= deadline {
                    self.handleDisconnect(error: nil)
                    break
                }
            }
        }
    }

    private func handleDisconnect(error: Error?) {
        let wasConnected = isConnected
        cleanup()

        if let error {
            delegate?.webSocketDidFailWithError(error)
        }

        if wasConnected {
            delegate?.webSocketDidDisconnect(code: nil)
        }

        if !intentionalDisconnect {
            reconnect()
        }
    }

    private func cleanup() {
        pingTask?.cancel()
        pingTask = nil
        receiveTask?.cancel()
        receiveTask = nil
        reconnectTask?.cancel()
        reconnectTask = nil
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketTask = nil
        isConnected = false
        pongDeadline = nil
    }

    #if canImport(Network)
    private nonisolated func startNetworkMonitoring() {
        pathMonitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor [weak self] in
                self?.isNetworkAvailable = path.status == .satisfied
            }
        }
        pathMonitor.start(queue: DispatchQueue(label: "com.clauderemote.network"))
    }
    #endif
}
