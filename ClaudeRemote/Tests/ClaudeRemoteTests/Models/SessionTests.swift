import Testing
import Foundation
@testable import ClaudeRemote

@Suite("Session Model")
struct SessionTests {

    @Test("Decode session from server JSON")
    func decodeSession() throws {
        let json = """
        {
            "id": "abc-123",
            "name": "claude_remote",
            "status": "waiting",
            "cwd": "/Users/austin/projects",
            "branch": "main",
            "lastActive": "2026-01-30T10:00:00.000Z",
            "logFile": "/tmp/session.jsonl",
            "tty": "/dev/ttys004",
            "pid": 12345
        }
        """.data(using: .utf8)!

        let session = try JSONDecoder().decode(Session.self, from: json)
        #expect(session.id == "abc-123")
        #expect(session.name == "claude_remote")
        #expect(session.status == .waiting)
        #expect(session.cwd == "/Users/austin/projects")
        #expect(session.branch == "main")
        #expect(session.lastActive == "2026-01-30T10:00:00.000Z")
        #expect(session.logFile == "/tmp/session.jsonl")
        #expect(session.tty == "/dev/ttys004")
        #expect(session.pid == 12345)
    }

    @Test("Decode session with minimal fields")
    func decodeMinimalSession() throws {
        let json = """
        {
            "id": "xyz",
            "name": "test"
        }
        """.data(using: .utf8)!

        let session = try JSONDecoder().decode(Session.self, from: json)
        #expect(session.id == "xyz")
        #expect(session.name == "test")
        #expect(session.status == .unknown)
        #expect(session.cwd == nil)
        #expect(session.branch == nil)
        #expect(session.pid == nil)
    }

    @Test("SessionStatus decodes known values")
    func decodeKnownStatuses() throws {
        let statuses = ["idle", "waiting", "processing", "active"]
        let expected: [SessionStatus] = [.idle, .waiting, .processing, .active]

        for (raw, expected) in zip(statuses, expected) {
            let json = "\"\(raw)\"".data(using: .utf8)!
            let status = try JSONDecoder().decode(SessionStatus.self, from: json)
            #expect(status == expected)
        }
    }

    @Test("SessionStatus decodes unknown value as .unknown")
    func decodeUnknownStatus() throws {
        let json = "\"some_future_status\"".data(using: .utf8)!
        let status = try JSONDecoder().decode(SessionStatus.self, from: json)
        #expect(status == .unknown)
    }

    @Test("Session equality")
    func sessionEquality() {
        let a = Session(id: "1", name: "test", status: .idle)
        let b = Session(id: "1", name: "test", status: .idle)
        let c = Session(id: "2", name: "test", status: .idle)
        #expect(a == b)
        #expect(a != c)
    }

    @Test("Session init with defaults")
    func sessionInitDefaults() {
        let session = Session(id: "test", name: "Test Session")
        #expect(session.status == .unknown)
        #expect(session.cwd == nil)
        #expect(session.branch == nil)
        #expect(session.lastActive == nil)
        #expect(session.logFile == nil)
        #expect(session.tty == nil)
        #expect(session.pid == nil)
    }

    @Test("Session encodes and decodes round-trip")
    func roundTrip() throws {
        let original = Session(
            id: "rt-1",
            name: "Round Trip",
            status: .processing,
            cwd: "/tmp",
            branch: "feat/test",
            lastActive: "2026-01-30T12:00:00Z",
            logFile: "/logs/test.jsonl",
            tty: "/dev/ttys001",
            pid: 9999
        )
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(Session.self, from: data)
        #expect(decoded == original)
    }
}
