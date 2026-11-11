import Foundation
import XCTest

@testable import VideoCore

final class OptionsTests: XCTestCase {
    func testDefaultsAndFlags() throws {
        let o = try parseOptions(["--video", "a.mov", "--out", "b"]).get()
        XCTAssertEqual(o.maxFrames, 60)
        XCTAssertEqual(o.maxSide, 1920)
        XCTAssertTrue(o.model)
        XCTAssertTrue(o.photogrammetry)
        XCTAssertEqual(o.timeoutS, 1800)

        let p = try parseOptions([
            "--no-model", "--video", "a.mov", "--max-frames", "200", "--max-side", "4096",
            "--no-photogrammetry", "--out", "b", "--timeout-s", "12.5",
        ]).get()
        XCTAssertEqual(p.maxFrames, 200)
        XCTAssertEqual(p.maxSide, 4096)
        XCTAssertFalse(p.model)
        XCTAssertFalse(p.photogrammetry)
        XCTAssertEqual(p.timeoutS, 12.5)
    }

    func testRejectsBadArgsWithoutEchoingThem() {
        let secret = "/Users/someone/private.mov"
        let bad: [[String]] = [
            [],
            ["--video", secret],
            ["--video", secret, "--out"],
            ["--video", secret, "--out", "o", secret],
            ["--video", secret, "--out", "o", "--max-frames", "201"],
            ["--video", secret, "--out", "o", "--max-frames", "9"],
            ["--video", secret, "--out", "o", "--max-frames", "x"],
            ["--video", secret, "--out", "o", "--max-side", "5000"],
            ["--video", secret, "--out", "o", "--max-side", "100"],
            ["--video", secret, "--out", "o", "--timeout-s", "0"],
            ["--video", secret, "--out", "o", "--timeout-s", "inf"],
            ["--video", "", "--out", "o"],
        ]
        for argv in bad {
            guard case .failure(let e) = parseOptions(argv) else { return XCTFail("accepted \(argv)") }
            XCTAssertFalse(e.reason.contains("private"))
        }
    }
}

final class ImageTests: XCTestCase {
    func testScaledSize() {
        XCTAssertEqual(scaledSize(width: 720, height: 1280, maxSide: 1920).width, 720)
        let s = scaledSize(width: 2160, height: 3840, maxSide: 1920)
        XCTAssertEqual(s.width, 1080)
        XCTAssertEqual(s.height, 1920)
        let g = scaledSize(width: 720, height: 1280, maxSide: 360)
        XCTAssertEqual(g.height, 360)
        XCTAssertEqual(g.width, 203)
    }

    func testOrientationForTransform() {
        XCTAssertEqual(orientationForTransform(a: 1, b: 0, c: 0, d: 1), 1)
        XCTAssertEqual(orientationForTransform(a: 0, b: 1, c: -1, d: 0), 6)
        XCTAssertEqual(orientationForTransform(a: 0, b: -1, c: 1, d: 0), 8)
        XCTAssertEqual(orientationForTransform(a: -1, b: 0, c: 0, d: -1), 3)
        XCTAssertEqual(orientationForTransform(a: -1, b: 0, c: 0, d: 1), 2)
        XCTAssertEqual(orientationForTransform(a: 1, b: 0, c: 0, d: -1), 4)
        XCTAssertEqual(orientationForTransform(a: 0, b: 1, c: 1, d: 0), 5)
        XCTAssertEqual(orientationForTransform(a: 0, b: -1, c: -1, d: 0), 7)
        XCTAssertEqual(orientationForTransform(a: 0.9999999, b: 0, c: 0, d: 1), 1)
        XCTAssertNil(orientationForTransform(a: 0.7071, b: 0.7071, c: -0.7071, d: 0.7071))
        XCTAssertNil(orientationForTransform(a: 2, b: 0, c: 0, d: 2))
        XCTAssertNil(orientationForTransform(a: 0, b: 0, c: 0, d: 0))
        XCTAssertTrue(orientationSwapsAxes(6))
        XCTAssertFalse(orientationSwapsAxes(3))
    }

