// forms-reconstruct: photo bundle -> photogrammetry mesh + per-sample camera poses.
//
// Usage: forms-reconstruct --images <dir> --out <dir> [--detail reduced|medium] [--timeout-s N]
//
// Exit codes are the contract with forms_pipeline.reconstruct.handler:
//   0 ok, 2 bad input, 3 reconstruction failed, 4 timeout, 5 unsupported host.
// 2 and 3 mean the same input will never succeed (user must rescan); 4 and 5 are
// worker-side and retriable. Errors go to stderr as one JSON line; paths and image
// content are never printed.

import CoreGraphics
import CoreVideo
import Foundation
import ImageIO
import ModelIO
import RealityKit

enum Exit: Int32 {
    case ok = 0, badInput = 2, failed = 3, timeout = 4, unsupported = 5
}

// RealityKit/USD print diagnostics containing system temp paths to stderr; only
// the CLI's own one-line error may reach the caller, so the framework's stderr goes
// to /dev/null and die() writes to the saved original descriptor.
let errFD = dup(STDERR_FILENO)
freopen("/dev/null", "w", stderr)

func die(_ code: Exit, _ kind: String, _ reason: String) -> Never {
    let line = (try? JSONSerialization.data(withJSONObject: ["error": kind, "reason": reason]))
        .flatMap { String(data: $0, encoding: .utf8) } ?? "{\"error\":\"\(kind)\"}"
    FileHandle(fileDescriptor: errFD).write((line + "\n").data(using: .utf8)!)
    exit(code.rawValue)
}

// Below this the session cannot register a usable orbit; the pipeline's bundle
// validation enforces its own (higher) floor before the CLI is ever invoked.
let minImages = 10
let maxImageSide = 4096

// MARK: arguments

var imagesDir: URL?
var outDir: URL?
var detail = PhotogrammetrySession.Request.Detail.reduced
var detailName = "reduced"
var timeoutS = 1800.0

var args = CommandLine.arguments.dropFirst().makeIterator()
while let flag = args.next() {
    guard let value = args.next() else { die(.badInput, "bad_args", "missing value for \(flag)") }
    switch flag {
    case "--images": imagesDir = URL(fileURLWithPath: value, isDirectory: true)
    case "--out": outDir = URL(fileURLWithPath: value, isDirectory: true)
    case "--detail":
        switch value {
        case "reduced": detail = .reduced
        case "medium": detail = .medium
        default: die(.badInput, "bad_args", "detail must be reduced or medium")
        }
        detailName = value
    case "--timeout-s":
        guard let t = Double(value), t > 0 else { die(.badInput, "bad_args", "bad timeout") }
        timeoutS = t
    default: die(.badInput, "bad_args", "unknown flag \(flag)")
    }
}
guard let imagesDir, let outDir else { die(.badInput, "bad_args", "--images and --out required") }

guard PhotogrammetrySession.isSupported else {
    die(.unsupported, "unsupported", "PhotogrammetrySession is not supported on this host")
}

// MARK: input images

let namePattern = try! NSRegularExpression(pattern: "^\\d{3}\\.jpg$")
func isSampleName(_ name: String) -> Bool {
    namePattern.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)) != nil
}

guard let listing = try? FileManager.default.contentsOfDirectory(atPath: imagesDir.path) else {
    die(.badInput, "bad_input", "images directory not readable")
}
let names = listing.filter(isSampleName).sorted()
if names.count < minImages {
    die(.badInput, "too_few_images", "\(names.count) images, need at least \(minImages)")
}

// Header check for every file before the session starts, so a garbled image is a
// clean exit 2 instead of a silently skipped sample.
for name in names {
    let url = imagesDir.appendingPathComponent(name)
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
        CGImageSourceGetCount(src) == 1,
        let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
        let w = props[kCGImagePropertyPixelWidth] as? Int,
        let h = props[kCGImagePropertyPixelHeight] as? Int,
        w > 0, h > 0, max(w, h) <= maxImageSide
    else { die(.badInput, "bad_image", "\(name) is not a decodable JPEG within size limits") }
}

