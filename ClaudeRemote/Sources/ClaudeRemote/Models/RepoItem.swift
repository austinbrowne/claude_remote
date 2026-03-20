import Foundation

/// A git repository returned by the /repos endpoint
public struct RepoItem: Codable, Identifiable, Sendable {
    public var id: String { name }
    public let name: String
}

/// Response from GET /repos
public struct RepoListResponse: Codable, Sendable {
    public let error: String?
    public let repos: [RepoItem]
}