    func testGrayDownsampleAveragesAndUsesRowStride() {
        // 4x2 BGRA with 4 bytes of row padding; left half white, right half black.
        let w = 4, h = 2, bpr = 20
        var buf = [UInt8](repeating: 7, count: bpr * h)
        for y in 0..<h {
            for x in 0..<w {
                let v: UInt8 = x < 2 ? 255 : 0
                for c in 0..<3 { buf[y * bpr + 4 * x + c] = v }
                buf[y * bpr + 4 * x + 3] = 255
            }
        }
        let g = buf.withUnsafeBytes { grayDownsample(bgra: $0.baseAddress!, width: w, height: h, bytesPerRow: bpr, maxSide: 2) }
        XCTAssertEqual(g.width, 2)
        XCTAssertEqual(g.height, 1)
        XCTAssertEqual(g.pixels[0], 255, accuracy: 0.01)
        XCTAssertEqual(g.pixels[1], 0, accuracy: 0.01)
    }

    func testLaplacianVariance() {
        XCTAssertEqual(laplacianVariance(GrayImage(width: 10, height: 10, pixels: .init(repeating: 80, count: 100))), 0)
        // A linear ramp has zero Laplacian everywhere.
        let ramp = GrayImage(width: 10, height: 10, pixels: (0..<100).map { Float($0 % 10) * 3 + Float($0 / 10) })
        XCTAssertEqual(laplacianVariance(ramp), 0, accuracy: 1e-6)
        // Checkerboard of 0/1: interior Laplacian is +-4, mean 0, variance 16.
        let check = GrayImage(width: 10, height: 10, pixels: (0..<100).map { Float(($0 % 10 + $0 / 10) % 2) })
        XCTAssertEqual(laplacianVariance(check), 16, accuracy: 1e-6)
        XCTAssertEqual(laplacianVariance(GrayImage(width: 2, height: 2, pixels: [0, 1, 1, 0])), 0)
        XCTAssertGreaterThan(laplacianVariance(texture(64, 64, seed: 3)), laplacianVariance(blur(texture(64, 64, seed: 3))))
    }

    func testEstimateTranslationRecoversShift() {
        let w = 200, h = 360
        let big = texture(w + 80, h + 80, seed: 11)
        func crop(_ ox: Int, _ oy: Int) -> GrayImage {
            var p = [Float](repeating: 0, count: w * h)
            for y in 0..<h { for x in 0..<w { p[y * w + x] = big.pixels[(y + 40 + oy) * big.width + x + 40 + ox] } }
            return GrayImage(width: w, height: h, pixels: p)
        }
        let prev = crop(0, 0)
        // Content moves +dx right, +dy down: cur(x, y) = prev(x - dx, y - dy).
        for (dx, dy) in [(0, 0), (7, -4), (-23, 15), (30, 2)] {
            let cur = crop(-dx, -dy)
            let e = estimateTranslation(prev, cur)
            XCTAssertEqual(e.dx, Double(dx), accuracy: 0.6, "dx for \(dx),\(dy)")
            XCTAssertEqual(e.dy, Double(dy), accuracy: 0.6, "dy for \(dx),\(dy)")
        }
    }

    func testEstimateTranslationFlatAndTinyImages() {
        let flat = GrayImage(width: 50, height: 50, pixels: .init(repeating: 9, count: 2500))
        let e = estimateTranslation(flat, flat)
        XCTAssertEqual(e.dx, 0)
        XCTAssertEqual(e.dy, 0)
        let tiny = GrayImage(width: 2, height: 2, pixels: [1, 2, 3, 4])
        let t = estimateTranslation(tiny, tiny)
        XCTAssertTrue(t.dx.isFinite && t.dy.isFinite)
    }
}

