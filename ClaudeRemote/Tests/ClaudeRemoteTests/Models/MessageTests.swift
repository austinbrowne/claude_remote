import Testing
import Foundation
@testable import ClaudeRemote

@Suite("Message Model")
struct MessageTests {

    @Test("MessageType decodes known values")
    func decodeKnownTypes() throws {
        let cases: [(String, MessageType)] = [
            ("assistant", .assistant),
            ("user", .user),
            ("tool", .tool),
            ("tool_result", .toolResult),
            ("status_update", .statusUpdate),
            ("permission_request", .permissionRequest),
            ("ask_user_question", .askUserQuestion),
            ("token_usage", .tokenUsage),
            ("subagent_starting", .subagentStarting),
        ]

        for (raw, expected) in cases {
            let json = "\"\(raw)\"".data(using: .utf8)!
            let decoded = try JSONDecoder().decode(MessageType.self, from: json)
            #expect(decoded == expected, "Expected \(raw) to decode as \(expected)")
        }
    }

    @Test("MessageType decodes unknown value")
    func decodeUnknownType() throws {
        let json = "\"future_type\"".data(using: .utf8)!
        let decoded = try JSONDecoder().decode(MessageType.self, from: json)
        #expect(decoded == .unknown)
    }

    @Test("Message has unique ID")
    func messageUniqueId() {
        let a = Message(type: .assistant, content: "Hello")
        let b = Message(type: .assistant, content: "Hello")
        #expect(a.id != b.id)
    }

    @Test("Message stores all properties")
    func messageProperties() {
        let msg = Message(
            type: .tool,
            content: "output",
            tool: "Bash",
            toolInput: ["command": .string("ls")],
            language: "bash",
            isSubagent: true,
            subagentId: "agent-1"
        )
        #expect(msg.type == .tool)
        #expect(msg.content == "output")
        #expect(msg.tool == "Bash")
        #expect(msg.toolInput?["command"]?.stringValue == "ls")
        #expect(msg.language == "bash")
        #expect(msg.isSubagent == true)
        #expect(msg.subagentId == "agent-1")
    }

    @Test("Message defaults")
    func messageDefaults() {
        let msg = Message(type: .assistant)
        #expect(msg.content == nil)
        #expect(msg.tool == nil)
        #expect(msg.toolInput == nil)
        #expect(msg.language == nil)
        #expect(msg.isSubagent == false)
        #expect(msg.subagentId == nil)
    }
}

@Suite("AnyCodableValue")
struct AnyCodableValueTests {

    @Test("Decode string value")
    func decodeString() throws {
        let json = "\"hello\"".data(using: .utf8)!
        let value = try JSONDecoder().decode(AnyCodableValue.self, from: json)
        #expect(value == .string("hello"))
        #expect(value.stringValue == "hello")
    }

    @Test("Decode int value")
    func decodeInt() throws {
        let json = "42".data(using: .utf8)!
        let value = try JSONDecoder().decode(AnyCodableValue.self, from: json)
        #expect(value == .int(42))
        #expect(value.intValue == 42)
    }

    @Test("Decode bool value")
    func decodeBool() throws {
        let json = "true".data(using: .utf8)!
        let value = try JSONDecoder().decode(AnyCodableValue.self, from: json)
        #expect(value == .bool(true))
        #expect(value.boolValue == true)
    }

    @Test("Decode null value")
    func decodeNull() throws {
        let json = "null".data(using: .utf8)!
        let value = try JSONDecoder().decode(AnyCodableValue.self, from: json)
        #expect(value == .null)
    }

    @Test("Decode array value")
    func decodeArray() throws {
        let json = "[1, 2, 3]".data(using: .utf8)!
        let value = try JSONDecoder().decode(AnyCodableValue.self, from: json)
        #expect(value == .array([.int(1), .int(2), .int(3)]))
    }

    @Test("Decode dictionary value")
    func decodeDictionary() throws {
        let json = "{\"key\": \"value\"}".data(using: .utf8)!
        let value = try JSONDecoder().decode(AnyCodableValue.self, from: json)
        #expect(value == .dictionary(["key": .string("value")]))
    }

    @Test("Encode round-trip")
    func encodeRoundTrip() throws {
        let original = AnyCodableValue.dictionary([
            "name": .string("test"),
            "count": .int(5),
            "active": .bool(true),
            "items": .array([.string("a"), .string("b")]),
            "meta": .null
        ])
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(AnyCodableValue.self, from: data)
        #expect(decoded == original)
    }

    @Test("String value accessor returns nil for non-string")
    func stringAccessorOnNonString() {
        #expect(AnyCodableValue.int(42).stringValue == nil)
        #expect(AnyCodableValue.bool(true).stringValue == nil)
        #expect(AnyCodableValue.null.stringValue == nil)
    }

    @Test("Int value accessor returns nil for non-int")
    func intAccessorOnNonInt() {
        #expect(AnyCodableValue.string("hello").intValue == nil)
        #expect(AnyCodableValue.bool(true).intValue == nil)
    }

    @Test("Bool value accessor returns nil for non-bool")
    func boolAccessorOnNonBool() {
        #expect(AnyCodableValue.string("true").boolValue == nil)
        #expect(AnyCodableValue.int(1).boolValue == nil)
    }

    @Test("toAny conversion")
    func toAnyConversion() {
        #expect(AnyCodableValue.string("hi").toAny() as? String == "hi")
        #expect(AnyCodableValue.int(7).toAny() as? Int == 7)
        #expect(AnyCodableValue.double(3.14).toAny() as? Double == 3.14)
        #expect(AnyCodableValue.bool(false).toAny() as? Bool == false)
        #expect(AnyCodableValue.null.toAny() is NSNull)
    }
}
