import Testing
import Foundation
@testable import ClaudeRemote

@Suite("DiffView.computeDiff")
struct DiffViewTests {

    @MainActor
    @Test("Identical strings produce only context lines")
    func identicalStrings() {
        let lines = DiffView.computeDiff(old: "line1\nline2\nline3", new: "line1\nline2\nline3")
        #expect(lines.count == 3)
        for line in lines {
            #expect(line.type == .context)
        }
    }

    @MainActor
    @Test("Completely different strings")
    func completelyDifferent() {
        let lines = DiffView.computeDiff(old: "alpha\nbeta", new: "gamma\ndelta")
        let removals = lines.filter { $0.type == .removal }
        let additions = lines.filter { $0.type == .addition }
        #expect(removals.count == 2)
        #expect(additions.count == 2)
        #expect(removals[0].content == "alpha")
        #expect(removals[1].content == "beta")
        #expect(additions[0].content == "gamma")
        #expect(additions[1].content == "delta")
    }

    @MainActor
    @Test("Single line addition")
    func singleAddition() {
        let lines = DiffView.computeDiff(old: "a\nc", new: "a\nb\nc")
        let additions = lines.filter { $0.type == .addition }
        let contexts = lines.filter { $0.type == .context }
        #expect(additions.count == 1)
        #expect(additions[0].content == "b")
        #expect(contexts.count == 2)
    }

    @MainActor
    @Test("Single line removal")
    func singleRemoval() {
        let lines = DiffView.computeDiff(old: "a\nb\nc", new: "a\nc")
        let removals = lines.filter { $0.type == .removal }
        let contexts = lines.filter { $0.type == .context }
        #expect(removals.count == 1)
        #expect(removals[0].content == "b")
        #expect(contexts.count == 2)
    }

    @MainActor
    @Test("Single line replacement")
    func singleReplacement() {
        let lines = DiffView.computeDiff(old: "a\nold\nc", new: "a\nnew\nc")
        let removals = lines.filter { $0.type == .removal }
        let additions = lines.filter { $0.type == .addition }
        #expect(removals.count == 1)
        #expect(removals[0].content == "old")
        #expect(additions.count == 1)
        #expect(additions[0].content == "new")
    }

    @MainActor
    @Test("Empty old string (all additions)")
    func emptyOld() {
        let lines = DiffView.computeDiff(old: "", new: "a\nb")
        let additions = lines.filter { $0.type == .addition }
        #expect(additions.count >= 2)
    }

    @MainActor
    @Test("Empty new string (all removals)")
    func emptyNew() {
        let lines = DiffView.computeDiff(old: "a\nb", new: "")
        let removals = lines.filter { $0.type == .removal }
        #expect(removals.count >= 2)
    }

    @MainActor
    @Test("Both empty strings")
    func bothEmpty() {
        let lines = DiffView.computeDiff(old: "", new: "")
        #expect(lines.count == 1)
        #expect(lines[0].type == .context)
    }

    @MainActor
    @Test("Line numbers are correct for context lines")
    func lineNumbersContext() {
        let lines = DiffView.computeDiff(old: "a\nb\nc", new: "a\nb\nc")
        #expect(lines[0].oldLineNumber == 1)
        #expect(lines[0].newLineNumber == 1)
        #expect(lines[1].oldLineNumber == 2)
        #expect(lines[1].newLineNumber == 2)
        #expect(lines[2].oldLineNumber == 3)
        #expect(lines[2].newLineNumber == 3)
    }

    @MainActor
    @Test("Line numbers for removals reference old file")
    func lineNumbersRemovals() {
        let lines = DiffView.computeDiff(old: "a\nb", new: "a")
        let removal = lines.first { $0.type == .removal }
        #expect(removal?.oldLineNumber == 2)
        #expect(removal?.newLineNumber == nil)
    }

    @MainActor
    @Test("Line numbers for additions reference new file")
    func lineNumbersAdditions() {
        let lines = DiffView.computeDiff(old: "a", new: "a\nb")
        let addition = lines.first { $0.type == .addition }
        #expect(addition?.oldLineNumber == nil)
        #expect(addition?.newLineNumber == 2)
    }

    @MainActor
    @Test("Each diff line has a unique ID")
    func uniqueIds() {
        let lines = DiffView.computeDiff(old: "a\nb\nc", new: "a\nx\nc")
        let ids = Set(lines.map(\.id))
        #expect(ids.count == lines.count)
    }

    @MainActor
    @Test("Multi-line additions at end")
    func multiLineAdditionAtEnd() {
        let lines = DiffView.computeDiff(old: "a", new: "a\nb\nc\nd")
        let additions = lines.filter { $0.type == .addition }
        #expect(additions.count == 3)
        #expect(additions.map(\.content) == ["b", "c", "d"])
    }

    @MainActor
    @Test("Multi-line removals at start")
    func multiLineRemovalAtStart() {
        let lines = DiffView.computeDiff(old: "x\ny\nz", new: "z")
        let removals = lines.filter { $0.type == .removal }
        #expect(removals.count == 2)
        #expect(removals.map(\.content) == ["x", "y"])
    }
}
