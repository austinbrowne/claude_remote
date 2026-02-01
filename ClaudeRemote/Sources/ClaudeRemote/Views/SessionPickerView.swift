import SwiftUI

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

            SessionStatusBadge(status: session.status)

            if isSelected {
                Image(systemName: "checkmark")
                    .foregroundStyle(Color.accentColor)
            }
        }
        .contentShape(Rectangle())
    }
}
