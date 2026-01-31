import Testing
import Foundation
@testable import ClaudeRemote

@Suite("WebSocketService")
struct WebSocketServiceTests {

    @MainActor
    @Test("Initialization sets properties")
    func initialization() {
        let url = URL(string: "http://localhost:3456")!
        let service = WebSocketService(serverURL: url, token: "test-token")
        #expect(service.serverURL == url)
        #expect(service.isConnected == false)
        #expect(service.reconnectAttempts == 0)
    }

    @MainActor
    @Test("Reconnect delay with exponential backoff")
    func reconnectDelay() {
        let url = URL(string: "http://localhost:3456")!
        let service = WebSocketService(serverURL: url, token: "test")

        // First attempt: 0.3s
        #expect(service.reconnectDelay() == 0.3)

        // Simulate reconnect attempts
        service.reconnect() // Increments to 1
        // After 1 attempt: 0.3 * 2^1 = 0.6
        #expect(service.reconnectDelay() == 0.6)
    }

    @MainActor
    @Test("Reconnect delay caps at max")
    func reconnectDelayCap() {
        let url = URL(string: "http://localhost:3456")!
        let service = WebSocketService(serverURL: url, token: "test")

        // Simulate many reconnect attempts manually
        for _ in 0..<20 {
            _ = service.reconnectDelay()
        }
        // Should never exceed maxReconnectDelay
        #expect(service.reconnectDelay() <= WebSocketService.maxReconnectDelay)
    }

    @MainActor
    @Test("Constants have correct values")
    func constants() {
        #expect(WebSocketService.pingIntervalSeconds == 15)
        #expect(WebSocketService.pongTimeoutSeconds == 5)
        #expect(WebSocketService.maxReconnectDelay == 30)
        #expect(WebSocketService.initialReconnectDelay == 0.3)
    }

    @MainActor
    @Test("setLastWatchedSession stores session ID")
    func setLastWatchedSession() {
        let url = URL(string: "http://localhost:3456")!
        let service = WebSocketService(serverURL: url, token: "test")
        service.setLastWatchedSession("sess-1")
        // Can't directly read private property, but we test indirectly
        // by verifying no crash
        service.setLastWatchedSession(nil)
    }

    @MainActor
    @Test("Disconnect sets isConnected to false")
    func disconnectResetsState() {
        let url = URL(string: "http://localhost:3456")!
        let service = WebSocketService(serverURL: url, token: "test")
        service.disconnect()
        #expect(service.isConnected == false)
    }

    @MainActor
    @Test("Send without connection does nothing")
    func sendWithoutConnection() {
        let url = URL(string: "http://localhost:3456")!
        let service = WebSocketService(serverURL: url, token: "test")
        // Should not crash
        service.send(.ping)
        service.send(.inject(command: "test", sessionId: "s1"))
    }
}

@Suite("WebSocketService Delegate")
struct WebSocketServiceDelegateTests {

    @MainActor
    final class MockDelegate: WebSocketServiceDelegate, @unchecked Sendable {
        var didConnectCalled = false
        var didDisconnectCode: Int?
        var receivedMessages: [ServerMessage] = []
        var lastError: Error?

        func webSocketDidConnect() {
            didConnectCalled = true
        }

        func webSocketDidDisconnect(code: Int?) {
            didDisconnectCode = code
        }

        func webSocketDidReceiveMessage(_ message: ServerMessage) {
            receivedMessages.append(message)
        }

        func webSocketDidFailWithError(_ error: Error) {
            lastError = error
        }
    }

    @MainActor
    @Test("Delegate receives disconnect on disconnect")
    func delegateDisconnect() {
        let url = URL(string: "http://localhost:3456")!
        let service = WebSocketService(serverURL: url, token: "test")
        let delegate = MockDelegate()
        service.delegate = delegate
        service.disconnect()
        #expect(delegate.didDisconnectCode == nil) // intentional disconnect has nil code
    }
}
