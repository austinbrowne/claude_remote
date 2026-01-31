import Testing
import Foundation
@testable import ClaudeRemote

/// Mock Keychain for testing without real Keychain access
final class MockKeychainService: KeychainServiceProtocol, @unchecked Sendable {
    private var storage: [String: String] = [:]

    func save(token: String, for server: String) throws {
        storage[server] = token
    }

    func load(for server: String) -> String? {
        storage[server]
    }

    func delete(for server: String) throws {
        storage.removeValue(forKey: server)
    }

    var storedCount: Int { storage.count }
}

@Suite("KeychainService Protocol")
struct KeychainServiceTests {

    @Test("Save and load token")
    func saveAndLoad() throws {
        let keychain = MockKeychainService()
        try keychain.save(token: "my-secret-token", for: "localhost:3456")
        let loaded = keychain.load(for: "localhost:3456")
        #expect(loaded == "my-secret-token")
    }

    @Test("Load returns nil for missing key")
    func loadMissing() {
        let keychain = MockKeychainService()
        #expect(keychain.load(for: "nonexistent") == nil)
    }

    @Test("Delete removes token")
    func deleteToken() throws {
        let keychain = MockKeychainService()
        try keychain.save(token: "token", for: "server")
        try keychain.delete(for: "server")
        #expect(keychain.load(for: "server") == nil)
    }

    @Test("Save overwrites existing token")
    func saveOverwrites() throws {
        let keychain = MockKeychainService()
        try keychain.save(token: "old", for: "server")
        try keychain.save(token: "new", for: "server")
        #expect(keychain.load(for: "server") == "new")
    }

    @Test("Multiple servers stored independently")
    func multipleServers() throws {
        let keychain = MockKeychainService()
        try keychain.save(token: "token-a", for: "server-a")
        try keychain.save(token: "token-b", for: "server-b")
        #expect(keychain.load(for: "server-a") == "token-a")
        #expect(keychain.load(for: "server-b") == "token-b")
        #expect(keychain.storedCount == 2)
    }

    @Test("Delete non-existent key does not throw")
    func deleteNonExistent() throws {
        let keychain = MockKeychainService()
        try keychain.delete(for: "nonexistent")
        // Should not throw
    }
}

@Suite("Real KeychainService")
struct RealKeychainServiceTests {
    private let keychain = KeychainService()
    private let testServer = "com.clauderemote.test.\(UUID().uuidString)"

    @Test("Save, load, and delete from real Keychain")
    func realKeychainRoundTrip() throws {
        let token = "test-token-\(UUID().uuidString)"
        try keychain.save(token: token, for: testServer)

        let loaded = keychain.load(for: testServer)
        #expect(loaded == token)

        try keychain.delete(for: testServer)
        #expect(keychain.load(for: testServer) == nil)
    }

    @Test("Load returns nil for non-existent entry")
    func realKeychainLoadMissing() {
        let result = keychain.load(for: "nonexistent-\(UUID().uuidString)")
        #expect(result == nil)
    }

    @Test("Delete non-existent entry does not throw")
    func realKeychainDeleteMissing() throws {
        try keychain.delete(for: "nonexistent-\(UUID().uuidString)")
    }

    @Test("Save overwrites in real Keychain")
    func realKeychainOverwrite() throws {
        let token1 = "token1-\(UUID().uuidString)"
        let token2 = "token2-\(UUID().uuidString)"
        try keychain.save(token: token1, for: testServer)
        try keychain.save(token: token2, for: testServer)
        #expect(keychain.load(for: testServer) == token2)
        // Cleanup
        try keychain.delete(for: testServer)
    }
}
