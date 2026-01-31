import SwiftUI

/// Collapsible card showing a tool call with icon, name, summary, and expandable details
struct ToolCardView: View {
    let message: Message

    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Collapsed header - always visible
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isExpanded.toggle()
                }
            } label: {
                header
            }
            .buttonStyle(.plain)

            // Expanded details
            if isExpanded {
                details
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .background(Color.secondaryBackground.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(borderColor.opacity(0.3), lineWidth: 1)
        )
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .frame(width: 12)

            Image(systemName: toolIcon)
                .font(.caption)
                .foregroundStyle(borderColor)

            Text(message.tool ?? "Tool")
                .font(.caption)
                .fontWeight(.medium)
                .foregroundStyle(.primary)

            if let summary = toolSummary {
                Text(summary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }

            Spacer()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
    }

    @ViewBuilder
    private var details: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Show diff for Edit tool
            if message.tool == "Edit", let input = message.toolInput,
               let oldStr = input["old_string"]?.stringValue,
               let newStr = input["new_string"]?.stringValue {
                DiffView(oldString: oldStr, newString: newStr)
            }

            // Show code block for tool input
            if let input = message.toolInput {
                let formatted = formatToolInput(input)
                if !formatted.isEmpty {
                    CodeBlockView(code: formatted, language: inputLanguage)
                }
            }

            // Show result content if this is a tool_result
            if message.type == .toolResult, let content = message.content, !content.isEmpty {
                CodeBlockView(code: content, language: message.language)
            }
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 10)
    }

    // MARK: - Helpers

    private var toolIcon: String {
        switch message.tool {
        case "Read": "doc.text"
        case "Write": "pencil"
        case "Edit", "MultiEdit": "text.badge.plus"
        case "Bash": "terminal"
        case "Glob": "folder.badge.questionmark"
        case "Grep": "magnifyingglass"
        case "WebFetch": "globe"
        case "WebSearch": "magnifyingglass.circle"
        case "Task": "person.2"
        default: "wrench"
        }
    }

    private var borderColor: Color {
        message.type == .toolResult ? .secondary : .purple
    }

    private var toolSummary: String? {
        guard let input = message.toolInput else { return message.content?.firstLine }

        switch message.tool {
        case "Read", "Write", "Edit", "MultiEdit":
            return input["file_path"]?.stringValue
        case "Bash":
            return input["command"]?.stringValue?.firstLine.truncated(to: 60)
        case "Glob":
            return input["pattern"]?.stringValue
        case "Grep":
            return input["pattern"]?.stringValue
        case "WebFetch":
            return input["url"]?.stringValue
        case "Task":
            return input["description"]?.stringValue?.truncated(to: 60)
        default:
            return nil
        }
    }

    private var inputLanguage: String? {
        switch message.tool {
        case "Bash": "bash"
        case "Grep": nil
        default: "json"
        }
    }

    private func formatToolInput(_ input: [String: AnyCodableValue]) -> String {
        // For Bash, just show the command
        if message.tool == "Bash", let cmd = input["command"]?.stringValue {
            return cmd
        }
        // For Edit, skip if we're showing diff
        if message.tool == "Edit" && input["old_string"] != nil {
            if let filePath = input["file_path"]?.stringValue {
                return filePath
            }
            return ""
        }
        // For Read/Write/Glob, show the key parameter
        if let path = input["file_path"]?.stringValue {
            return path
        }
        // Default: JSON encode the input
        guard let data = try? JSONSerialization.data(
            withJSONObject: input.mapValues { $0.toAny() },
            options: [.prettyPrinted, .sortedKeys]
        ), let str = String(data: data, encoding: .utf8) else {
            return ""
        }
        return str
    }
}
