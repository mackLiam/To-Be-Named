// forms-video: plain video of a leg -> forms.video-bundle v1 (docs/VIDEO-HARNESS.md).
//
// Usage: forms-video --video <file> --out <dir> [--max-frames 60] [--max-side 1920]
//                    [--no-model] [--no-photogrammetry] [--timeout-s 1800]
//
// Exit codes: 0 bundle written (photogrammetry may still have failed; see
// video.json), 2 bad input (bad args, unreadable video, fewer than 10 frames kept),
// 3 cannot write output, 5 unsupported host. Errors go to stderr as one JSON line
// with a fixed reason; paths, image content and framework text are never printed.

import AVFoundation
import CoreImage
import CoreImage.CIFilterBuiltins
import CoreVideo
import Foundation
import ImageIO
import ModelIO
import RealityKit
import UniformTypeIdentifiers
import VideoCore
import Vision

enum Exit: Int32 {
    case ok = 0, badInput = 2, output = 3, unsupported = 5
}

// Vision, RealityKit and USD print diagnostics (some with temp paths) to stderr;
// only the CLI's own one-line error may reach the caller.
let errFD = dup(STDERR_FILENO)
freopen("/dev/null", "w", stderr)

func die(_ code: Exit, _ kind: String, _ reason: String) -> Never {
    let line = (try? JSONSerialization.data(withJSONObject: ["error": kind, "reason": reason]))
        .flatMap { String(data: $0, encoding: .utf8) } ?? "{\"error\":\"\(kind)\"}"
    FileHandle(fileDescriptor: errFD).write((line + "\n").data(using: .utf8)!)
    exit(code.rawValue)
}

let started = Date()
let grayMaxSide = 360
// After a timeout the session is cancelled; if its output stream still has not
// ended after this grace period the bundle is written without it.
let cancelGraceS = 120.0

let opts: Options
switch parseOptions(Array(CommandLine.arguments.dropFirst())) {
case .success(let o): opts = o
case .failure(let e): die(.badInput, "bad_args", e.reason)
}

guard ProcessInfo.processInfo.isOperatingSystemAtLeast(OperatingSystemVersion(majorVersion: 14, minorVersion: 0, patchVersion: 0))
else { die(.unsupported, "unsupported", "macOS 14 or later required") }

let outDir = URL(fileURLWithPath: opts.out, isDirectory: true)
let fm = FileManager.default

// MARK: source

let asset = AVURLAsset(url: URL(fileURLWithPath: opts.video))
guard let track = (try? await asset.loadTracks(withMediaType: .video))?.first else {
    die(.badInput, "bad_video", "no readable video track")
}
guard let (preferred, nominalFPS, timeRange) = try? await track.load(.preferredTransform, .nominalFrameRate, .timeRange)
else { die(.badInput, "bad_video", "video track properties not readable") }
guard let exif = orientationForTransform(
    a: Double(preferred.a), b: Double(preferred.b), c: Double(preferred.c), d: Double(preferred.d)),
    let orientation = CGImagePropertyOrientation(rawValue: exif)
else { die(.badInput, "bad_video", "unsupported track transform") }
let durationS = timeRange.duration.seconds
guard durationS.isFinite, durationS > 0, durationS <= Limits.maxDurationS else {
    die(.badInput, "bad_video", "duration missing or above the cap")
}

