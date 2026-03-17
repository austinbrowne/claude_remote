import Foundation

/// URL canonicalization and validation for consistent Keychain keying
public enum URLHelper {

    /// Canonicalize a URL string: lowercase host, strip trailing slash, enforce https for remote.
    /// Returns nil if the URL is fundamentally invalid.
    public static func canonicalize(_ urlString: String) -> String? {
        guard var components = URLComponents(string: urlString) else { return nil }

        // Lowercase scheme
        components.scheme = components.scheme?.lowercased()

        // Must have a valid scheme
        guard let scheme = components.scheme, scheme == "http" || scheme == "https" else {
            return nil
        }

        // Must have a host
        guard let host = components.host, !host.isEmpty else { return nil }

        // Lowercase host
        components.host = host.lowercased()

        // Enforce https for non-localhost
        if !isLocalhost(host) && scheme == "http" {
            return nil // Reject http for remote hosts
        }

        // Strip trailing slash from path
        if components.path == "/" {
            components.path = ""
        }
        while components.path.hasSuffix("/") {
            components.path = String(components.path.dropLast())
        }

        return components.url?.absoluteString
    }

    /// Validate that a URL string is acceptable for a server connection.
    /// Returns a user-facing error message, or nil if valid.
    public static func validate(_ urlString: String) -> String? {
        guard let components = URLComponents(string: urlString) else {
            return "Invalid URL format"
        }

        guard let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
            return "URL must use http or https"
        }

        guard let host = components.host, !host.isEmpty else {
            return "URL must include a host"
        }

        if !isLocalhost(host) && scheme == "http" {
            return "Remote servers must use https"
        }

        return nil
    }

    /// Check if a host is localhost
    public static func isLocalhost(_ host: String) -> Bool {
        let lower = host.lowercased()
        return lower == "localhost" || lower == "127.0.0.1"
    }

    /// Extract a display name from a URL (hostname without TLD)
    /// e.g., "https://claude.dazztrazak.com" → "claude"
    /// e.g., "https://mini.claude.dazztrazak.com" → "mini"
    public static func displayName(from urlString: String) -> String {
        guard let url = URL(string: urlString),
              let host = url.host?.lowercased() else {
            return "Server"
        }
        if isLocalhost(host) { return "Local" }
        let parts = host.split(separator: ".")
        return parts.first.map(String.init) ?? "Server"
    }
}
