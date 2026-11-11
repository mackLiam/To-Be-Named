// swift-tools-version:5.9
import PackageDescription

// macOS unit tests for the pure capture logic in ../ios. The sources are
// symlinks to the module's own files, so there is one copy of the code. This
// package sits outside ios/ on purpose: a Package.swift there could confuse
// Expo autolinking and the FormsCapture podspec's source glob.
let package = Package(
  name: "forms-capture-logic-tests",
  platforms: [.macOS(.v14)],
  targets: [
    .target(name: "CaptureLogic", path: "Sources/CaptureLogic"),
    .testTarget(name: "CaptureLogicTests", dependencies: ["CaptureLogic"], path: "Tests/CaptureLogicTests"),
  ]
)