func makeReader() -> (AVAssetReader, AVAssetReaderTrackOutput)? {
    guard let reader = try? AVAssetReader(asset: asset) else { return nil }
    let output = AVAssetReaderTrackOutput(
        track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
    output.alwaysCopiesSampleData = false
    guard reader.canAdd(output) else { return nil }
    reader.add(output)
    guard reader.startReading() else { return nil }
    return (reader, output)
}

/// Calls body for every decoded frame with an image, in decode order, one at a
/// time; nothing decoded outlives its call.
func forEachFrame(_ body: (Int, Double, CVPixelBuffer) -> Void) -> Bool {
    guard let (reader, output) = makeReader() else { return false }
    var index = 0
    while let sample = output.copyNextSampleBuffer() {
        autoreleasepool {
            guard let pb = CMSampleBufferGetImageBuffer(sample) else { return }
            let t = (CMSampleBufferGetPresentationTimeStamp(sample) - timeRange.start).seconds
            body(index, t.isFinite ? max(0, t) : 0, pb)
            index += 1
        }
    }
    return reader.status == .completed
}

// MARK: pass 1: score every decoded frame

var scores: [FrameScore] = []
var sourceSize: (width: Int, height: Int)?
var previousGray: GrayImage?
var sizeOK = true
let pass1 = forEachFrame { _, t, pb in
    let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb)
    guard w > 0, h > 0, max(w, h) <= Limits.maxSourceSide else {
        sizeOK = false
        return
    }
    if sourceSize == nil { sourceSize = orientationSwapsAxes(exif) ? (h, w) : (w, h) }
    CVPixelBufferLockBaseAddress(pb, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(pb) else {
        sizeOK = false
        return
    }
    let gray = grayDownsample(
        bgra: base, width: w, height: h, bytesPerRow: CVPixelBufferGetBytesPerRow(pb), maxSide: grayMaxSide)
    var motion: Double?
    if let prev = previousGray, prev.width == gray.width, prev.height == gray.height {
        let (dx, dy) = estimateTranslation(prev, gray)
        let written = scaledSize(width: w, height: h, maxSide: opts.maxSide)
        motion = (dx * dx + dy * dy).squareRoot() * Double(max(written.width, written.height))
            / Double(max(gray.width, gray.height))
    }
    previousGray = gray
    scores.append(FrameScore(time: t, sharpness: laplacianVariance(gray), motion: motion))
}
previousGray = nil
guard pass1, sizeOK, let sourceSize else { die(.badInput, "bad_video", "video could not be decoded") }

let kept = selectFrames(scores, duration: durationS, maxFrames: opts.maxFrames)
guard kept.count >= Limits.minKeptFrames else {
    die(.badInput, "too_few_frames", "\(kept.count) frames kept, need at least \(Limits.minKeptFrames)")
}
let keptIDByIndex = Dictionary(uniqueKeysWithValues: kept.enumerated().map { ($1, $0) })

// MARK: output directory

let framesDir = outDir.appendingPathComponent("frames", isDirectory: true)
let personDir = outDir.appendingPathComponent("masks/person", isDirectory: true)
let foregroundDir = outDir.appendingPathComponent("masks/foreground", isDirectory: true)
let modelDir = outDir.appendingPathComponent("model-dir", isDirectory: true)
let manifestURL = outDir.appendingPathComponent("video.json")
let pointsURL = outDir.appendingPathComponent("points.f32")
let objURL = outDir.appendingPathComponent("model.obj")
do {
    try fm.createDirectory(at: outDir, withIntermediateDirectories: true)
    // video.json goes first and is written last, so its presence means a complete bundle.
    for url in [manifestURL, framesDir, outDir.appendingPathComponent("masks"), modelDir, pointsURL, objURL]
    where fm.fileExists(atPath: url.path) {
        try fm.removeItem(at: url)
    }
    for dir in [framesDir, personDir, foregroundDir] {
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
    }
} catch {
    die(.output, "io", "cannot prepare output directory")
}

// MARK: pass 2: write kept frames, masks and joints

let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
let ciContext = CIContext(options: [.workingColorSpace: srgb, .cacheIntermediates: false])

func render(_ pb: CVPixelBuffer) -> CGImage? {
    var img = CIImage(cvPixelBuffer: pb).oriented(orientation)
    img = img.transformed(by: CGAffineTransform(translationX: -img.extent.origin.x, y: -img.extent.origin.y))
    let w = Int(img.extent.width.rounded()), h = Int(img.extent.height.rounded())
    let (tw, th) = scaledSize(width: w, height: h, maxSide: opts.maxSide)
    if tw != w || th != h {
        let f = CIFilter.lanczosScaleTransform()
        f.inputImage = img
        f.scale = Float(th) / Float(h)
        f.aspectRatio = (Float(tw) / Float(w)) / (Float(th) / Float(h))
        guard let scaled = f.outputImage else { return nil }
        img = scaled
    }
    return ciContext.createCGImage(img, from: CGRect(x: 0, y: 0, width: tw, height: th), format: .RGBA8, colorSpace: srgb)
}

func writeImage(_ img: CGImage, to url: URL, type: UTType, quality: Double?) -> Bool {
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil) else {
        return false
    }
    let props = quality.map { [kCGImageDestinationLossyCompressionQuality: $0] as CFDictionary }
    CGImageDestinationAddImage(dest, img, props)
    return CGImageDestinationFinalize(dest)
}

