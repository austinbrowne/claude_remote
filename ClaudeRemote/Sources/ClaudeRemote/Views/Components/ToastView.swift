import SwiftUI

/// Toast notification model
public struct ToastItem: Identifiable, Equatable, Sendable {
    public let id = UUID()
    public let message: String
    public let icon: String
    public let style: ToastStyle

    public enum ToastStyle: Equatable, Sendable {
        case info
        case success
        case warning
        case error
    }

    public static func == (lhs: ToastItem, rhs: ToastItem) -> Bool {
        lhs.id == rhs.id
    }
}

/// Overlay that shows a toast notification, auto-dismisses after a delay
struct ToastOverlay: View {
    let toast: ToastItem?
    let onDismiss: () -> Void

    var body: some View {
        if let toast {
            VStack {
                HStack(spacing: 8) {
                    Image(systemName: toast.icon)
                        .font(.caption)
                        .foregroundStyle(iconColor(for: toast.style))
                    Text(toast.message)
                        .font(.caption)
                        .fontWeight(.medium)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(.ultraThinMaterial)
                .clipShape(Capsule())
                .shadow(radius: 4)
                .onTapGesture { withAnimation { onDismiss() } }

                Spacer()
            }
            .padding(.top, 8)
            .transition(.move(edge: .top).combined(with: .opacity))
            // Use toast ID as view identity so each new toast triggers onAppear
            // (without this, replacing one toast with another skips onAppear)
            .id(toast.id)
            .onAppear {
                Task { @MainActor in
                    try? await Task.sleep(for: .seconds(2.5))
                    withAnimation(.easeOut(duration: 0.3)) {
                        onDismiss()
                    }
                }
            }
        }
    }

    private func iconColor(for style: ToastItem.ToastStyle) -> Color {
        switch style {
        case .info: .blue
        case .success: .green
        case .warning: .orange
        case .error: .red
        }
    }
}
