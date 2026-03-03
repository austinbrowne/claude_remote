import SwiftUI
@preconcurrency import MarkdownUI

/// Routes a message to the appropriate type-specific view
struct MessageView: View {
    let message: Message

    var body: some View {
        HStack {
            if message.type == .user {
                Spacer(minLength: 60)
            }

            messageContent
                .modifier(SubagentModifier(isSubagent: message.isSubagent))

            if message.type != .user {
                Spacer(minLength: 20)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private var messageContent: some View {
        switch message.type {
        case .assistant:
            AssistantMessageView(content: message.content ?? "")
        case .user:
            UserMessageView(content: message.content ?? "")
        case .tool:
            ToolCardView(message: message)
        case .toolResult:
            ToolCardView(message: message)
        case .statusUpdate:
            StatusIndicatorView(status: message.content ?? "")
        case .tokenUsage:
            TokenUsageView(content: message.content ?? "")
        case .permissionRequest:
            // Shown inline as tool card; active prompt handled by PromptCardView
            ToolCardView(message: message)
        case .askUserQuestion:
            // Shown inline as status; active prompt handled by PromptCardView
            StatusIndicatorView(status: "Question pending...")
        case .subagentStarting:
            SubagentActivityCard(message: message)
        case .exitPlanMode:
            EmptyView() // Prompt trigger only — handled by PromptCardView
        case .permissionResolved:
            EmptyView() // Invisible — exists only for history recovery tracking
        case .teamMessage:
            TeamMessageBubble(message: message)
        case .unknown:
            StatusIndicatorView(status: message.content ?? "Unknown message")
        }
    }
}

/// Renders assistant messages with markdown
private struct AssistantMessageView: View {
    let content: String

    @Environment(\.colorScheme) private var colorScheme

    private static let syntaxHighlighter = SharedSyntaxHighlighter()

    var body: some View {
        Markdown(content)
            .markdownTheme(.claudeRemote)
            .markdownCodeSyntaxHighlighter(Self.syntaxHighlighter)
            .textSelection(.enabled)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.secondary.opacity(0.18))
            .clipShape(RoundedRectangle(cornerRadius: 14))
    }
}

/// Renders user messages as right-aligned bubbles
private struct UserMessageView: View {
    let content: String

    var body: some View {
        Text(content)
            .font(.body)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(Color.accentColor)
            .foregroundStyle(.white)
            .clipShape(RoundedRectangle(cornerRadius: 16))
    }
}

/// Activity indicator with tool name, elapsed time, and pulsing animation
private struct StatusIndicatorView: View {
    let status: String

    @State private var isPulsing = false

    var body: some View {
        HStack(spacing: 8) {
            if isProcessing {
                ProgressView()
                    .controlSize(.small)

                Text(status)
                    .font(.subheadline)
                    .fontWeight(.medium)
                    .foregroundStyle(.primary)
            } else {
                Circle()
                    .fill(statusColor)
                    .frame(width: 8, height: 8)
                    .opacity(isPulsing ? 0.4 : 1.0)
                    .animation(.easeInOut(duration: 1.0).repeatForever(autoreverses: true), value: isPulsing)
                    .onAppear { isPulsing = true }

                Text(status)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(
            isProcessing
                ? Color.accentColor.opacity(0.08)
                : Color.clear
        )
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private var isProcessing: Bool {
        let lower = status.lowercased()
        return lower.contains("processing") || lower.contains("working")
            || lower.contains("thinking") || lower.contains("running")
    }

    private var statusColor: Color {
        if status.lowercased().contains("waiting") { return .orange }
        if status.lowercased().contains("error") { return .red }
        return .secondary
    }
}

/// Shows token usage inline
private struct TokenUsageView: View {
    let content: String

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "chart.bar")
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(content)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }
}

/// Single-line inline activity card for a subagent — updates in-place through its lifecycle.
/// Shows agent name, role, owned task, and current tool when available.
private struct SubagentActivityCard: View {
    let message: Message
    @Environment(AppState.self) private var state

    private var status: String { message.subagentStatus ?? "starting" }

    /// Look up SubagentInfo from state for richer display
    private var agentInfo: SubagentInfo? {
        guard let agentId = message.subagentAgentId else { return nil }
        return state.activeSubagents[agentId]
    }

    /// Display name: memberName > agentType > description
    private var displayName: String? {
        guard let info = agentInfo else { return nil }
        if let name = info.memberName, !name.isEmpty { return name }
        if info.agentType != "general" && !info.agentType.isEmpty { return info.agentType }
        return nil
    }

    /// Friendly role label from agentType
    private var roleLabel: String? {
        guard let info = agentInfo else { return nil }
        switch info.agentType {
        case "team-lead": return "Lead"
        case "team-implementer": return "Implementer"
        case "team-analyst": return "Analyst"
        case "Explore": return "Explorer"
        case "Plan": return "Planner"
        case "general", "general-purpose": return nil
        default:
            if info.agentType.isEmpty { return nil }
            return info.agentType
        }
    }

    /// Find the task owned by this agent (if any)
    private var ownedTask: TaskItem? {
        guard let info = agentInfo, let name = info.memberName, !name.isEmpty else { return nil }
        return state.tasks.first { $0.owner == name && $0.status == "in_progress" }
            ?? state.tasks.first { $0.owner == name }
    }

    var body: some View {
        HStack(spacing: 5) {
            statusIcon
            statusText
        }
        .font(.caption)
        .lineLimit(1)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(backgroundColor)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .animation(.easeInOut(duration: 0.2), value: status)
        .animation(.easeInOut(duration: 0.2), value: message.subagentCurrentTool)
    }

    @ViewBuilder
    private var statusIcon: some View {
        switch status {
        case "completed":
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
        default:
            ProgressView()
                .controlSize(.mini)
        }
    }

    private var statusText: Text {
        let desc = message.content ?? ""
        let taskSubject = ownedTask?.subject

        // Build name + role prefix if available
        let namePrefix: Text? = {
            if let name = displayName {
                if let role = roleLabel {
                    return Text(name).fontWeight(.medium) + Text(" (\(role))").foregroundColor(.secondary)
                }
                return Text(name).fontWeight(.medium)
            }
            return nil
        }()

        switch status {
        case "completed":
            if let prefix = namePrefix {
                return prefix.foregroundColor(.green)
                    + Text(" — Done").foregroundColor(.secondary)
            }
            return Text("Completed: ").fontWeight(.medium).foregroundColor(.green)
                + Text(desc).foregroundColor(.secondary)
        case "running":
            if let prefix = namePrefix {
                if let tool = message.subagentCurrentTool {
                    return prefix.foregroundColor(.orange)
                        + Text(" ").foregroundColor(.secondary)
                        + Text(tool).foregroundColor(.orange)
                }
                if let task = taskSubject {
                    return prefix.foregroundColor(.orange)
                        + Text(": \(task)").foregroundColor(.secondary)
                }
                return prefix.foregroundColor(.orange)
            }
            if let tool = message.subagentCurrentTool {
                return Text(tool).fontWeight(.medium).foregroundColor(.orange)
                    + Text(" — ").foregroundColor(.secondary)
                    + Text(desc).foregroundColor(.secondary)
            }
            return Text("Running: ").fontWeight(.medium).foregroundColor(.orange)
                + Text(desc).foregroundColor(.secondary)
        default:
            if let prefix = namePrefix {
                if let task = taskSubject {
                    return prefix.foregroundColor(.orange)
                        + Text(": \(task)").foregroundColor(.secondary)
                }
                return prefix.foregroundColor(.orange)
                    + Text(" Starting...").foregroundColor(.secondary)
            }
            return Text("Starting: ").fontWeight(.medium).foregroundColor(.orange)
                + Text(desc).foregroundColor(.secondary)
        }
    }

    private var backgroundColor: Color {
        status == "completed" ? Color.green.opacity(0.08) : Color.orange.opacity(0.1)
    }
}

/// Renders inter-teammate messages with sender attribution
private struct TeamMessageBubble: View {
    let message: Message

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // Sender → Recipient header
            HStack(spacing: 4) {
                Image(systemName: "person.circle")
                    .font(.caption2)
                    .foregroundStyle(.blue)
                Text(message.teamSender ?? "Agent")
                    .font(.caption)
                    .fontWeight(.medium)
                    .foregroundStyle(.blue)
                if let recipient = message.teamRecipient {
                    Image(systemName: "arrow.right")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(recipient)
                        .font(.caption)
                        .fontWeight(.medium)
                        .foregroundStyle(.secondary)
                }
            }

            // Message content
            Text(message.content ?? "")
                .font(.caption)
                .foregroundStyle(.primary)
                .lineLimit(4)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Color.blue.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color.blue.opacity(0.2), lineWidth: 0.5)
        )
    }
}

