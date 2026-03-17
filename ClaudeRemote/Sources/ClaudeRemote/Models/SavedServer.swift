import Foundation

/// A saved server endpoint for quick switching between machines
public struct SavedServer: Codable, Identifiable, Equatable, Hashable {
    public let id: UUID
    public var name: String
    public var url: String

    public init(id: UUID = UUID(), name: String, url: String) {
        self.id = id
        self.name = String(name.prefix(50))
        self.url = URLHelper.canonicalize(url) ?? url
    }
}
