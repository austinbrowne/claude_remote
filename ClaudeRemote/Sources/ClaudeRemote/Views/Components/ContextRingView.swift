import SwiftUI

/// Compact circular progress ring showing context window usage
struct ContextRingView: View {
    @Environment(AppState.self) private var state

    @State private var showPopover = false

    private var pct: Double { state.contextPercentage }

    private var ringColor: Color {
        switch pct {
        case ..<0.7: .green
        case 0.7..<0.9: .orange
        default: .red
        }
    }

    var body: some View {
        if state.currentSessionId != nil {
            Button {
                showPopover = true
            } label: {
                ZStack {
                    Circle()
                        .stroke(Color.secondary.opacity(0.2), lineWidth: 2.5)
                    Circle()
                        .trim(from: 0, to: pct)
                        .stroke(ringColor, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                        .animation(.easeInOut(duration: 0.4), value: pct)
                }
                .frame(width: 22, height: 22)
            }
            .popover(isPresented: $showPopover) {
                ContextDetailPopover(pct: pct, tokensUsed: state.contextTokensUsed)
            }
        }
    }
}

/// Popover showing context usage details
private struct ContextDetailPopover: View {
    let pct: Double
    let tokensUsed: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Context: \(Int(pct * 100))%")
                .font(.subheadline)
                .fontWeight(.semibold)

            Text("~\(formatTokens(tokensUsed)) / 200k tokens")
                .font(.caption)
                .foregroundStyle(.secondary)

            if pct > 0.8 {
                Text("Consider /compact to free space")
                    .font(.caption2)
                    .foregroundStyle(.orange)
            }
        }
        .padding(12)
        .frame(width: 200, alignment: .leading)
        .presentationCompactAdaptation(.popover)
    }

    private func formatTokens(_ count: Int) -> String {
        if count >= 1_000_000 {
            let m = Double(count) / 1_000_000
            return String(format: "%.1fM", m)
        } else if count >= 1_000 {
            let k = Double(count) / 1_000
            return k == k.rounded() ? "\(Int(k))k" : String(format: "%.1fk", k)
        } else {
            return "\(count)"
        }
    }
}
