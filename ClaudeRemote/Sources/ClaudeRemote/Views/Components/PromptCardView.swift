import SwiftUI

/// Renders the current prompt card (permission or question)
struct PromptCardView: View {
    @Environment(AppCoordinator.self) private var coordinator

    var body: some View {
        if let prompt = coordinator.promptService.currentPrompt {
            VStack(spacing: 0) {
                Divider()
                cardContent(for: prompt)
                    .padding(12)
                    .background(.regularMaterial)
            }
        }
    }

    @ViewBuilder
    private func cardContent(for prompt: PromptItem) -> some View {
        switch prompt.kind {
        case .permission(let tool, let command, let isDestructive):
            PermissionCardContent(
                tool: tool,
                command: command,
                isDestructive: isDestructive,
                isStale: prompt.isStale,
                onRespond: { coordinator.promptService.respondPermission($0) }
            )

        case .question(let questions):
            QuestionCardContent(
                questions: questions,
                isStale: prompt.isStale,
                onRespond: { coordinator.promptService.respond(text: $0) },
                onRespondMulti: { coordinator.promptService.respondMultiSelect($0) }
            )
        }
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

// MARK: - Permission Card

private struct PermissionCardContent: View {
    let tool: String?
    let command: String?
    let isDestructive: Bool
    let isStale: Bool
    let onRespond: (PermissionChoice) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Allow \(tool ?? "Tool")?")
                    .font(.headline)
                Spacer()
                if isStale {
                    StaleBadge()
                }
            }

            if let command, !command.isEmpty {
                Text(command)
                    .font(.system(.caption, design: .monospaced))
                    .lineLimit(3)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.gray.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            }

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

// MARK: - Question Card

private struct QuestionCardContent: View {
    let questions: [QuestionData]
    let isStale: Bool
    let onRespond: (String) -> Void
    let onRespondMulti: ([String]) -> Void

    var body: some View {
        if let question = questions.first {
            SingleQuestionView(
                question: question,
                isStale: isStale,
                onSubmit: onRespond,
                onSubmitMulti: onRespondMulti
            )
        }
    }
}

private struct SingleQuestionView: View {
    let question: QuestionData
    let isStale: Bool
    let onSubmit: (String) -> Void
    let onSubmitMulti: ([String]) -> Void

    @State private var selectedOption: String?
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
                if isStale {
                    StaleBadge()
                }
            }

            // Question text
            Text(question.question)
                .font(.subheadline)

            // Options
            if let options = question.options {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(options, id: \.label) { option in
                        optionRow(option)
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
    private func optionRow(_ option: QuestionOption) -> some View {
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
        .disabled(!canSubmit)
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
        } else if let selected = selectedOption {
            onSubmit(selected)
        } else if question.options == nil {
            onSubmit(otherText.trimmingCharacters(in: .whitespacesAndNewlines))
        }
    }
}