final class SelectionTests: XCTestCase {
    func testWindowCount() {
        XCTAssertEqual(windowCount(decoded: 522, maxFrames: 60), 60)
        XCTAssertEqual(windowCount(decoded: 90, maxFrames: 60), 30)
        XCTAssertEqual(windowCount(decoded: 2, maxFrames: 60), 0)
    }

    func testPicksSharpestPerWindowInTimeOrder() {
        // 30 frames over 1 s -> 10 windows of 3 frames; the middle frame is sharpest.
        let scores = (0..<30).map { i in FrameScore(time: Double(i) / 30, sharpness: i % 3 == 1 ? 10 : 1, motion: 0) }
        XCTAssertEqual(selectFrames(scores, duration: 1, maxFrames: 60), Array(stride(from: 1, to: 30, by: 3)))
        // Capped by maxFrames: 5 windows of 6 frames.
        let five = selectFrames(scores, duration: 1, maxFrames: 5)
        XCTAssertEqual(five.count, 5)
        XCTAssertEqual(five, five.sorted())
    }

    func testTiesGoToLowerMotionThenEarlier() {
        let scores = [
            FrameScore(time: 0.0, sharpness: 5, motion: nil),
            FrameScore(time: 0.1, sharpness: 5, motion: 3),
            FrameScore(time: 0.2, sharpness: 5, motion: 1),
            FrameScore(time: 0.4, sharpness: 5, motion: 2),
            FrameScore(time: 0.5, sharpness: 5, motion: 2),
            FrameScore(time: 0.6, sharpness: 5, motion: 2),
        ]
        XCTAssertEqual(selectFrames(scores, duration: 0.8, maxFrames: 2), [2, 3])
    }

    func testEmptyWindowsAndEdges() {
        // Frames only in the first half: windows over the second half are empty.
        let scores = (0..<12).map { FrameScore(time: Double($0) * 0.04, sharpness: 1, motion: 0) }
        let kept = selectFrames(scores, duration: 1, maxFrames: 4)
        XCTAssertEqual(kept.count, 2)
        // Times at or beyond duration fall into the last window, never out of range.
        let late = (0..<6).map { FrameScore(time: 1 + Double($0), sharpness: Double($0), motion: 0) }
        XCTAssertEqual(selectFrames(late, duration: 1, maxFrames: 2), [5])
        XCTAssertEqual(selectFrames([], duration: 1, maxFrames: 60), [])
        // Unknown duration falls back to the frame times.
        let nodur = (0..<9).map { FrameScore(time: Double($0), sharpness: 1, motion: 0) }
        XCTAssertEqual(selectFrames(nodur, duration: 0, maxFrames: 60).count, 3)
    }
}

final class MaskTests: XCTestCase {
    func testUpscaleThresholdSizeValuesAndShape() {
        // Left column 1, right column 0, upscaled 2x2 -> 8x6.
        let m = upscaleThreshold([1, 0, 1, 0], width: 2, height: 2, toWidth: 8, height: 6)
        XCTAssertEqual(m.count, 48)
        XCTAssertTrue(m.allSatisfy { $0 == 0 || $0 == 255 })
        for y in 0..<6 {
            XCTAssertEqual(Array(m[(y * 8)..<(y * 8 + 8)]), [255, 255, 255, 255, 0, 0, 0, 0])
        }
        XCTAssertEqual(upscaleThreshold([0.49], width: 1, height: 1, toWidth: 3, height: 2), [0, 0, 0, 0, 0, 0])
        XCTAssertEqual(upscaleThreshold([0.5], width: 1, height: 1, toWidth: 2, height: 1), [255, 255])
        // Non-integer ratio still produces exactly the requested size.
        XCTAssertEqual(upscaleThreshold([Float](repeating: 1, count: 7 * 5), width: 7, height: 5, toWidth: 720, height: 1280).count, 720 * 1280)
    }

    func testThresholdAndArea() {
        XCTAssertEqual(threshold([0, 0.2, 0.5, 0.9, 1]), [0, 0, 255, 255, 255])
        XCTAssertEqual(areaFraction([0, 255, 255, 0]), 0.5)
        XCTAssertEqual(areaFraction([]), 0)
    }

