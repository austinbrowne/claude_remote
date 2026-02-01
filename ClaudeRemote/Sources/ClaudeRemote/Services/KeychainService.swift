import Foundation
import Security

/// Protocol for Keychain operations (enables testing with mock)
public protocol KeychainServiceProtocol: Sendable {
    func save(token: String, for server: String) throws
    func load(for server: String) -> String?
    func delete(for server: String) throws
}

/// Keychain errors
public enum KeychainError: Error, Sendable {
    case saveFailed(OSStatus)
    case deleteFailed(OSStatus)
}

/// Real Keychain implementation using Security framework
public struct KeychainService: KeychainServiceProtocol {
    private static let servicePrefix = "com.clauderemote."

    public init() {}

    public func save(token: String, for server: String) throws {
        // Delete existing first
        try? delete(for: server)

        guard let data = token.data(using: .utf8) else { return }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.servicePrefix + server,
            kSecAttrAccount as String: server,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]

        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw KeychainError.saveFailed(status)
        }
    }

    public func load(for server: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.servicePrefix + server,
            kSecAttrAccount as String: server,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess, let data = result as? Data else {
            return nil
        }

        return String(data: data, encoding: .utf8)
    }

    public func delete(for server: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.servicePrefix + server,
            kSecAttrAccount as String: server
        ]

        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.deleteFailed(status)
        }
    }
}
