import Testing
import Foundation
@testable import ClaudeRemote

@Suite("DocumentService")
struct DocumentServiceTests {

    @Test("Build files URL with session and path")
    func buildFilesURL() throws {
        let url = try DocumentService.buildURL(
            serverURL: "https://example.com",
            endpoint: "/api/files",
            queryItems: [
                URLQueryItem(name: "sessionId", value: "abc-123"),
                URLQueryItem(name: "path", value: "."),
            ]
        )
        #expect(url.scheme == "https")
        #expect(url.host == "example.com")
        #expect(url.path == "/api/files" || url.path() == "/api/files")

        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        let queryItems = components.queryItems ?? []
        #expect(queryItems.contains(URLQueryItem(name: "sessionId", value: "abc-123")))
        #expect(queryItems.contains(URLQueryItem(name: "path", value: ".")))
    }

    @Test("Build file content URL with nested path")
    func buildFileContentURL() throws {
        let url = try DocumentService.buildURL(
            serverURL: "https://example.com:8080",
            endpoint: "/api/file",
            queryItems: [
                URLQueryItem(name: "sessionId", value: "xyz"),
                URLQueryItem(name: "path", value: "src/main.swift"),
            ]
        )
        #expect(url.host == "example.com")
        #expect(url.port == 8080)

        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        let queryItems = components.queryItems ?? []
        #expect(queryItems.contains(URLQueryItem(name: "path", value: "src/main.swift")))
    }

    @Test("Build URL strips trailing slash from server URL")
    func buildURLStripsTrailingSlash() throws {
        let url = try DocumentService.buildURL(
            serverURL: "https://example.com/",
            endpoint: "/api/files",
            queryItems: []
        )
        #expect(url.absoluteString.hasPrefix("https://example.com/api/files"))
    }

    @Test("Build URL with empty server URL produces path-only URL")
    func buildURLEmptyServer() throws {
        // Empty server URL still produces a parseable URL (path-only)
        // The actual network call would fail, but URL construction succeeds
        let url = try DocumentService.buildURL(
            serverURL: "",
            endpoint: "/api/files",
            queryItems: []
        )
        #expect(url.path.contains("api/files"))
    }

    @Test("Build URL with special characters in path")
    func buildURLSpecialChars() throws {
        let url = try DocumentService.buildURL(
            serverURL: "https://example.com",
            endpoint: "/api/file",
            queryItems: [
                URLQueryItem(name: "path", value: "docs/my file.md"),
            ]
        )
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        let pathItem = components.queryItems?.first { $0.name == "path" }
        #expect(pathItem?.value == "docs/my file.md")
    }

    @Test("DocumentError descriptions are non-empty")
    func errorDescriptions() {
        let errors: [DocumentService.DocumentError] = [
            .invalidURL,
            .unauthorized,
            .serverError(500, "Internal error"),
            .serverError(404, nil),
            .decodingFailed,
        ]
        for error in errors {
            #expect(error.errorDescription != nil)
            #expect(!error.errorDescription!.isEmpty)
        }
    }
}