    func testChooseInstancesByOverlap() {
        // 4x2 labels: instance 1 on the left, 2 on the right, 3 one pixel on the right.
        let labels: [UInt8] = [1, 1, 2, 2, 1, 1, 2, 3]
        // Person mask (8x4, 2x resolution) covering only the left half.
        var person = [UInt8](repeating: 0, count: 32)
        for y in 0..<4 { for x in 0..<4 { person[y * 8 + x] = 255 } }
        XCTAssertEqual(
            chooseInstances(labels: labels, width: 4, height: 2, person: person, personWidth: 8, personHeight: 4, all: [3, 1, 2]),
            [1])
        // Person covering everything except instance 3's pixel: 1 and 2 both mostly inside.
        var most = [UInt8](repeating: 255, count: 32)
        for y in 2..<4 { for x in 6..<8 { most[y * 8 + x] = 0 } }
        XCTAssertEqual(
            chooseInstances(labels: labels, width: 4, height: 2, person: most, personWidth: 8, personHeight: 4, all: [1, 2, 3]),
            [1, 2])
    }

    func testChooseInstancesFallsBackToAll() {
        let labels: [UInt8] = [1, 2]
        XCTAssertEqual(chooseInstances(labels: labels, width: 2, height: 1, person: nil, personWidth: 0, personHeight: 0, all: [2, 1]), [1, 2])
        XCTAssertEqual(chooseInstances(labels: labels, width: 2, height: 1, person: [0, 0], personWidth: 2, personHeight: 1, all: [1, 2]), [1, 2])
        // Mismatched person buffer is treated as absent.
        XCTAssertEqual(chooseInstances(labels: labels, width: 2, height: 1, person: [255], personWidth: 2, personHeight: 1, all: [1, 2]), [1, 2])
        XCTAssertEqual(chooseInstances(labels: labels, width: 2, height: 1, person: [255, 255], personWidth: 2, personHeight: 1, all: []), [])
    }
}

final class JointTests: XCTestCase {
    func testConvertsVisionToPixelsAndFilters() {
        let obs = [
            RawJoint(key: "right_knee", x: 0.5, y: 0.75, confidence: 0.82),
            RawJoint(key: "left_ankle", x: 0.25, y: 0.0, confidence: 0.1),
            RawJoint(key: "nose", x: 0.5, y: 0.5, confidence: 0.9),
            RawJoint(key: "left_hip", x: .nan, y: 0.5, confidence: 0.9),
        ]
        let j = pickJoints([obs], width: 720, height: 1280)
        XCTAssertEqual(j, ["right_knee": [360, 320, 0.82]])
    }

    func testPicksMostConfidentBody() {
        let a = [RawJoint(key: "left_knee", x: 0.1, y: 0.1, confidence: 0.3)]
        let b = [
            RawJoint(key: "left_knee", x: 0.9, y: 0.9, confidence: 0.2),
            RawJoint(key: "right_knee", x: 0.8, y: 0.9, confidence: 0.2),
        ]
        let j = pickJoints([a, b], width: 100, height: 100)
        XCTAssertEqual(Set(j.keys), ["left_knee", "right_knee"])
        XCTAssertEqual(j["left_knee"]?[0] ?? -1, 90, accuracy: 1e-9)
        XCTAssertEqual(j["left_knee"]?[1] ?? -1, 10, accuracy: 1e-9)
        XCTAssertEqual(pickJoints([], width: 10, height: 10), [:])
    }
}

