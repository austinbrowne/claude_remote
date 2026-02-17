import SwiftUI

/// Collapsible timeline view showing session milestones in reverse chronological order.
/// Purple accent to distinguish from blue tasks and green completions.
struct MilestoneTimelineView: View {
    @Environment(AppState.self) private var state

    @State private var isExpanded = false
    @State private var expandedMilestoneId: UUID?

    var body: some View {
        if !state.milestones.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                headerButton

                if isExpanded {
                    VStack(spacing: 0) {
                        ForEach(state.milestones.reversed()) { milestone in
                            MilestoneRow(
                                milestone: milestone,
                                isTextExpanded: expandedMilestoneId == milestone.id,
                                onToggle: {
                                    withAnimation(.easeInOut(duration: 0.2)) {
                                        expandedMilestoneId = expandedMilestoneId == milestone.id ? nil : milestone.id
                                    }
                                }
                            )
                        }
                    }
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
    }

    private var headerButton: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.2)) {
                isExpanded.toggle()
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                    .font(.caption2)
                    .foregroundStyle(.purple)

                Image(systemName: "flag.checkered")
                    .font(.caption)
                    .foregroundStyle(.purple)

                Text("Session Timeline")
                    .font(.caption)
                    .fontWeight(.medium)
                    .foregroundStyle(.secondary)

                Spacer()

                Text("\(state.milestones.count)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .padding(.bottom, 6)
        }
        .buttonStyle(.plain)
    }
}

/// Single milestone row with relative timestamp, tool count badge, and expandable text.
private struct MilestoneRow: View {
    let milestone: Milestone
    let isTextExpanded: Bool
    let onToggle: () -> Void

    var body: some View {
        Button(action: onToggle) {
            HStack(alignment: .top, spacing: 8) {
                // Timeline dot
                Circle()
                    .fill(.purple.opacity(0.6))
                    .frame(width: 6, height: 6)
                    .padding(.top, 5)

                VStack(alignment: .leading, spacing: 2) {
                    Text(milestone.text)
                        .font(.caption)
                        .foregroundStyle(.primary)
                        .lineLimit(isTextExpanded ? nil : 2)
                        .multilineTextAlignment(.leading)

                    HStack(spacing: 8) {
                        Text(relativeTime(milestone.timestamp))
                            .font(.caption2)
                            .foregroundStyle(.secondary)

                        if milestone.toolCount > 0 {
                            HStack(spacing: 2) {
                                Image(systemName: "wrench")
                                    .font(.system(size: 8))
                                Text("\(milestone.toolCount)")
                                    .font(.caption2)
                            }
                            .foregroundStyle(.purple.opacity(0.8))
                        }
                    }
                }

                Spacer()
            }
            .padding(.vertical, 4)
            .padding(.leading, 4)
        }
        .buttonStyle(.plain)
    }

    private func relativeTime(_ date: Date) -> String {
        let interval = Date().timeIntervalSince(date)
        if interval < 60 {
            return "just now"
        } else if interval < 3600 {
            let mins = Int(interval / 60)
            return "\(mins)m ago"
        } else if interval < 86400 {
            let hours = Int(interval / 3600)
            return "\(hours)h ago"
        } else {
            let days = Int(interval / 86400)
            return "\(days)d ago"
        }
    }
}
