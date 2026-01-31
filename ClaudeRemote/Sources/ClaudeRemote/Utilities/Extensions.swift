import Foundation
import SwiftUI

extension String {
    /// Truncate to a max length, appending ellipsis if truncated
    public func truncated(to maxLength: Int) -> String {
        if count <= maxLength { return self }
        return String(prefix(maxLength)) + "..."
    }

    /// Extract first line of a multi-line string
    public var firstLine: String {
        components(separatedBy: .newlines).first ?? self
    }

}

extension Date {
    /// Relative time string (e.g., "2m ago", "1h ago")
    public var relativeString: String {
        let interval = Date().timeIntervalSince(self)
        if interval < 60 { return "just now" }
        if interval < 3600 { return "\(Int(interval / 60))m ago" }
        if interval < 86400 { return "\(Int(interval / 3600))h ago" }
        return "\(Int(interval / 86400))d ago"
    }
}

extension SessionStatus {
    public var color: Color {
        switch self {
        case .waiting: .orange
        case .processing, .active: .green
        case .idle, .unknown: .gray
        }
    }
}

// MARK: - Cross-Platform Colors

extension Color {
    /// Secondary system background (cross-platform)
    static var secondaryBackground: Color {
        #if os(iOS)
        Color(uiColor: .secondarySystemBackground)
        #else
        Color(nsColor: .controlBackgroundColor)
        #endif
    }

    /// Tertiary system background (cross-platform)
    static var tertiaryBackground: Color {
        #if os(iOS)
        Color(uiColor: .tertiarySystemBackground)
        #else
        Color(nsColor: .windowBackgroundColor)
        #endif
    }
}

nonisolated(unsafe) private let iso8601WithFractional: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

nonisolated(unsafe) private let iso8601Standard: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
}()

/// Parse an ISO8601 date string from the server
public func parseServerDate(_ string: String?) -> Date? {
    guard let string else { return nil }
    return iso8601WithFractional.date(from: string)
        ?? iso8601Standard.date(from: string)
}
