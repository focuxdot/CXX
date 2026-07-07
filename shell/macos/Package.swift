// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "CXXMenuBar",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "CXXMenuBar",
            path: "Sources/CXXMenuBar"
        )
    ]
)