func writeMask(_ px: [UInt8], width: Int, height: Int, to url: URL) -> Bool {
    guard let provider = CGDataProvider(data: Data(px) as CFData),
        let img = CGImage(
            width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: width,
            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
    else { return false }
    return writeImage(img, to: url, type: .png, quality: nil)
}

/// Single-channel buffer as floats in 0...1 (8-bit values are normalized).
func floats(_ pb: CVPixelBuffer) -> (values: [Float], width: Int, height: Int)? {
    let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb)
    let format = CVPixelBufferGetPixelFormatType(pb)
    guard w > 0, h > 0,
        format == kCVPixelFormatType_OneComponent32Float || format == kCVPixelFormatType_OneComponent8
    else { return nil }
    CVPixelBufferLockBaseAddress(pb, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(pb) else { return nil }
    let bpr = CVPixelBufferGetBytesPerRow(pb)
    var out = [Float](repeating: 0, count: w * h)
    for y in 0..<h {
        let row = base + y * bpr
        for x in 0..<w {
            out[y * w + x] = format == kCVPixelFormatType_OneComponent8
                ? Float(row.load(fromByteOffset: x, as: UInt8.self)) / 255
                : row.load(fromByteOffset: 4 * x, as: Float.self)
        }
    }
    return (out, w, h)
}

func bytes(_ pb: CVPixelBuffer) -> (values: [UInt8], width: Int, height: Int)? {
    let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb)
    guard w > 0, h > 0, CVPixelBufferGetPixelFormatType(pb) == kCVPixelFormatType_OneComponent8 else { return nil }
    CVPixelBufferLockBaseAddress(pb, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(pb) else { return nil }
    let bpr = CVPixelBufferGetBytesPerRow(pb)
    var out = [UInt8](repeating: 0, count: w * h)
    for y in 0..<h {
        let row = (base + y * bpr).assumingMemoryBound(to: UInt8.self)
        for x in 0..<w { out[y * w + x] = row[x] }
    }
    return (out, w, h)
}

/// Mask at exactly width x height, values 0 or 255.
func frameMask(_ pb: CVPixelBuffer, width: Int, height: Int) -> [UInt8]? {
    guard let (v, w, h) = floats(pb) else { return nil }
    return w == width && h == height ? threshold(v) : upscaleThreshold(v, width: w, height: h, toWidth: width, height: height)
}

let jointNames: [(String, VNHumanBodyPoseObservation.JointName)] = [
    ("left_knee", .leftKnee), ("right_knee", .rightKnee), ("left_ankle", .leftAnkle),
    ("right_ankle", .rightAnkle), ("left_hip", .leftHip), ("right_hip", .rightHip),
]

struct VisionResult {
    var person: [UInt8]?
    var foreground: (mask: [UInt8], instances: Int)?
    var joints: [String: [Double]] = [:]
}

/// Each request runs on its own, so one failing leaves the others intact.
func runVision(_ img: CGImage) -> VisionResult {
    let w = img.width, h = img.height
    let handler = VNImageRequestHandler(cgImage: img, orientation: .up, options: [:])
    var r = VisionResult()

    let personReq = VNGeneratePersonSegmentationRequest()
    personReq.qualityLevel = .accurate
    personReq.outputPixelFormat = kCVPixelFormatType_OneComponent32Float
    if (try? handler.perform([personReq])) != nil, let obs = personReq.results?.first {
        r.person = frameMask(obs.pixelBuffer, width: w, height: h)
    }

    let fgReq = VNGenerateForegroundInstanceMaskRequest()
    if (try? handler.perform([fgReq])) != nil {
        if let obs = fgReq.results?.first {
            let all = Array(obs.allInstances)
            var chosen = all
            if let labels = bytes(obs.instanceMask) {
                chosen = chooseInstances(
                    labels: labels.values, width: labels.width, height: labels.height,
                    person: r.person, personWidth: w, personHeight: h, all: all)
            }
            if chosen.isEmpty {
                r.foreground = ([UInt8](repeating: 0, count: w * h), all.count)
            } else if let scaled = try? obs.generateScaledMaskForImage(forInstances: IndexSet(chosen), from: handler),
                let mask = frameMask(scaled, width: w, height: h)
            {
                r.foreground = (mask, all.count)
            }
        } else {
            r.foreground = ([UInt8](repeating: 0, count: w * h), 0)
        }
    }

    let poseReq = VNDetectHumanBodyPoseRequest()
    if (try? handler.perform([poseReq])) != nil {
        let observations = (poseReq.results ?? []).map { obs -> [RawJoint] in
            guard let points = try? obs.recognizedPoints(.all) else { return [] }
            return jointNames.compactMap { key, name in
                points[name].map {
                    RawJoint(key: key, x: Double($0.location.x), y: Double($0.location.y), confidence: Double($0.confidence))
                }
            }
        }
        r.joints = pickJoints(observations, width: w, height: h)
    }
    return r
}

var frames: [Frame] = []
var writeFailed = false
let pass2 = forEachFrame { index, t, pb in
    guard !writeFailed, let id = keptIDByIndex[index] else { return }
    guard let img = render(pb), writeImage(img, to: framesDir.appendingPathComponent(String(format: "%03d.jpg", id)), type: .jpeg, quality: 0.9)
    else {
        writeFailed = true
        return
    }
    let v = runVision(img)
    var person: MaskRef?
    if let m = v.person {
        guard writeMask(m, width: img.width, height: img.height, to: outDir.appendingPathComponent(maskFile("person", id))) else {
            writeFailed = true
            return
        }
        person = MaskRef(file: maskFile("person", id), areaFraction: areaFraction(m))
    }
    var foreground: MaskRef?
    if let (m, n) = v.foreground {
        guard writeMask(m, width: img.width, height: img.height, to: outDir.appendingPathComponent(maskFile("foreground", id))) else {
            writeFailed = true
            return
        }
        foreground = MaskRef(file: maskFile("foreground", id), areaFraction: areaFraction(m), instances: n)
    }
    let s = scores[index]
    frames.append(Frame(
        id: id, timeS: t, width: img.width, height: img.height, sharpness: s.sharpness, motionPx: s.motion,
        person: person, foreground: foreground, joints: v.joints, pose: nil))
}
if writeFailed { die(.output, "io", "cannot write frames or masks") }
guard pass2, frames.count == kept.count else { die(.badInput, "bad_video", "video could not be decoded twice identically") }

// MARK: finish

func writeManifest(_ pg: Photogrammetry, _ frames: [Frame]) -> Never {
    let manifest = Manifest(
        source: Source(
            durationS: durationS, fps: Double(nominalFPS), width: sourceSize.width, height: sourceSize.height,
            framesDecoded: scores.count),
        tool: Tool(seconds: Date().timeIntervalSince(started), maxFrames: opts.maxFrames),
        photogrammetry: pg, frames: frames)
    guard let data = try? encodeManifest(manifest) else { die(.output, "encode", "manifest could not be encoded") }
    guard data.count <= Limits.maxManifestBytes else { die(.output, "encode", "manifest above the size cap") }
    do { try data.write(to: manifestURL, options: .atomic) } catch { die(.output, "io", "cannot write video.json") }
    exit(Exit.ok.rawValue)
}

/// Failed photogrammetry leaves no partial outputs behind.
func finishFailed(_ e: PhotogrammetryError, submitted: Int) -> Never {
    for url in [pointsURL, objURL, modelDir] { try? fm.removeItem(at: url) }
    writeManifest(.failed(e, submitted: submitted), frames)
}

if !opts.photogrammetry {
    writeManifest(.skipped, frames)
}
guard PhotogrammetrySession.isSupported else { finishFailed(.unsupported, submitted: 0) }

// MARK: photogrammetry

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

// Decoded lazily from the written JPEGs as the session pulls them, so the session
// sees exactly the bundle's pixels and peak memory stays at a few frames.
let samples = (0..<frames.count).lazy.compactMap { id -> PhotogrammetrySample? in
    guard let buffer = pixelBuffer(framesDir.appendingPathComponent(String(format: "%03d.jpg", id))) else { return nil }
    return PhotogrammetrySample(id: id, image: buffer)
}

let submitted = frames.count
var config = PhotogrammetrySession.Configuration()
config.sampleOrdering = .sequential
config.featureSensitivity = .high

let session: PhotogrammetrySession
do {
    session = try PhotogrammetrySession(input: samples, configuration: config)
} catch {
    finishFailed(.sessionInit, submitted: 0)
}

// The watchdog runs on the main actor, which the top-level code below also holds:
// it can only run while the main path is suspended awaiting session output, so it
// never interleaves with the synchronous writes after the loop and needs no lock.
var timedOut = false
Task { @MainActor in
    try? await Task.sleep(for: .seconds(opts.timeoutS))
    timedOut = true
    session.cancel()
    try? await Task.sleep(for: .seconds(cancelGraceS))
    finishFailed(.timeout, submitted: submitted)
}

var requests: [PhotogrammetrySession.Request] = [.poses, .pointCloud]
if opts.model {
    do { try fm.createDirectory(at: modelDir, withIntermediateDirectories: true) } catch {
        die(.output, "io", "cannot prepare output directory")
    }
    requests.append(.modelFile(url: modelDir, detail: .reduced))
}
do {
    try session.process(requests: requests)
} catch {
    finishFailed(.process, submitted: submitted)
}

var poses: PhotogrammetrySession.Poses?
var cloud: PhotogrammetrySession.PointCloud?
var modelURL: URL?
var streamFailed = false
do {
    outputs: for try await output in session.outputs {
        switch output {
        case .requestComplete(_, .poses(let p)): poses = p
        case .requestComplete(_, .pointCloud(let c)): cloud = c
        case .requestComplete(_, .modelFile(let url)): modelURL = url
        case .processingCancelled:
            streamFailed = true
            break outputs
        case .processingComplete: break outputs
        default: continue
        }
    }
} catch {
    streamFailed = true
}

if timedOut { finishFailed(.timeout, submitted: submitted) }
if streamFailed { finishFailed(.process, submitted: submitted) }
guard let poses, !poses.posesBySample.isEmpty else { finishFailed(.noPoses, submitted: submitted) }

// model.obj is geometry only (v + vertex-index f), as forms-reconstruct writes it.
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

var modelWritten = false
if modelURL != nil {
    let produced = (fm.enumerator(at: modelDir, includingPropertiesForKeys: nil)?.allObjects as? [URL]) ?? []
    var sourceObj = produced.first(where: { $0.pathExtension.lowercased() == "obj" })
    if sourceObj == nil,
        let usd = produced.first(where: { ["usdz", "usda", "usdc", "usd"].contains($0.pathExtension.lowercased()) })
    {
        let converted = modelDir.appendingPathComponent("converted.obj")
        if (try? MDLAsset(url: usd).export(to: converted)) != nil { sourceObj = converted }
    }
    if let sourceObj, (try? writeGeometryOnly(from: sourceObj, to: objURL)) != nil { modelWritten = true }
}
try? fm.removeItem(at: modelDir)

var pointCount = 0
if let cloud, !cloud.points.isEmpty {
    let (data, n) = encodePoints(cloud.points.map(\.position))
    if n > 0 {
        do { try data.write(to: pointsURL, options: .atomic) } catch { die(.output, "io", "cannot write points.f32") }
        pointCount = n
    }
}

for (id, pose) in poses.posesBySample where id >= 0 && id < frames.count {
    let m = pose.transform.matrix
    let transform = flattenColumns([m.columns.0, m.columns.1, m.columns.2, m.columns.3].map { [$0.x, $0.y, $0.z, $0.w] })
    var intrinsics: [Double]?
    if #available(macOS 26, *), let k = pose.intrinsics {
        intrinsics = flattenColumns([k.columns.0, k.columns.1, k.columns.2].map { [$0.x, $0.y, $0.z] })
    }
    frames[id].pose = Pose(transform: transform, intrinsics: intrinsics)
}

let registered = frames.filter { $0.pose != nil }.count
writeManifest(
    Photogrammetry(
        status: .ok, error: nil, submitted: submitted, registered: registered, points: pointCount,
        model: modelWritten),
    frames)