/// Applies orange tint for subagent messages
private struct SubagentModifier: ViewModifier {
    let isSubagent: Bool

    func body(content: Content) -> some View {
        if isSubagent {
            content
                .padding(.leading, 4)
                .overlay(
                    Rectangle()
                        .fill(Color.orange)
                        .frame(width: 3),
                    alignment: .leading
                )
        } else {
            content
        }
    }
}

// MARK: - MarkdownUI Theme

extension MarkdownUI.Theme {
    @MainActor static let claudeRemote = Theme()
        .text {
            ForegroundColor(.primary)
            FontSize(15)
        }
        .code {
            FontFamilyVariant(.monospaced)
            FontSize(.em(0.85))
            ForegroundColor(.secondary)
            BackgroundColor(Color.secondaryBackground)
        }
        .link {
            ForegroundColor(.accentColor)
        }
        .heading1 { configuration in
            configuration.label
                .markdownMargin(top: 16, bottom: 8)
                .markdownTextStyle {
                    FontWeight(.bold)
                    FontSize(22)
                }
        }
        .heading2 { configuration in
            configuration.label
                .markdownMargin(top: 12, bottom: 6)
                .markdownTextStyle {
                    FontWeight(.semibold)
                    FontSize(18)
                }
        }
        .heading3 { configuration in
            configuration.label
                .markdownMargin(top: 8, bottom: 4)
                .markdownTextStyle {
                    FontWeight(.semibold)
                    FontSize(16)
                }
        }
        .codeBlock { configuration in
            CodeBlockView(
                code: configuration.content,
                language: configuration.language
            )
            .markdownMargin(top: 8, bottom: 8)
        }
        .paragraph { configuration in
            configuration.label
                .markdownMargin(top: 0, bottom: 8)
        }
        .listItem { configuration in
            configuration.label
                .markdownMargin(top: 2)
        }
}

// MARK: - Shared Syntax Highlighter for MarkdownUI

struct SharedSyntaxHighlighter: CodeSyntaxHighlighter {
    func highlightCode(_ code: String, language: String?) -> Text {
        guard let attributed = SyntaxHighlighting.highlight(code, language: language) else {
            return Text(code)
        }
        return Text(AttributedString(attributed))
    }
}
