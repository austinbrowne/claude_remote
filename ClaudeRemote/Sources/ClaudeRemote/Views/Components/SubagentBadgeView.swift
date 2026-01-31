import SwiftUI

/// Toolbar badge showing count of active subagents with detail sheet
struct SubagentBadgeView: View {
    @Environment(AppState.self) private var state

    @State private var showSheet = false

    private var runningCount: Int {
        state.activeSubagents.values.filter { $0.status == "running" }.count
    }

    var body: some View {
        if !state.activeSubagents.isEmpty {
            Button {
                showSheet = true
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "person.2")
                        .font(.caption)
                        .foregroundStyle(.orange)
                    Text("\(runningCount)")
                        .font(.caption)
                        .fontWeight(.medium)
                        .foregroundStyle(.orange)
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

    private var sorted: [(id: String, info: SubagentInfo)] {
        state.activeSubagents
            .sorted { $0.value.startTime < $1.value.startTime }
            .map { (id: $0.key, info: $0.value) }
    }

    var body: some View {
        NavigationStack {
            List(sorted, id: \.id) { entry in
                SubagentRow(id: entry.id, info: entry.info, tick: tick)
            }
            .navigationTitle("Subagents")
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

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Header: type + status
            HStack {
                Image(systemName: agentIcon)
                    .font(.caption)
                    .foregroundStyle(.orange)
                Text(info.agentType)
                    .font(.subheadline)
                    .fontWeight(.medium)
                Spacer()
                statusBadge
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
        switch info.agentType {
        case "Explore": "magnifyingglass"
        case "Bash": "terminal"
        case "Plan": "map"
        default: "person.2"
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
