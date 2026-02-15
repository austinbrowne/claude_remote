import Testing
import Foundation
@testable import ClaudeRemote

@Suite("FileEntry Model")
struct FileEntryTests {

    @Test("Decode directory entry from server JSON")
    func decodeDirectoryEntry() throws {
        let json = """
        {
            "name": "src",
            "relativePath": "src",
            "isDirectory": true,
            "size": null
        }
        """.data(using: .utf8)!

        let entry = try JSONDecoder().decode(FileEntry.self, from: json)
        #expect(entry.name == "src")
        #expect(entry.relativePath == "src")
        #expect(entry.isDirectory == true)
        #expect(entry.size == nil)
        #expect(entry.id == "src")
    }

    @Test("Decode file entry with size")
    func decodeFileEntry() throws {
        let json = """
        {
            "name": "server.js",
            "relativePath": "server.js",
            "isDirectory": false,
            "size": 89120
        }
        """.data(using: .utf8)!

        let entry = try JSONDecoder().decode(FileEntry.self, from: json)
        #expect(entry.name == "server.js")
        #expect(entry.relativePath == "server.js")
        #expect(entry.isDirectory == false)
        #expect(entry.size == 89120)
        #expect(entry.id == "server.js")
    }

    @Test("Decode nested file entry uses relativePath as id")
    func decodeNestedEntry() throws {
        let json = """
        {
            "name": "main.swift",
            "relativePath": "Sources/App/main.swift",
            "isDirectory": false,
            "size": 1024
        }
        """.data(using: .utf8)!

        let entry = try JSONDecoder().decode(FileEntry.self, from: json)
        #expect(entry.id == "Sources/App/main.swift")
    }

    @Test("Decode entry without size field")
    func decodeEntryMissingSize() throws {
        let json = """
        {
            "name": "docs",
            "relativePath": "docs",
            "isDirectory": true
        }
        """.data(using: .utf8)!

        let entry = try JSONDecoder().decode(FileEntry.self, from: json)
        #expect(entry.size == nil)
    }

    @Test("FileEntry equality based on all fields")
    func equality() {
        let a = FileEntry(name: "test.txt", relativePath: "test.txt", isDirectory: false, size: 100)
        let b = FileEntry(name: "test.txt", relativePath: "test.txt", isDirectory: false, size: 100)
        let c = FileEntry(name: "other.txt", relativePath: "other.txt", isDirectory: false, size: 100)
        #expect(a == b)
        #expect(a != c)
    }

    @Test("FileEntry encodes and decodes round-trip")
    func roundTrip() throws {
        let original = FileEntry(name: "README.md", relativePath: "docs/README.md", isDirectory: false, size: 2048)
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(FileEntry.self, from: data)
        #expect(decoded == original)
    }

    @Test("Decode FileContent with content")
    func decodeFileContent() throws {
        let json = """
        {
            "path": "server.js",
            "content": "const express = require('express');",
            "language": "javascript",
            "size": 34
        }
        """.data(using: .utf8)!

        let content = try JSONDecoder().decode(FileContent.self, from: json)
        #expect(content.path == "server.js")
        #expect(content.content == "const express = require('express');")
        #expect(content.language == "javascript")
        #expect(content.size == 34)
        #expect(content.error == nil)
    }

    @Test("Decode FileContent with error (binary file)")
    func decodeFileContentError() throws {
        let json = """
        {
            "path": "image.png",
            "size": 51200,
            "error": "Binary file"
        }
        """.data(using: .utf8)!

        let content = try JSONDecoder().decode(FileContent.self, from: json)
        #expect(content.path == "image.png")
        #expect(content.content == nil)
        #expect(content.language == nil)
        #expect(content.size == 51200)
        #expect(content.error == "Binary file")
    }

    @Test("Decode FileContent with file too large error")
    func decodeFileContentTooLarge() throws {
        let json = """
        {
            "path": "huge.bin",
            "size": 2097152,
            "error": "File too large"
        }
        """.data(using: .utf8)!

        let content = try JSONDecoder().decode(FileContent.self, from: json)
        #expect(content.error == "File too large")
        #expect(content.size == 2097152)
    }
}
