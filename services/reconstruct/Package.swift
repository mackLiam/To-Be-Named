// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "forms-reconstruct",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "forms-reconstruct", targets: ["forms-reconstruct"]),
        .executable(name: "forms-video", targets: ["forms-video"]),
    ],
    targets: [
        .executableTarget(name: "forms-reconstruct", path: "Sources/forms-reconstruct"),
        .target(name: "VideoCore", path: "Sources/VideoCore"),
        .executableTarget(name: "forms-video", dependencies: ["VideoCore"], path: "Sources/forms-video"),
        .testTarget(name: "VideoCoreTests", dependencies: ["VideoCore"], path: "Tests/VideoCoreTests"),
    ]
)
