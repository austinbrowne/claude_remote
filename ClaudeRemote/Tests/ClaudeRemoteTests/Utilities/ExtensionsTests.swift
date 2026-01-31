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
