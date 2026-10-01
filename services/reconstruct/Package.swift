// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "forms-reconstruct",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "forms-reconstruct", targets: ["forms-reconstruct"])],
    targets: [.executableTarget(name: "forms-reconstruct", path: "Sources/forms-reconstruct")]
)
