import SwiftUI

/// Renders the prompt queue as a stacked card list.
/// Queue head is actionable; non-head items show as pending with disabled buttons.
struct PromptCardView: View {
    @Environment(AppCoordinator.self) private var coordinator

    /// Maximum number of fully-rendered cards before showing "+N more"
    private static let maxVisible = 3

    private var queue: [PromptItem] { coordinator.promptService.promptQueue }

    var body: some View {
        if !queue.isEmpty {
            VStack(spacing: 0) {
                Divider()
                VStack(spacing: 8) {
                    ForEach(Array(queue.prefix(Self.maxVisible).enumerated()), id: \.element.id) { index, prompt in
                        cardContent(for: prompt, isHead: index == 0)
                    }
                    if queue.count > Self.maxVisible {
                        overflowIndicator(remaining: queue.count - Self.maxVisible)
                    }
                }
                .padding(12)
                .background(.regularMaterial)
            }
        }
    }

    @ViewBuilder
    private func cardContent(for prompt: PromptItem, isHead: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if let desc = prompt.agentDescription {
                Text(desc)
                    .font(.caption2)
                    .foregroundStyle(.orange)
                    .padding(.bottom, 4)
            }

            switch prompt.kind {
            case .permission(let tool, let command, let isDestructive):
                PermissionCardContent(
                    tool: tool,
                    command: command,
                    isDestructive: isDestructive,
                    isStale: prompt.isStale,
                    isHead: isHead,
                    onRespond: { coordinator.promptService.respondPermission($0) },
                    onDismiss: { coordinator.promptService.dismiss() }
                )

            case .question(let questions):
                QuestionCardContent(
                    questions: questions,
                    isStale: prompt.isStale,
                    isHead: isHead,
                    onRespond: { coordinator.promptService.respond(text: $0) },
                    onRespondOption: { coordinator.promptService.respondOption(index: $0) },
                    onRespondMulti: { coordinator.promptService.respondMultiSelect($0) },
                    onDismiss: { coordinator.promptService.dismiss() }
                )
            }
        }
        .opacity(isHead ? 1.0 : 0.6)
    }

    private func overflowIndicator(remaining: Int) -> some View {
        Text("+\(remaining) more pending")
            .font(.caption)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
    }
}

// MARK: - Shared Components

private struct StaleBadge: View {
    var body: some View {
        Text("Stale")
            .font(.caption2)
            .fontWeight(.medium)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(.orange.opacity(0.2))
            .foregroundStyle(.orange)
            .clipShape(Capsule())
    }
}

private struct PendingBadge: View {
    var body: some View {
        Text("Pending")
            .font(.caption2)
            .fontWeight(.medium)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(.secondary.opacity(0.2))
            .foregroundStyle(.secondary)
            .clipShape(Capsule())
    }
}

// MARK: - Permission Card

private struct PermissionCardContent: View {
    let tool: String?
    let command: String?
    let isDestructive: Bool
    let isStale: Bool
    let isHead: Bool
    let onRespond: (PermissionChoice) -> Void
    let onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Allow \(tool ?? "Tool")?")
                    .font(.headline)
                Spacer()
                if !isHead {
                    PendingBadge()
                } else if isStale {
                    StaleBadge()
                }
                if isHead {
                    Button(action: onDismiss) {
                        Image(systemName: "xmark")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(6)
                            .background(.secondary.opacity(0.1))
                            .clipShape(Circle())
                    }
                    .buttonStyle(.plain)
                }
            }

            if let command, !command.isEmpty {
                Text(command)
                    .font(.system(.caption, design: .monospaced))
                    .lineLimit(isHead ? 3 : 1)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.gray.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            }

            if isHead {
                HStack(spacing: 10) {
                    Button {
                        onRespond(.deny)
                    } label: {
                        Text("Deny")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .tint(isDestructive ? .red : nil)

                    Button {
                        onRespond(.allow)
                    } label: {
                        Text("Allow")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)

                    Button {
                        onRespond(.allowAlways)
                    } label: {
                        Text("Always")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                }
            }
        }
    }
}

// MARK: - Question Card

private struct QuestionCardContent: View {
    let questions: [QuestionData]
    let isStale: Bool
    let isHead: Bool
    let onRespond: (String) -> Void
    let onRespondOption: (Int) -> Void
    let onRespondMulti: ([String]) -> Void
    let onDismiss: () -> Void

    var body: some View {
        if let question = questions.first {
            SingleQuestionView(
                question: question,
                isStale: isStale,
                isHead: isHead,
                onSubmit: onRespond,
                onSubmitOption: onRespondOption,
                onSubmitMulti: onRespondMulti,
                onDismiss: onDismiss
            )
        }
    }
}

