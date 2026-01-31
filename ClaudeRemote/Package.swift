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
    targets: [
        .target(
            name: "ClaudeRemote",
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
