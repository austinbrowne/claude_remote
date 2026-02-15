import Foundation

/// A file or directory entry from the server's file browsing API
public struct FileEntry: Identifiable, Codable, Hashable, Sendable {
    public let name: String
    public let relativePath: String
    public let isDirectory: Bool
    public let size: Int?

    public var id: String { relativePath }

    public init(name: String, relativePath: String, isDirectory: Bool, size: Int? = nil) {
        self.name = name
        self.relativePath = relativePath
        self.isDirectory = isDirectory
        self.size = size
    }

    /// Format a byte count as a human-readable size string
    public static func formatSize(_ bytes: Int) -> String {
        guard bytes >= 0 else { return "0 B" }
        if bytes < 1024 {
            return "\(bytes) B"
        } else if bytes < 1024 * 1024 {
            let kb = Double(bytes) / 1024.0
            return String(format: "%.1f KB", kb)
        } else {
            let mb = Double(bytes) / (1024.0 * 1024.0)
            return String(format: "%.1f MB", mb)
        }
    }
}

/// Content of a single file fetched from the server
public struct FileContent: Codable, Sendable {
    public let path: String
    public let content: String?
    public let language: String?
    public let size: Int
    public let error: String?

    public init(path: String, content: String? = nil, language: String? = nil, size: Int = 0, error: String? = nil) {
        self.path = path
        self.content = content
        self.language = language
        self.size = size
        self.error = error
    }
}
