import Foundation

/// A milestone representing a significant point in a Claude session's progress.
/// Server sends these as session_milestone (single) or session_milestones (batch).
public struct Milestone: Identifiable, Sendable {
    public let id: UUID
    public let text: String
    public let timestamp: Date
    public let toolCount: Int

    public init(text: String, timestamp: Date, toolCount: Int) {
        self.id = UUID()
        self.text = text
        self.timestamp = timestamp
        self.toolCount = toolCount
    }
}

/// Wire format for milestone data from the server
public struct MilestoneData: Decodable, Sendable {
    public let text: String
    public let timestamp: String
    public let toolCount: Int

    public init(text: String, timestamp: String, toolCount: Int) {
        self.text = text
        self.timestamp = timestamp
        self.toolCount = toolCount
    }

    /// Convert to Milestone model, parsing the ISO 8601 timestamp
    public func toMilestone() -> Milestone {
        let date = ISO8601DateFormatter().date(from: timestamp) ?? Date()
        return Milestone(text: text, timestamp: date, toolCount: toolCount)
    }
}
