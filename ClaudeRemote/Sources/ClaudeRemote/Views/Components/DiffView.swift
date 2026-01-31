import SwiftUI

/// A line in a diff output
public struct DiffLine: Identifiable, Sendable {
    public let id: Int
    public let type: DiffLineType
    public let content: String
    public let oldLineNumber: Int?
    public let newLineNumber: Int?
}

/// Type of diff line
public enum DiffLineType: Sendable {
    case context
    case addition
    case removal
}

/// Displays a diff between old_string and new_string from an Edit tool call
struct DiffView: View {
    let oldString: String
    let newString: String
    var maxLines: Int = 40

    @State private var showAll = false
    @State private var computedLines: [DiffLine]?

    /// Maximum product of line counts before falling back to simple diff
    static let maxLCSComplexity = 500_000

    var body: some View {
        let lines = computedLines ?? []
        let visible = showAll ? lines : Array(lines.prefix(maxLines))

        VStack(alignment: .leading, spacing: 0) {
            if computedLines == nil {
                HStack(spacing: 6) {
                    ProgressView()
                        .scaleEffect(0.6)
                        .frame(width: 12, height: 12)
                    Text("Computing diff...")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(8)
            } else {
                ForEach(visible) { line in
                    DiffLineView(line: line)
                }

                if !showAll && lines.count > maxLines {
                    Button {
                        showAll = true
                    } label: {
                        Text("Show \(lines.count - maxLines) more lines...")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(.vertical, 4)
                            .padding(.horizontal, 8)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .onAppear {
            if computedLines == nil {
                computedLines = Self.computeDiff(old: oldString, new: newString)
            }
        }
    }

    /// Compute a line-by-line diff using a simple LCS-based algorithm
    static func computeDiff(old: String, new: String) -> [DiffLine] {
        let oldLines = old.components(separatedBy: .newlines)
        let newLines = new.components(separatedBy: .newlines)

        // Size guard: fall back to simple before/after for very large diffs
        if oldLines.count * newLines.count > maxLCSComplexity {
            return simpleDiff(oldLines: oldLines, newLines: newLines)
        }

        let lcs = longestCommonSubsequence(oldLines, newLines)
        var result: [DiffLine] = []
        var oldIdx = 0
        var newIdx = 0
        var lineId = 0

        for commonLine in lcs {
            // Emit removals from old until we reach the common line
            while oldIdx < oldLines.count && oldLines[oldIdx] != commonLine {
                result.append(DiffLine(id: lineId, type: .removal, content: oldLines[oldIdx], oldLineNumber: oldIdx + 1, newLineNumber: nil))
                lineId += 1
                oldIdx += 1
            }
            // Emit additions from new until we reach the common line
            while newIdx < newLines.count && newLines[newIdx] != commonLine {
                result.append(DiffLine(id: lineId, type: .addition, content: newLines[newIdx], oldLineNumber: nil, newLineNumber: newIdx + 1))
                lineId += 1
                newIdx += 1
            }
            // Emit the common line
            result.append(DiffLine(id: lineId, type: .context, content: commonLine, oldLineNumber: oldIdx + 1, newLineNumber: newIdx + 1))
            lineId += 1
            oldIdx += 1
            newIdx += 1
        }

        // Remaining old lines are removals
        while oldIdx < oldLines.count {
            result.append(DiffLine(id: lineId, type: .removal, content: oldLines[oldIdx], oldLineNumber: oldIdx + 1, newLineNumber: nil))
            lineId += 1
            oldIdx += 1
        }
        // Remaining new lines are additions
        while newIdx < newLines.count {
            result.append(DiffLine(id: lineId, type: .addition, content: newLines[newIdx], oldLineNumber: nil, newLineNumber: newIdx + 1))
            lineId += 1
            newIdx += 1
        }

        return result
    }

    /// Simple fallback for large inputs: show all old as removals, all new as additions
    private static func simpleDiff(oldLines: [String], newLines: [String]) -> [DiffLine] {
        var result: [DiffLine] = []
        var lineId = 0
        for (i, line) in oldLines.enumerated() {
            result.append(DiffLine(id: lineId, type: .removal, content: line, oldLineNumber: i + 1, newLineNumber: nil))
            lineId += 1
        }
        for (i, line) in newLines.enumerated() {
            result.append(DiffLine(id: lineId, type: .addition, content: line, oldLineNumber: nil, newLineNumber: i + 1))
            lineId += 1
        }
        return result
    }

    /// Standard LCS algorithm for string arrays
    private static func longestCommonSubsequence(_ a: [String], _ b: [String]) -> [String] {
        let m = a.count
        let n = b.count
        var dp = Array(repeating: Array(repeating: 0, count: n + 1), count: m + 1)

        for i in 1...m {
            for j in 1...n {
                if a[i - 1] == b[j - 1] {
                    dp[i][j] = dp[i - 1][j - 1] + 1
                } else {
                    dp[i][j] = max(dp[i - 1][j], dp[i][j - 1])
                }
            }
        }

        // Backtrack to find the actual subsequence
        var result: [String] = []
        var i = m, j = n
        while i > 0 && j > 0 {
            if a[i - 1] == b[j - 1] {
                result.append(a[i - 1])
                i -= 1
                j -= 1
            } else if dp[i - 1][j] > dp[i][j - 1] {
                i -= 1
            } else {
                j -= 1
            }
        }

        return result.reversed()
    }
}

/// Renders a single diff line with coloring
private struct DiffLineView: View {
    let line: DiffLine

    var body: some View {
        HStack(spacing: 0) {
            // Line number
            Text(lineNumberText)
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.secondary)
                .frame(width: 36, alignment: .trailing)
                .padding(.trailing, 4)

            // Prefix
            Text(prefix)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(prefixColor)
                .frame(width: 14)

            // Content
            Text(line.content)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.primary)
                .textSelection(.enabled)

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 1)
        .background(backgroundColor)
    }

    private var lineNumberText: String {
        if line.type == .addition {
            return "\(line.newLineNumber ?? 0)"
        }
        return "\(line.oldLineNumber ?? 0)"
    }

    private var prefix: String {
        switch line.type {
        case .context: " "
        case .addition: "+"
        case .removal: "-"
        }
    }

    private var prefixColor: Color {
        switch line.type {
        case .context: .secondary
        case .addition: .green
        case .removal: .red
        }
    }

    private var backgroundColor: Color {
        switch line.type {
        case .context: .clear
        case .addition: .green.opacity(0.1)
        case .removal: .red.opacity(0.1)
        }
    }
}
