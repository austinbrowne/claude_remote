import SwiftUI

/// Full-screen overlay shown during context compaction with a spinner and status text.
struct CompactionOverlayView: View {
    @Environment(AppState.self) private var state

    var body: some View {
        if state.isCompacting {
            ZStack {
                Color.black.opacity(0.7)
                    .ignoresSafeArea()

                VStack(spacing: 16) {
                    ProgressView()
                        .scaleEffect(2)
                        .tint(.orange)
                    Text("Compacting context...")
                        .font(.body)
                        .fontWeight(.medium)
                        .foregroundStyle(.white)
                }
            }
            .transition(.opacity)
        }
    }
}
