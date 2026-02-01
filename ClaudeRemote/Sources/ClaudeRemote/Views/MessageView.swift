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

/// Subtle inline status indicator
private struct StatusIndicatorView: View {
    let status: String

    var body: some View {
        HStack(spacing: 6) {
            if isProcessing {
                ProgressView()
                    .scaleEffect(0.6)
                    .frame(width: 12, height: 12)
            } else {
                Circle()
                    .fill(statusColor)
                    .frame(width: 6, height: 6)
            }
            Text(status)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }

    private var isProcessing: Bool {
        status.lowercased().contains("processing") || status.lowercased().contains("working")
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
private struct SubagentActivityCard: View {
    let message: Message

    private var status: String { message.subagentStatus ?? "starting" }

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
        switch status {
        case "completed":
            return Text("Completed: ").fontWeight(.medium).foregroundColor(.green)
                + Text(desc).foregroundColor(.secondary)
        case "running":
            if let tool = message.subagentCurrentTool {
                return Text(tool).fontWeight(.medium).foregroundColor(.orange)
                    + Text(" — ").foregroundColor(.secondary)
                    + Text(desc).foregroundColor(.secondary)
            }
            return Text("Running: ").fontWeight(.medium).foregroundColor(.orange)
                + Text(desc).foregroundColor(.secondary)
        default:
            return Text("Starting: ").fontWeight(.medium).foregroundColor(.orange)
                + Text(desc).foregroundColor(.secondary)
        }
    }

    private var backgroundColor: Color {
        status == "completed" ? Color.green.opacity(0.08) : Color.orange.opacity(0.1)
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