func pixelBuffer(_ url: URL) -> CVPixelBuffer? {
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(src, 0, nil)
    else { return nil }
    let w = image.width, h = image.height
    var buffer: CVPixelBuffer?
    let attrs = [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary
    guard CVPixelBufferCreate(nil, w, h, kCVPixelFormatType_32BGRA, attrs, &buffer) == kCVReturnSuccess,
        let buffer
    else { return nil }
    CVPixelBufferLockBaseAddress(buffer, [])
    defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
    guard let ctx = CGContext(
        data: CVPixelBufferGetBaseAddress(buffer), width: w, height: h, bitsPerComponent: 8,
        bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
            | CGBitmapInfo.byteOrder32Little.rawValue)
    else { return nil }
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
    return buffer
}

// Decoded lazily as the session pulls samples, so peak memory is not
// images x width x height x 4 bytes. id is the NNN in NNN.jpg, which is how poses
// are keyed back to the capture's ARKit cameras.
let samples = names.lazy.compactMap { name -> PhotogrammetrySample? in
    guard let buffer = pixelBuffer(imagesDir.appendingPathComponent(name)) else { return nil }
    return PhotogrammetrySample(id: Int(name.prefix(3))!, image: buffer)
}

// MARK: session

let fm = FileManager.default
let modelDir = outDir.appendingPathComponent("model-dir", isDirectory: true)
try? fm.removeItem(at: modelDir)
do {
    try fm.createDirectory(at: modelDir, withIntermediateDirectories: true)
} catch {
    die(.failed, "io", "cannot create output directory")
}

var config = PhotogrammetrySession.Configuration()
config.sampleOrdering = .sequential
config.featureSensitivity = .high

let session: PhotogrammetrySession
do {
    session = try PhotogrammetrySession(input: samples, configuration: config)
} catch {
    die(.failed, "session_init", "\(error.localizedDescription)")
}

let started = Date()
DispatchQueue.global().asyncAfter(deadline: .now() + timeoutS) {
    session.cancel()
    die(.timeout, "timeout", "reconstruction exceeded \(Int(timeoutS))s")
}

do {
    try session.process(requests: [.poses, .modelFile(url: modelDir, detail: detail)])
} catch {
    die(.failed, "process", "\(error.localizedDescription)")
}

var poses: PhotogrammetrySession.Poses?
var modelURL: URL?
do {
    outputs: for try await output in session.outputs {
        switch output {
        case .requestComplete(_, .poses(let p)): poses = p
        case .requestComplete(_, .modelFile(let url)): modelURL = url
        case .requestError(_, let error):
            die(.failed, "request_error", "\(error.localizedDescription)")
        case .processingCancelled: die(.failed, "cancelled", "session cancelled")
        case .processingComplete: break outputs
        default: continue
        }
    }
} catch {
    die(.failed, "session_error", "\(error.localizedDescription)")
}

guard let poses, !poses.posesBySample.isEmpty else { die(.failed, "no_poses", "no registered cameras") }
guard modelURL != nil else { die(.failed, "no_model", "session produced no model") }

// MARK: outputs

// model.obj is geometry only (v + vertex-index f): the pipeline measures shape, and
// trimesh cannot load textured OBJ without Pillow, which is not a dependency.
func writeGeometryOnly(from src: URL, to dst: URL) throws {
    let text = try String(contentsOf: src, encoding: .utf8)
    var out = ""
    out.reserveCapacity(text.utf8.count / 2)
    for line in text.split(whereSeparator: \.isNewline) {
        if line.hasPrefix("v ") {
            out += line + "\n"
        } else if line.hasPrefix("f ") {
            out += "f " + line.dropFirst(2).split(separator: " ")
                .map { $0.split(separator: "/", omittingEmptySubsequences: false)[0] }
                .joined(separator: " ") + "\n"
        }
    }
    try out.write(to: dst, atomically: true, encoding: .utf8)
}

// A directory model URL yields OBJ (+ USDA, MTL, PNG) on macOS 26; USD-only output
// is converted through ModelIO as a fallback.
let objOut = outDir.appendingPathComponent("model.obj")
try? fm.removeItem(at: objOut)
let produced = (fm.enumerator(at: modelDir, includingPropertiesForKeys: nil)?.allObjects as? [URL]) ?? []
var sourceObj = produced.first(where: { $0.pathExtension.lowercased() == "obj" })
if sourceObj == nil,
    let usd = produced.first(where: { ["usdz", "usda", "usdc", "usd"].contains($0.pathExtension.lowercased()) })
{
    let converted = outDir.appendingPathComponent("converted.obj")
    do { try MDLAsset(url: usd).export(to: converted) } catch { die(.failed, "convert", "USD to OBJ export failed") }
    sourceObj = converted
}
guard let sourceObj else { die(.failed, "no_model", "session produced no OBJ or USD model") }
do { try writeGeometryOnly(from: sourceObj, to: objOut) } catch { die(.failed, "io", "cannot write model.obj") }

// Pose.transform.matrix is a simd float4x4; columns are written in order, so the
// flat list is column-major exactly as RealityKit holds it.
var posesJSON: [String: [Double]] = [:]
for (id, pose) in poses.posesBySample {
    let m = pose.transform.matrix
    posesJSON[String(format: "%03d.jpg", id)] = [m.columns.0, m.columns.1, m.columns.2, m.columns.3]
        .flatMap { [Double($0.x), Double($0.y), Double($0.z), Double($0.w)] }
}
let report: [String: Any] = [
    "registered": poses.posesBySample.count,
    "total": names.count,
    "detail": detailName,
    "seconds": Date().timeIntervalSince(started),
]
do {
    try JSONSerialization.data(withJSONObject: posesJSON, options: [.sortedKeys])
        .write(to: outDir.appendingPathComponent("poses.json"))
    try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
        .write(to: outDir.appendingPathComponent("report.json"))
} catch {
    die(.failed, "io", "cannot write poses.json or report.json")
}
exit(Exit.ok.rawValue)
