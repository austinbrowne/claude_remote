import SwiftUI

/// Collapsible card showing a tool call with icon, name, summary, and expandable details.
/// When a tool_result is merged into its tool_use, both input and output render in one card.
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

            // Show checkmark or error indicator when result is merged
            if message.resultContent != nil {
                Image(systemName: message.resultIsError ? "xmark.circle.fill" : "checkmark.circle.fill")
                    .font(.caption2)
                    .foregroundStyle(message.resultIsError ? .red : .green)
            }
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

            // Standalone tool_result (not merged into a tool_use)
            if message.type == .toolResult, let content = message.content, !content.isEmpty {
                CodeBlockView(code: content, language: message.language)
            }

            // Merged tool result (tool_use with result attached)
            if let result = message.resultContent, !result.isEmpty {
                Divider()
                    .padding(.vertical, 2)
                CodeBlockView(code: result, language: message.language)
                    .overlay(
                        message.resultIsError
                            ? RoundedRectangle(cornerRadius: 6)
                                .strokeBorder(Color.red.opacity(0.3), lineWidth: 1)
                            : nil
                    )
            }
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 10)
    }

    // MARK: - Helpers (delegate to ToolCardHelpers for testability)

    private var toolIcon: String {
        ToolCardHelpers.toolIcon(for: message.tool)
    }

    private var borderColor: Color {
        ToolCardHelpers.borderColor(resultIsError: message.resultIsError, type: message.type)
    }

    private var toolSummary: String? {
        ToolCardHelpers.toolSummary(tool: message.tool, input: message.toolInput, fallbackContent: message.content)
    }

    private var inputLanguage: String? {
        ToolCardHelpers.inputLanguage(for: message.tool)
    }

    private func formatToolInput(_ input: [String: AnyCodableValue]) -> String {
        ToolCardHelpers.formatToolInput(input, tool: message.tool)
    }
}

// MARK: - Extracted Logic (Testable)

/// Pure logic extracted from ToolCardView for testability.
enum ToolCardHelpers {

    static func toolIcon(for tool: String?) -> String {
        switch tool {
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

    static func borderColor(resultIsError: Bool, type: MessageType) -> Color {
        if resultIsError { return .red }
        if type == .toolResult { return .secondary }
        return .purple
    }

    static func toolSummary(tool: String?, input: [String: AnyCodableValue]?, fallbackContent: String?) -> String? {
        guard let input else { return fallbackContent?.firstLine }

        switch tool {
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

    static func inputLanguage(for tool: String?) -> String? {
        switch tool {
        case "Bash": "bash"
        case "Grep": nil
        default: "json"
        }
    }

    static func formatToolInput(_ input: [String: AnyCodableValue], tool: String?) -> String {
        // For Bash, just show the command
        if tool == "Bash", let cmd = input["command"]?.stringValue {
            return cmd
        }
        // For Edit, skip if we're showing diff
        if tool == "Edit" && input["old_string"] != nil {
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