final class ManifestTests: XCTestCase {
    func sample(pg: Photogrammetry, pose: Pose?) -> Manifest {
        Manifest(
            source: Source(durationS: 17.4, fps: 30, width: 720, height: 1280, framesDecoded: 522),
            tool: Tool(seconds: 95.24, maxFrames: 60),
            photogrammetry: pg,
            frames: [
                Frame(
                    id: 0, timeS: 0.13333, width: 720, height: 1280, sharpness: 152.7, motionPx: nil,
                    person: MaskRef(file: maskFile("person", 0), areaFraction: 0.312345),
                    foreground: nil, joints: ["right_knee": [402.5, 233, 0.82]], pose: pose),
                Frame(
                    id: 1, timeS: 0.5, width: 720, height: 1280, sharpness: 10, motionPx: 4.123,
                    person: nil, foreground: MaskRef(file: maskFile("foreground", 1), areaFraction: 0.28, instances: 2),
                    joints: [:], pose: nil),
            ])
    }

    func decode(_ m: Manifest) throws -> [String: Any] {
        let data = try encodeManifest(m)
        XCTAssertFalse(String(data: data, encoding: .utf8)!.contains("\\/"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testEncodesContractShapeWithExplicitNulls() throws {
        let pose = Pose(transform: (0..<16).map(Double.init), intrinsics: [880, 0, 0, 0, 880, 0, 360, 640, 1])
        let pg = Photogrammetry(status: .ok, error: nil, submitted: 2, registered: 1, points: 10, model: true)
        let j = try decode(sample(pg: pg, pose: pose))
        XCTAssertEqual(Set(j.keys), ["format", "version", "source", "tool", "photogrammetry", "frames"])
        XCTAssertEqual(j["format"] as? String, "forms.video-bundle")
        XCTAssertEqual(j["version"] as? Int, 1)
        let source = try XCTUnwrap(j["source"] as? [String: Any])
        XCTAssertEqual(Set(source.keys), ["duration_s", "fps", "width", "height", "frames_decoded"])
        let tool = try XCTUnwrap(j["tool"] as? [String: Any])
        XCTAssertEqual(tool["name"] as? String, "forms-video")
        XCTAssertEqual(tool["seconds"] as? Double, 95.2)
        let p = try XCTUnwrap(j["photogrammetry"] as? [String: Any])
        XCTAssertEqual(Set(p.keys), ["status", "error", "submitted", "registered", "points", "model", "convention"])
        XCTAssertTrue(p["error"] is NSNull)
        XCTAssertEqual(p["convention"] as? String, "realitykit_pose")

        let frames = try XCTUnwrap(j["frames"] as? [[String: Any]])
        XCTAssertEqual(frames.count, 2)
        let f0 = frames[0]
        XCTAssertEqual(
            Set(f0.keys), ["id", "file", "time_s", "width", "height", "sharpness", "motion_px", "masks", "joints", "pose"])
        XCTAssertEqual(f0["file"] as? String, "frames/000.jpg")
        XCTAssertEqual(f0["time_s"] as? Double, 0.133)
        XCTAssertTrue(f0["motion_px"] is NSNull)
        let masks0 = try XCTUnwrap(f0["masks"] as? [String: Any])
        XCTAssertEqual(Set(masks0.keys), ["person", "foreground"])
        XCTAssertTrue(masks0["foreground"] is NSNull)
        let person = try XCTUnwrap(masks0["person"] as? [String: Any])
        XCTAssertEqual(person["file"] as? String, "masks/person/000.png")
        XCTAssertEqual(person["area_fraction"] as? Double, 0.3123)
        XCTAssertNil(person["instances"])
        let pose0 = try XCTUnwrap(f0["pose"] as? [String: Any])
        XCTAssertEqual((pose0["transform"] as? [Double])?.count, 16)
        XCTAssertEqual((pose0["intrinsics"] as? [Double])?.count, 9)

        let f1 = frames[1]
        XCTAssertTrue(f1["pose"] is NSNull)
        XCTAssertEqual(f1["motion_px"] as? Double, 4.12)
        let masks1 = try XCTUnwrap(f1["masks"] as? [String: Any])
        XCTAssertTrue(masks1["person"] is NSNull)
        let fg = try XCTUnwrap(masks1["foreground"] as? [String: Any])
        XCTAssertEqual(fg["file"] as? String, "masks/foreground/001.png")
        XCTAssertEqual(fg["instances"] as? Int, 2)
        XCTAssertEqual((f1["joints"] as? [String: Any])?.count, 0)
    }

    func testFailedAndSkippedStatus() throws {
        let failed = try decode(sample(pg: .failed(.timeout, submitted: 2), pose: nil))
        let p = try XCTUnwrap(failed["photogrammetry"] as? [String: Any])
        XCTAssertEqual(p["status"] as? String, "failed")
        XCTAssertEqual(p["error"] as? String, "timeout")
        XCTAssertEqual(p["registered"] as? Int, 0)
        XCTAssertEqual(p["model"] as? Bool, false)
        XCTAssertEqual(
            ["no_poses", "session_init", "process", "timeout", "unsupported"],
            [PhotogrammetryError.noPoses, .sessionInit, .process, .timeout, .unsupported].map(\.rawValue))

        let skipped = try decode(sample(pg: .skipped, pose: nil))
        let s = try XCTUnwrap(skipped["photogrammetry"] as? [String: Any])
        XCTAssertEqual(s["status"] as? String, "skipped")
        XCTAssertTrue(s["error"] is NSNull)
        XCTAssertEqual(s["submitted"] as? Int, 0)
    }

    func testPoseRejectsBadShapesAndNonFinite() {
        XCTAssertNil(Pose(transform: [1, 2, 3], intrinsics: nil))
        XCTAssertNil(Pose(transform: [Double](repeating: .nan, count: 16), intrinsics: nil))
        XCTAssertNil(Pose(transform: [Double](repeating: 0, count: 16), intrinsics: [1, 2])?.intrinsics)
        XCTAssertNil(Pose(transform: [Double](repeating: 0, count: 16), intrinsics: [Double](repeating: .infinity, count: 9))?.intrinsics)
    }

    func testFlattenColumnsIsColumnMajor() {
        XCTAssertEqual(flattenColumns([[1, 2, 3], [4, 5, 6], [7, 8, 9]]), [1, 2, 3, 4, 5, 6, 7, 8, 9])
    }

    func testEncodePointsLittleEndianAndCapped() {
        let (data, n) = encodePoints([SIMD3<Float>(1, -2, 0.5), SIMD3<Float>(.nan, 0, 0), SIMD3<Float>(3, 4, 5)])
        XCTAssertEqual(n, 2)
        XCTAssertEqual(data.count, 24)
        let values: [Float] = stride(from: 0, to: data.count, by: 4).map { i in
            Float(bitPattern: UInt32(littleEndian: data[i..<(i + 4)].withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }))
        }
        XCTAssertEqual(values, [1, -2, 0.5, 3, 4, 5])
        let many = (0..<101).map { SIMD3<Float>(Float($0), 0, 0) }
        let capped = encodePoints(many, cap: 10)
        XCTAssertLessThanOrEqual(capped.count, 10)
        XCTAssertEqual(capped.data.count, capped.count * 12)
    }
}

// MARK: helpers

/// Deterministic smooth texture (LCG noise, box blurred twice) for matching tests.
func texture(_ w: Int, _ h: Int, seed: UInt64) -> GrayImage {
    var state = seed
    let noise = (0..<(w * h)).map { _ -> Float in
        state = state &* 6364136223846793005 &+ 1442695040888963407
        return Float(state >> 56)
    }
    return blur(blur(GrayImage(width: w, height: h, pixels: noise)))
}

func blur(_ g: GrayImage) -> GrayImage {
    var out = g.pixels
    for y in 1..<(g.height - 1) {
        for x in 1..<(g.width - 1) {
            var s: Float = 0
            for dy in -1...1 { for dx in -1...1 { s += g.pixels[(y + dy) * g.width + x + dx] } }
            out[y * g.width + x] = s / 9
        }
    }
    return GrayImage(width: g.width, height: g.height, pixels: out)
}
