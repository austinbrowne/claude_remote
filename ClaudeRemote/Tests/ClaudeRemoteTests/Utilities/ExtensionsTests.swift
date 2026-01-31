import Testing
import Foundation
@testable import ClaudeRemote

@Suite("String Extensions")
struct StringExtensionsTests {

    @Test("truncated within limit")
    func truncatedWithin() {
        #expect("hello".truncated(to: 10) == "hello")
        #expect("hello".truncated(to: 5) == "hello")
    }

    @Test("truncated over limit")
    func truncatedOver() {
        #expect("hello world".truncated(to: 5) == "hello...")
        #expect("abcdef".truncated(to: 3) == "abc...")
    }

    @Test("truncated empty string")
    func truncatedEmpty() {
        #expect("".truncated(to: 5) == "")
        #expect("".truncated(to: 0) == "")
    }

    @Test("firstLine single line")
    func firstLineSingle() {
        #expect("hello world".firstLine == "hello world")
    }

    @Test("firstLine multi-line")
    func firstLineMulti() {
        #expect("first\nsecond\nthird".firstLine == "first")
    }

    @Test("firstLine empty string")
    func firstLineEmpty() {
        #expect("".firstLine == "")
    }

}

@Suite("Date Extensions")
struct DateExtensionsTests {

    @Test("relativeString just now")
    func relativeJustNow() {
        let date = Date()
        #expect(date.relativeString == "just now")
    }

    @Test("relativeString minutes ago")
    func relativeMinutes() {
        let date = Date().addingTimeInterval(-120) // 2 minutes ago
        #expect(date.relativeString == "2m ago")
    }

    @Test("relativeString hours ago")
    func relativeHours() {
        let date = Date().addingTimeInterval(-7200) // 2 hours ago
        #expect(date.relativeString == "2h ago")
    }

    @Test("relativeString days ago")
    func relativeDays() {
        let date = Date().addingTimeInterval(-172800) // 2 days ago
        #expect(date.relativeString == "2d ago")
    }
}

@Suite("formatTokenCount")
struct FormatTokenCountTests {

    @Test("Small numbers shown as-is")
    func smallNumbers() {
        #expect(formatTokenCount(500, 200) == "500 in / 200 out")
    }

    @Test("Thousands formatted with k suffix")
    func thousands() {
        #expect(formatTokenCount(1_500, 3_200) == "1.5k in / 3.2k out")
    }

    @Test("Millions formatted with M suffix")
    func millions() {
        #expect(formatTokenCount(1_500_000, 2_300_000) == "1.5M in / 2.3M out")
    }

    @Test("Zero values")
    func zeros() {
        #expect(formatTokenCount(0, 0) == "0 in / 0 out")
    }

    @Test("Exact boundary at 1000")
    func exactThousand() {
        #expect(formatTokenCount(1_000, 999) == "1.0k in / 999 out")
    }
}

@Suite("TaskItem stableId")
struct TaskItemStableIdTests {

    @Test("Uses id when available")
    func usesId() {
        let task = TaskItem(id: "task-1", subject: "Do thing", status: "pending")
        #expect(task.stableId == "task-1")
    }

    @Test("Falls back to subject when id is nil")
    func fallsBackToSubject() {
        let task = TaskItem(id: nil, subject: "Do thing", status: "pending")
        #expect(task.stableId == "Do thing")
    }

    @Test("Falls back to static string when both nil")
    func fallsBackToStatic() {
        let task = TaskItem(id: nil, subject: nil, status: "pending")
        // Must be deterministic — same value every time
        #expect(task.stableId == task.stableId)
        #expect(task.stableId == "task-unknown")
    }
}

@Suite("parseServerDate")
struct ParseServerDateTests {

    @Test("Parse ISO8601 with fractional seconds")
    func parseFractional() {
        let date = parseServerDate("2026-01-30T10:00:00.000Z")
        #expect(date != nil)
    }

    @Test("Parse ISO8601 without fractional seconds")
    func parseNoFractional() {
        let date = parseServerDate("2026-01-30T10:00:00Z")
        #expect(date != nil)
    }

    @Test("Parse nil returns nil")
    func parseNil() {
        #expect(parseServerDate(nil) == nil)
    }

    @Test("Parse invalid string returns nil")
    func parseInvalid() {
        #expect(parseServerDate("not a date") == nil)
    }

    @Test("Parse empty string returns nil")
    func parseEmpty() {
        #expect(parseServerDate("") == nil)
    }
}
