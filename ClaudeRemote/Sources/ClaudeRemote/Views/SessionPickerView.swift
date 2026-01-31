import SwiftUI

/// Session list for selecting which Claude session to watch
public struct SessionPickerView: View {
    @Environment(AppState.self) private var state
    @Environment(\.dismiss) private var dismiss

    public init() {}

    public var body: some View {
        NavigationStack {
            Group {
                if state.sessions.isEmpty {
                    emptyState
                } else {
                    sessionList
                }
            }
            .navigationTitle("Sessions")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
        }
    }

    private var sessionList: some View {
        List(state.sessions) { session in
            Button {
                selectSession(session)
            } label: {
                SessionRow(
                    session: session,
                    isSelected: session.id == state.currentSessionId
                )
            }
            .listRowBackground(
                session.id == state.currentSessionId
                    ? Color.accentColor.opacity(0.1)
                    : Color.clear
            )
        }
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "terminal")
                .font(.system(size: 48))
                .foregroundStyle(.secondary)
            Text("No active sessions")
                .font(.title3)
            Text("Start a Claude Code session in iTerm to see it here.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
    }

    private func selectSession(_ session: Session) {
        state.beginSessionSwitch(to: session.id)
        dismiss()
    }
}

/// A single row in the session list
struct SessionRow: View {
    let session: Session
    let isSelected: Bool

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(session.name)
                    .font(.headline)
                    .foregroundStyle(.primary)

                HStack(spacing: 8) {
                    if let branch = session.branch {
                        Label(branch, systemImage: "arrow.triangle.branch")
                            .font(.caption)
                            .foregroundStyle(.blue)
                    }

                    if let lastActive = parseServerDate(session.lastActive) {
                        Text(lastActive.relativeString)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Spacer()

            statusIndicator(session.status)

            if isSelected {
                Image(systemName: "checkmark")
                    .foregroundStyle(Color.accentColor)
            }
        }
        .contentShape(Rectangle())
    }

    private func statusIndicator(_ status: SessionStatus) -> some View {
        HStack(spacing: 4) {
            Circle()
                .fill(status.color)
                .frame(width: 8, height: 8)
            Text(status.rawValue)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

}
