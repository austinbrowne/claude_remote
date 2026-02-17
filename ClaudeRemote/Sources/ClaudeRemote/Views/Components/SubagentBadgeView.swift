import SwiftUI

/// Toolbar badge showing count of active subagents with detail sheet
struct SubagentBadgeView: View {
    @Environment(AppState.self) private var state

    @State private var showSheet = false

    private var runningCount: Int {
        state.activeSubagents.values.filter { $0.status == "running" }.count
    }

    private var isTeamActive: Bool {
        state.activeTeamName != nil
    }

    var body: some View {
        if !state.activeSubagents.isEmpty {
            Button {
                showSheet = true
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: isTeamActive ? "person.3" : "person.2")
                        .font(.caption)
                        .foregroundStyle(isTeamActive ? .blue : .orange)
                    if let teamName = state.activeTeamName {
                        Text(teamName)
                            .font(.caption)
                            .fontWeight(.medium)
                            .foregroundStyle(.blue)
                            .lineLimit(1)
                    } else {
                        Text("\(runningCount)")
                            .font(.caption)
                            .fontWeight(.medium)
                            .foregroundStyle(.orange)
                    }
                }
            }
            .sheet(isPresented: $showSheet) {
                SubagentListSheet()
            }
        }
    }
}

/// Detail sheet listing all subagents (reads live from AppState)
private struct SubagentListSheet: View {
    @Environment(AppState.self) private var state
    @Environment(\.dismiss) private var dismiss

    /// Tick counter to force relative-time labels to refresh
    @State private var tick = 0

    private var teammates: [(id: String, info: SubagentInfo)] {
        state.activeSubagents
            .filter { $0.value.teamName != nil }
            .sorted { $0.value.startTime < $1.value.startTime }
            .map { (id: $0.key, info: $0.value) }
    }

    private var regularSubagents: [(id: String, info: SubagentInfo)] {
        state.activeSubagents
            .filter { $0.value.teamName == nil }
            .sorted { $0.value.startTime < $1.value.startTime }
            .map { (id: $0.key, info: $0.value) }
    }

    var body: some View {
        NavigationStack {
            List {
                if !teammates.isEmpty {
                    Section {
                        ForEach(teammates, id: \.id) { entry in
                            SubagentRow(id: entry.id, info: entry.info, tick: tick, tasks: state.tasks)
                        }
                    } header: {
                        if let teamName = state.activeTeamName {
                            Label(teamName, systemImage: "person.3")
                        } else {
                            Text("Teammates")
                        }
                    }
                }

                if !regularSubagents.isEmpty {
                    Section(teammates.isEmpty ? "Subagents" : "Other Subagents") {
                        ForEach(regularSubagents, id: \.id) { entry in
                            SubagentRow(id: entry.id, info: entry.info, tick: tick, tasks: state.tasks)
                        }
                    }
                }

                if !state.teamMessages.isEmpty {
                    Section("Team Messages") {
                        ForEach(Array(state.teamMessages.suffix(10).enumerated()), id: \.offset) { _, msg in
                            TeamMessageRow(message: msg)
                        }
                    }
                }
            }
            .navigationTitle(state.activeTeamName ?? "Subagents")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task {
            // Refresh relative timestamps every 30 seconds while sheet is open
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                tick += 1
            }
        }
    }
}

/// Single row showing one subagent's details
private struct SubagentRow: View {
    let id: String
    let info: SubagentInfo
    let tick: Int  // Forces relative-time refresh
    let tasks: [TaskItem]

    /// Display name: prefer memberName, fall back to truncated agentId
    private var displayName: String {
        if let name = info.memberName, !name.isEmpty {
            return name
        }
        return String(id.prefix(12))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Header: name/type + status
            HStack {
                Image(systemName: agentIcon)
                    .font(.caption)
                    .foregroundStyle(info.teamName != nil ? .blue : .orange)
                if info.teamName != nil {
                    Text(displayName)
                        .font(.subheadline)
                        .fontWeight(.medium)
                } else {
                    Text(info.agentType)
                        .font(.subheadline)
                        .fontWeight(.medium)
                }
                Spacer()
                statusBadge
            }

            // Agent type shown as subtitle for teammates (since header shows member name)
            if info.teamName != nil {
                Text(info.agentType)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            // Description
            if !info.description.isEmpty {
                Text(info.description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }

            // Current tool
            if let tool = info.currentTool {
                HStack(spacing: 4) {
                    Image(systemName: "wrench")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(tool)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }

            // Footer: tokens + duration + last activity
            HStack(spacing: 12) {
                if info.inputTokens > 0 || info.outputTokens > 0 {
                    HStack(spacing: 4) {
                        Image(systemName: "chart.bar")
                            .font(.caption2)
                        Text(formatTokenCount(info.inputTokens, info.outputTokens))
                            .font(.caption2)
                    }
                    .foregroundStyle(.secondary)
                }

                HStack(spacing: 4) {
                    Image(systemName: "clock")
                        .font(.caption2)
                    // tick dependency ensures relativeString refreshes
                    let _ = tick
                    Text(info.startTime.relativeString)
                        .font(.caption2)
                }
                .foregroundStyle(.secondary)

                if info.lastActivity > info.startTime {
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.clockwise")
                            .font(.caption2)
                        let _ = tick
                        Text(info.lastActivity.relativeString)
                            .font(.caption2)
                    }
                    .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
    }

    private var agentIcon: String {
        if info.teamName != nil {
            return "person.circle"
        }
        switch info.agentType {
        case "Explore": return "magnifyingglass"
        case "Bash": return "terminal"
        case "Plan": return "map"
        default: return "person.2"
        }
    }

    @ViewBuilder
    private var statusBadge: some View {
        if info.status == "running" {
            HStack(spacing: 4) {
                ProgressView()
                    .scaleEffect(0.6)
                    .frame(width: 10, height: 10)
                Text("Running")
                    .font(.caption2)
                    .foregroundStyle(.orange)
            }
        } else {
            HStack(spacing: 4) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.caption2)
                    .foregroundStyle(.green)
                Text("Done")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// Row showing a single inter-teammate message
private struct TeamMessageRow: View {
    let message: TeamMessage

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Text(message.sender)
                    .font(.caption)
                    .fontWeight(.medium)
                    .foregroundStyle(.blue)
                if let recipient = message.recipient {
                    Image(systemName: "arrow.right")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(recipient)
                        .font(.caption)
                        .fontWeight(.medium)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text(message.timestamp.relativeString)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            Text(message.content)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(3)
        }
    }
}
