// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ClaudeRemote",
    platforms: [
        .iOS(.v17),
        .macOS(.v14)
    ],
    products: [
        .library(name: "ClaudeRemote", targets: ["ClaudeRemote"])
    ],
    dependencies: [
        .package(url: "https://github.com/gonzalezreal/swift-markdown-ui", from: "2.0.2"),
        .package(url: "https://github.com/raspu/Highlightr", from: "2.2.1"),
    ],
    targets: [
        .target(
            name: "ClaudeRemote",
            dependencies: [
                .product(name: "MarkdownUI", package: "swift-markdown-ui"),
                .product(name: "Highlightr", package: "Highlightr"),
            ],
            path: "Sources/ClaudeRemote",
            exclude: ["App/ClaudeRemoteApp.swift"]
        ),
        .testTarget(
            name: "ClaudeRemoteTests",
            dependencies: ["ClaudeRemote"],
            path: "Tests/ClaudeRemoteTests"
        )
    ]
)
