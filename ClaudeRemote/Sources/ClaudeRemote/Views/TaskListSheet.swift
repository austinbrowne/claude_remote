import SwiftUI

/// Full-screen task list sheet with progress tracking, expandable descriptions,
/// and status icons for each task.
struct TaskListSheet: View {
    @Environment(AppState.self) private var state
    @Environment(\.dismiss) private var dismiss

    @State private var expandedTaskIds: Set<String> = []

    var body: some View {
        NavigationStack {
            Group {
                if state.tasks.isEmpty {
                    emptyState
                } else {
                    taskList
                }
            }
            .navigationTitle("Tasks")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    // MARK: - Progress Header

    private var progressHeader: some View {
        VStack(spacing: 8) {
            HStack {
                Text("\(completedCount)/\(state.tasks.count) completed")
                    .font(.subheadline)
                    .fontWeight(.medium)
                Spacer()
                Text(progressPercentText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            ProgressView(value: progressFraction)
                .tint(progressColor)
        }
        .padding(.horizontal)
        .padding(.vertical, 12)
    }

    // MARK: - Task List

    private var taskList: some View {
        List {
            Section {
                progressHeader
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
            }

            Section {
                ForEach(state.tasks, id: \.stableId) { task in
                    TaskListRow(
                        task: task,
                        isExpanded: expandedTaskIds.contains(task.stableId),
                        onToggle: {
                            withAnimation(.easeInOut(duration: 0.2)) {
                                if expandedTaskIds.contains(task.stableId) {
                                    expandedTaskIds.remove(task.stableId)
                                } else {
                                    expandedTaskIds.insert(task.stableId)
                                }
                            }
                        }
                    )
                }
            }
        }
        #if os(iOS)
        .listStyle(.insetGrouped)
        #endif
    }

    // MARK: - Empty State

    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "checklist")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)
            Text("No tasks yet")
                .font(.title3)
                .foregroundStyle(.secondary)
            Text("Tasks will appear here when Claude creates them.")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
        }
        .padding()
    }

    // MARK: - Computed Properties

    private var completedCount: Int {
        state.tasks.filter { $0.status == "completed" }.count
    }

    private var progressFraction: Double {
        guard !state.tasks.isEmpty else { return 0 }
        return Double(completedCount) / Double(state.tasks.count)
    }

    private var progressPercentText: String {
        let pct = Int(progressFraction * 100)
        return "\(pct)%"
    }

    private var progressColor: Color {
        if progressFraction >= 1.0 { return .green }
        if progressFraction >= 0.5 { return .blue }
        return .orange
    }
}

// MARK: - Task List Row

private struct TaskListRow: View {
    let task: TaskItem
    let isExpanded: Bool
    let onToggle: () -> Void

    var body: some View {
        Button(action: onToggle) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 10) {
                    statusIcon
                        .frame(width: 20, height: 20)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(task.subject ?? "Task")
                            .font(.body)
                            .fontWeight(.medium)
                            .foregroundStyle(task.status == "completed" ? .secondary : .primary)
                            .strikethrough(task.status == "completed")
                            .lineLimit(isExpanded ? nil : 2)

                        if task.status == "in_progress", let activeForm = task.activeForm {
                            HStack(spacing: 4) {
                                ProgressView()
                                    .scaleEffect(0.6)
                                    .frame(width: 12, height: 12)
                                Text(activeForm)
                                    .font(.caption)
                                    .foregroundStyle(.orange)
                            }
                        }
                    }

                    Spacer()

                    if task.description != nil {
                        Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                }

                if isExpanded, let description = task.description, !description.isEmpty {
                    Text(description)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .padding(.leading, 30)
                        .padding(.top, 4)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
            .padding(.vertical, 4)
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var statusIcon: some View {
        switch task.status {
        case "completed":
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
        case "in_progress":
            Image(systemName: "circle.dotted")
                .foregroundStyle(.orange)
                .symbolEffect(.pulse, isActive: true)
        default: // pending
            Image(systemName: "circle")
                .foregroundStyle(.secondary)
        }
    }
}
