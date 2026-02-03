import SwiftUI

/// Compact circular progress ring showing context window usage
struct ContextRingView: View {
    @Environment(AppState.self) private var state

    @State private var showOverlay = false

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
                showOverlay = true
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
            .sheet(isPresented: $showOverlay) {
                ContextDetailSheet()
                    .presentationDetents([.medium])
                    .presentationDragIndicator(.visible)
            }
        }
    }
}

/// Sheet overlay showing session context and status details
private struct ContextDetailSheet: View {
    @Environment(AppState.self) private var state
    @Environment(AppCoordinator.self) private var coordinator
    @Environment(\.dismiss) private var dismiss

    private var pct: Double { state.contextPercentage }
    private var pctInt: Int { Int(pct * 100) }

    private var ringColor: Color {
        switch pct {
        case ..<0.7: .green
        case 0.7..<0.9: .orange
        default: .red
        }
    }

    private var statusLabel: String {
        switch state.sessionStatus {
        case .processing: "Processing"
        case .waiting: "Waiting for input"
        case .active: "Active"
        case .idle: "Idle"
        case .unknown: "Unknown"
        }
    }

    private var statusColor: Color {
        switch state.sessionStatus {
        case .processing: .blue
        case .waiting: .orange
        case .active: .green
        case .idle: .secondary
        case .unknown: .secondary
        }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                // Large context ring
                ZStack {
                    Circle()
                        .stroke(Color.secondary.opacity(0.15), lineWidth: 8)
                    Circle()
                        .trim(from: 0, to: pct)
                        .stroke(ringColor, style: StrokeStyle(lineWidth: 8, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                        .animation(.easeInOut(duration: 0.5), value: pct)
                    VStack(spacing: 2) {
                        Text("\(pctInt)%")
                            .font(.title)
                            .fontWeight(.bold)
                            .fontDesign(.rounded)
                        Text("context")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(width: 100, height: 100)

                // Status rows
                VStack(spacing: 12) {
                    infoRow(label: "Status", value: statusLabel, color: statusColor)
                    infoRow(label: "Mode", value: state.sessionMode.label, color: modeColor)

                    if !state.activeSubagents.isEmpty {
                        let running = state.activeSubagents.values.filter { $0.status == "running" }.count
                        infoRow(
                            label: "Subagents",
                            value: "\(running) active",
                            color: running > 0 ? .blue : .secondary
                        )
                    }

                    if pct > 0 {
                        let remaining = Int((1.0 - pct) * 200_000)
                        infoRow(
                            label: "Remaining",
                            value: "~\(remaining.formatted()) tokens",
                            color: .secondary
                        )
                    }
                }
                .padding(.horizontal)

                // Warning / action
                if pct >= 0.8 {
                    Button {
                        sendCompact()
                        dismiss()
                    } label: {
                        Label("Send /compact", systemImage: "arrow.triangle.2.circlepath")
                            .font(.subheadline)
                            .fontWeight(.medium)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(pct >= 0.9 ? .red : .orange)
                    .padding(.horizontal)
                }

                Spacer()
            }
            .padding(.top, 24)
            .navigationTitle("Session Info")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private var modeColor: Color {
        switch state.sessionMode {
        case .defaultMode: .secondary
        case .acceptEdits: .green
        case .plan: .orange
        }
    }

    private func infoRow(label: String, value: String, color: Color) -> some View {
        HStack {
            Text(label)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .font(.subheadline)
                .fontWeight(.medium)
                .foregroundStyle(color)
        }
    }

    private func sendCompact() {
        guard let sessionId = state.currentSessionId else { return }
        coordinator.injectCommand("/compact", sessionId: sessionId)
    }
}
