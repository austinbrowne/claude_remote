import SwiftUI

/// Groups consecutive tool-related messages into a single collapsible block.
/// Collapsed: "Used 5 tools: Read (2), Edit (2), Bash (1)" with status indicators
/// Expanded: Shows individual ToolCardViews
struct ToolGroupView: View {
    let messages: [Message]

    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isExpanded.toggle()
                }
            } label: {
                header
            }
            .buttonStyle(.plain)

            if isExpanded {
                expandedContent
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .background(Color.secondaryBackground.opacity(0.3))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(Color.secondary.opacity(0.15), lineWidth: 1)
        )
        .padding(.horizontal, 12)
        .padding(.vertical, 2)
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .frame(width: 12)

                Image(systemName: "wrench.and.screwdriver")
                    .font(.caption)
                    .foregroundStyle(.purple)

                Text("Used \(toolCount) tool\(toolCount == 1 ? "" : "s")")
                    .font(.caption)
                    .fontWeight(.medium)
                    .foregroundStyle(.primary)

                Spacer()

                statusIndicators
            }

            // Tool name summary line
            Text(toolSummaryText)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
    }

    // MARK: - Expanded Content

    private var expandedContent: some View {
        VStack(spacing: 4) {
            ForEach(toolMessages) { message in
                ToolCardView(message: message)
                    .padding(.horizontal, 6)
            }
        }
        .padding(.bottom, 8)
    }

    // MARK: - Computed Properties

    /// Tool and permissionRequest messages — what the user sees as "tools"
    private var toolMessages: [Message] {
        messages.filter { $0.type == .tool || $0.type == .permissionRequest }
    }

    /// Count of actual tool calls
    private var toolCount: Int {
        toolMessages.count
    }

    /// Status indicators: checkmarks/x-marks for each tool
    private var statusIndicators: some View {
        HStack(spacing: 2) {
            ForEach(toolMessages) { msg in
                if msg.resultContent != nil {
                    Image(systemName: msg.resultIsError ? "xmark.circle.fill" : "checkmark.circle.fill")
                        .font(.system(size: 8))
                        .foregroundStyle(msg.resultIsError ? .red : .green)
                } else {
                    ProgressView()
                        .controlSize(.mini)
                }
            }
        }
    }

    /// Summary text like "Read (2) · Edit (2) · Bash (1)"
    private var toolSummaryText: String {
        ToolGroupHelpers.toolSummaryText(from: messages)
    }
}

// MARK: - Extracted Helpers (Testable)

enum ToolGroupHelpers {
    /// Build a summary string like "Read (2) · Edit (2) · Bash (1)"
    static func toolSummaryText(from messages: [Message]) -> String {
        var counts: [(name: String, count: Int)] = []
        var seen: [String: Int] = [:]

        for msg in messages where msg.type == .tool || msg.type == .permissionRequest {
            let name = msg.tool ?? "Tool"
            if let idx = seen[name] {
                counts[idx].count += 1
            } else {
                seen[name] = counts.count
                counts.append((name: name, count: 1))
            }
        }

        return counts.map { entry in
            entry.count > 1 ? "\(entry.name) (\(entry.count))" : entry.name
        }.joined(separator: " · ")
    }

    /// Determine whether a message is a "tool-group" message type
    static func isToolGroupMessage(_ message: Message) -> Bool {
        switch message.type {
        case .tool, .toolResult, .permissionRequest:
            return true
        case .statusUpdate:
            // Status updates within tool runs (e.g., "Processing...") group with tools
            return true
        default:
            return false
        }
    }

    /// Group consecutive tool messages from a flat message array.
    /// Returns an array of `ChatItem` representing either a single message or a tool group.
    static func groupMessages(_ messages: [Message]) -> [ChatItem] {
        var result: [ChatItem] = []
        var currentGroup: [Message] = []

        func flushGroup() {
            if currentGroup.isEmpty { return }
            let hasActualTools = currentGroup.contains { $0.type == .tool || $0.type == .permissionRequest }
            if !hasActualTools {
                // No real tools in this group (only statusUpdates/toolResults) — render individually
                for msg in currentGroup {
                    result.append(.single(msg))
                }
            } else {
                result.append(.toolGroup(currentGroup))
            }
            currentGroup = []
        }

        for message in messages {
            // Noise messages are skipped entirely — they don't break tool groups
            // and aren't shown in the chat stream:
            // - tokenUsage: tiny caption text, clutter (C5)
            // - exitPlanMode: prompt trigger only, not visible content
            // - unknown: unhandled types that would show as "Unknown message"
            if message.type == .tokenUsage || message.type == .exitPlanMode || message.type == .unknown {
                continue
            }
            if isToolGroupMessage(message) {
                currentGroup.append(message)
            } else {
                flushGroup()
                result.append(.single(message))
            }
        }
        flushGroup()

        return result
    }
}

/// Represents either a single message or a group of tool messages in the chat
enum ChatItem: Identifiable {
    case single(Message)
    case toolGroup([Message])

    var id: String {
        switch self {
        case .single(let msg):
            return msg.id.uuidString
        case .toolGroup(let msgs):
            return "group-" + (msgs.first?.id.uuidString ?? "empty")
        }
    }
}
