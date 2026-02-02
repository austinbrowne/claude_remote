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
                ContextDetailPopover(pct: pct)
            }
        }
    }
}

/// Popover showing context usage details
private struct ContextDetailPopover: View {
    let pct: Double

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Context: \(Int(pct * 100))%")
                .font(.subheadline)
                .fontWeight(.semibold)

            Text("\(Int(pct * 100))% used")
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
}