private struct SingleQuestionView: View {
    let question: QuestionData
    let isStale: Bool
    let isHead: Bool
    let onSubmit: (String) -> Void
    let onSubmitOption: (Int) -> Void
    let onSubmitMulti: ([String]) -> Void
    let onDismiss: () -> Void

    @State private var selectedOption: String?
    @State private var selectedOptionIndex: Int?
    @State private var selectedOptions: Set<String> = []
    @State private var otherText = ""
    @State private var isOtherSelected = false

    private var isMultiSelect: Bool {
        question.multiSelect ?? false
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Header
            HStack {
                if let header = question.header {
                    Text(header)
                        .font(.headline)
                }
                Spacer()
                if !isHead {
                    PendingBadge()
                } else if isStale {
                    StaleBadge()
                }
                if isHead {
                    Button(action: onDismiss) {
                        Image(systemName: "xmark")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(6)
                            .background(.secondary.opacity(0.1))
                            .clipShape(Circle())
                    }
                    .buttonStyle(.plain)
                }
            }

            // Question text
            Text(question.question)
                .font(.subheadline)

            // Options
            if let options = question.options {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(options.enumerated()), id: \.element.label) { index, option in
                        optionRow(option, index: index)
                    }

                    // "Other" freeform option
                    otherRow
                }
            } else {
                // No options — just a text field
                freeformInput
            }

            // Submit button
            submitButton
        }
    }

    @ViewBuilder
    private func optionRow(_ option: QuestionOption, index: Int) -> some View {
        let value = option.value ?? option.label
        Button {
            if isMultiSelect {
                if selectedOptions.contains(value) {
                    selectedOptions.remove(value)
                } else {
                    selectedOptions.insert(value)
                }
                isOtherSelected = false
            } else {
                selectedOption = value
                selectedOptionIndex = index
                isOtherSelected = false
            }
        } label: {
            HStack(spacing: 8) {
                if isMultiSelect {
                    Image(systemName: selectedOptions.contains(value) ? "checkmark.square.fill" : "square")
                        .foregroundStyle(selectedOptions.contains(value) ? .blue : .secondary)
                } else {
                    Image(systemName: selectedOption == value ? "circle.inset.filled" : "circle")
                        .foregroundStyle(selectedOption == value ? .blue : .secondary)
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label)
                        .font(.subheadline)
                    if let desc = option.description, !desc.isEmpty {
                        Text(desc)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Spacer()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var otherRow: some View {
        Button {
            isOtherSelected = true
            if !isMultiSelect {
                selectedOption = nil
            }
        } label: {
            HStack(spacing: 8) {
                if isMultiSelect {
                    Image(systemName: isOtherSelected ? "checkmark.square.fill" : "square")
                        .foregroundStyle(isOtherSelected ? .blue : .secondary)
                } else {
                    Image(systemName: isOtherSelected ? "circle.inset.filled" : "circle")
                        .foregroundStyle(isOtherSelected ? .blue : .secondary)
                }
                Text("Other")
                    .font(.subheadline)
                Spacer()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)

        if isOtherSelected {
            TextField("Type your answer...", text: $otherText)
                .textFieldStyle(.roundedBorder)
                .font(.subheadline)
        }
    }

    private var freeformInput: some View {
        TextField("Type your answer...", text: $otherText)
            .textFieldStyle(.roundedBorder)
            .font(.subheadline)
    }

    private var submitButton: some View {
        Button {
            submit()
        } label: {
            Text("Submit")
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .disabled(!canSubmit || !isHead)
    }

    private var canSubmit: Bool {
        if question.options == nil {
            return !otherText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        if isOtherSelected {
            return !otherText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        if isMultiSelect {
            return !selectedOptions.isEmpty
        }
        return selectedOption != nil
    }

    private func submit() {
        if isMultiSelect {
            var selections = Array(selectedOptions)
            if isOtherSelected {
                let trimmed = otherText.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty {
                    selections.append(trimmed)
                }
            }
            onSubmitMulti(selections)
        } else if isOtherSelected {
            onSubmit(otherText.trimmingCharacters(in: .whitespacesAndNewlines))
        } else if let index = selectedOptionIndex {
            // Use arrow-key navigation for pre-defined options (Claude Code's
            // ink-based selector ignores typed text, only responds to arrow keys)
            onSubmitOption(index)
        } else if question.options == nil {
            onSubmit(otherText.trimmingCharacters(in: .whitespacesAndNewlines))
        }
    }
}
