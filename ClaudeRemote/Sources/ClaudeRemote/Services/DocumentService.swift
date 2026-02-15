import Foundation

/// REST client for browsing files in the session's working directory
public struct DocumentService: Sendable {
    /// Errors specific to document fetching
    public enum DocumentError: Error, LocalizedError, Sendable {
        case invalidURL
        case unauthorized
        case serverError(Int, String?)
        case decodingFailed

        public var errorDescription: String? {
            switch self {
            case .invalidURL: "Invalid server URL"
            case .unauthorized: "Authentication failed"
            case .serverError(let code, let message): message ?? "Server error (\(code))"
            case .decodingFailed: "Failed to decode response"
            }
        }
    }

    public init() {}

    // MARK: - Public API

    /// Fetch directory listing from the server
    public func fetchFiles(
        serverURL: String,
        token: String,
        sessionId: String,
        path: String = "."
    ) async throws -> [FileEntry] {
        let url = try buildURL(serverURL: serverURL, endpoint: "/api/files", queryItems: [
            URLQueryItem(name: "sessionId", value: sessionId),
            URLQueryItem(name: "path", value: path),
        ])

        let data = try await performRequest(url: url, token: token)

        struct FilesResponse: Decodable {
            let entries: [FileEntry]
        }

        do {
            let response = try JSONDecoder().decode(FilesResponse.self, from: data)
            return response.entries
        } catch {
            throw DocumentError.decodingFailed
        }
    }

    /// Fetch file content from the server
    public func fetchFileContent(
        serverURL: String,
        token: String,
        sessionId: String,
        path: String
    ) async throws -> FileContent {
        let url = try buildURL(serverURL: serverURL, endpoint: "/api/file", queryItems: [
            URLQueryItem(name: "sessionId", value: sessionId),
            URLQueryItem(name: "path", value: path),
        ])

        let data = try await performRequest(url: url, token: token)

        do {
            return try JSONDecoder().decode(FileContent.self, from: data)
        } catch {
            throw DocumentError.decodingFailed
        }
    }

    // MARK: - URL Construction (internal for testing)

    /// Build a URL from server base URL, endpoint path, and query items
    static func buildURL(serverURL: String, endpoint: String, queryItems: [URLQueryItem]) throws -> URL {
        // Strip trailing slash from server URL
        let base = serverURL.hasSuffix("/") ? String(serverURL.dropLast()) : serverURL
        guard var components = URLComponents(string: base + endpoint) else {
            throw DocumentError.invalidURL
        }
        components.queryItems = queryItems
        guard let url = components.url else {
            throw DocumentError.invalidURL
        }
        return url
    }

    // MARK: - Private

    private func buildURL(serverURL: String, endpoint: String, queryItems: [URLQueryItem]) throws -> URL {
        try Self.buildURL(serverURL: serverURL, endpoint: endpoint, queryItems: queryItems)
    }

    private func performRequest(url: URL, token: String) async throws -> Data {
        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw DocumentError.serverError(0, "Invalid response")
        }

        switch httpResponse.statusCode {
        case 200:
            return data
        case 401, 403:
            throw DocumentError.unauthorized
        default:
            let message = String(data: data, encoding: .utf8)
            throw DocumentError.serverError(httpResponse.statusCode, message)
        }
    }
}
