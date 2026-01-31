import SwiftUI

/// Inline task list showing progress of active tasks
struct TaskProgressView: View {
    @Environment(AppState.self) private var state

    @State private var expandedTaskId: String?

    var body: some View {
        if !state.tasks.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                header

                ForEach(state.tasks, id: \.stableId) { task in
                    TaskRow(
                        task: task,
                        isExpanded: expandedTaskId == task.stableId,
                        onToggle: {
                            withAnimation(.easeInOut(duration: 0.2)) {
                                expandedTaskId = expandedTaskId == task.stableId ? nil : task.stableId
                            }
                        }
                    )
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
    }

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: "checklist")
                .font(.caption)
                .foregroundStyle(.blue)
            Text("Tasks")
                .font(.caption)
                .fontWeight(.medium)
                .foregroundStyle(.secondary)

            Spacer()

            Text(progressText)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(.bottom, 6)
    }

    private var progressText: String {
        let completed = state.tasks.filter { $0.status == "completed" }.count
        return "\(completed)/\(state.tasks.count)"
    }
}

/// Single task row with status icon, subject, and collapsible description
private struct TaskRow: View {
    let task: TaskItem
    let isExpanded: Bool
    let onToggle: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: onToggle) {
                HStack(spacing: 8) {
                    statusIcon
                        .frame(width: 16, height: 16)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(task.subject ?? "Task")
                            .font(.caption)
                            .fontWeight(.medium)
                            .foregroundStyle(task.status == "completed" ? .secondary : .primary)
                            .strikethrough(task.status == "completed")
                            .lineLimit(2)

                        if task.status == "in_progress", let activeForm = task.activeForm {
                            Text(activeForm)
                                .font(.caption2)
                                .foregroundStyle(.orange)
                        }
                    }

                    Spacer()

                    if task.description != nil {
                        Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 5)
            }
            .buttonStyle(.plain)

            if isExpanded, let description = task.description, !description.isEmpty {
                Text(description)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.leading, 24)
                    .padding(.bottom, 6)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    @ViewBuilder
    private var statusIcon: some View {
        switch task.status {
        case "completed":
            Image(systemName: "checkmark.circle.fill")
                .font(.caption)
                .foregroundStyle(.green)
        case "in_progress":
            ProgressView()
                .scaleEffect(0.6)
                .frame(width: 16, height: 16)
        default: // pending
            Circle()
                .strokeBorder(.secondary, lineWidth: 1.5)
                .frame(width: 12, height: 12)
        }
    }
}

// MARK: - TaskItem Stable ID

extension TaskItem {
    /// Stable identifier for ForEach — uses server id if available, falls back to subject
    var stableId: String {
        id ?? subject ?? "task-unknown"
    }
}
