// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "RemoteVoiceInput",
    platforms: [.macOS(.v12)],
    products: [
        .executable(name: "RemoteVoiceInput", targets: ["RemoteVoiceInput"]),
    ],
    targets: [
        .executableTarget(
            name: "RemoteVoiceInput",
            path: "Sources/RemoteVoiceInput"
        ),
    ]
)
