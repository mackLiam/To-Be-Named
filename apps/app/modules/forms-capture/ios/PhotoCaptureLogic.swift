import Accelerate
import CoreGraphics
import CoreVideo
import Foundation
import simd

/*
 Pure decision logic for guided photo capture (PhotoCaptureController).
 No ARKit session state lives here: every function is a value in, value out,
 so the rules can be read (and later unit tested) apart from live frames.

 Geometry conventions: ARKit world with worldAlignment .gravity, so +Y is up
 and the leg axis is the vertical line through the aim anchor. Azimuth is
 atan2(p.z - anchor.z, p.x - anchor.x), the same definition capture.json
 records as front_azimuth_rad (server: reconstruct/bundle.py).
*/

enum PhotoCaptureMode: String {
  case solo
  case helper
}

/// Frame rejection reasons; raw values are the keys of onPhotoCaptureStats.rejected
/// (PhotoRejectReason in src/types.ts). Declared in priority order.
enum PhotoRejectReason: String {
  case trackingLimited
  case tooDark
  case movingTooFast
  case blurry
  case tooClose
  case tooFar
  case offTarget
}

enum OrbitDirection {
  case left
  case right
}

/// Tuning constants. All unverified on real legs; tune from the
/// [capture-stats] Metro log (onPhotoCaptureStats).
enum PhotoTuning {
  // Contract caps (capture.json v1). The server re-validates all of these.
  static let maxPhotos = 120
  static let finishAnywayMinPhotos = 20

  // Requirements per mode.
  static let helperMinCoverage = 0.85
  static let helperMinPhotos = 40
  static let soloMinCoverage = 0.5
  static let soloMinPhotos = 30
  /// A solo zone (front, inner, outer) counts once a covered bucket center is this close.
  static let soloZoneHalfWidthRad: Float = 30 * .pi / 180

  static let bucketCount = 36

  // Frame acceptance.
  /// ARKit ambientIntensity is about 1000 in a well lit room; below this frames are noisy.
  static let minAmbientIntensity: CGFloat = 250
  static let maxAngularSpeedRadPerS: Float = 1.2
  static let maxLinearSpeedMPerS: Float = 0.6
  /// Finite difference baseline for the speed checks.
  static let motionWindowS: TimeInterval = 0.1
  /// Below this baseline the speed estimate is noise; the check passes.
  static let motionMinBaselineS: TimeInterval = 0.05
  static let minDistanceM: Float = 0.20
  static let maxDistanceM: Float = 0.85
  /// The anchor must project inside this central fraction of the image on both axes.
  static let targetCentralFraction: CGFloat = 0.70
  /// A kept frame needs this much orbit or height change since the last kept frame.
  static let minOrbitStepRad: Float = 5 * .pi / 180
  static let minHeightStepM: Float = 0.04

  // Blur: variance of a 3x3 Laplacian on a downscaled luma image (0...255 range).
  static let blurImageWidth = 320
  /// Absolute sharpness floor; a typical sharp 320 px frame scores well above 100.
  static let blurAbsoluteFloor: Float = 25
  /// Relative floor: this fraction of the running median of accepted frames.
  static let blurMedianFraction: Float = 0.5
  static let blurMedianWindow = 30
  static let blurMedianMinSamples = 5

  // Aim.
  /// Shin surface to leg center along the horizontal view direction.
  static let surfaceToAxisM: Float = 0.05
  /// An aim hit farther than this is the floor or a wall, not a leg at arm's length.
  static let maxAimDistanceM: Float = 1.2
  /// Nearest plausible shin distance at the aim tap; closer hits are noise.
  static let minAimDepthM: Float = 0.15
  /// Half angle of the cone around the aim ray that feature points must fall in.
  static let aimConeHalfAngleRad: Float = 4 * .pi / 180
  /// Feature points needed in the cone before their median depth is trusted.
  static let minAimFeaturePoints = 3
  static let anchorLineHeightM: Float = 0.45

  // UI cadence.
  static let guidanceHoldS: TimeInterval = 0.8
  static let statsIntervalS: TimeInterval = 1
  /// Frame evaluation rate cap (ARKit delivers 60 fps; the blur check is per evaluation).
  static let evaluateIntervalS: TimeInterval = 1.0 / 30
}

enum PhotoCaptureLogic {
  static var bucketWidthRad: Float { 2 * .pi / Float(PhotoTuning.bucketCount) }

  /// Wrap to (-pi, pi].
  static func wrapAngle(_ angle: Float) -> Float {
    var a = angle.truncatingRemainder(dividingBy: 2 * .pi)
    if a > .pi { a -= 2 * .pi }
    if a <= -.pi { a += 2 * .pi }
    return a
  }

  static func azimuth(of point: SIMD3<Float>, around axis: SIMD3<Float>) -> Float {
    atan2(point.z - axis.z, point.x - axis.x)
  }

  static func horizontalDistance(_ point: SIMD3<Float>, toAxis axis: SIMD3<Float>) -> Float {
    simd_length(SIMD2<Float>(point.x - axis.x, point.z - axis.z))
  }

  /// Absolute bucket index: bucket i spans [i, i + 1) * bucketWidth of azimuth in [0, 2pi).
  static func bucket(forAzimuth azimuth: Float) -> Int {
    var a = azimuth.truncatingRemainder(dividingBy: 2 * .pi)
    if a < 0 { a += 2 * .pi }
    return min(PhotoTuning.bucketCount - 1, max(0, Int(a / bucketWidthRad)))
  }

  static func bucketCenter(_ index: Int) -> Float {
    (Float(index) + 0.5) * bucketWidthRad
  }

  static func coverage(_ covered: Set<Int>) -> Double {
    Double(covered.count) / Double(PhotoTuning.bucketCount)
  }

  /// Solo zones: front (tap azimuth) and both sides. Which side is inner depends
  /// on the leg, so both are required and neither is named.
  static func soloZones(frontAzimuth: Float) -> [Float] {
    [frontAzimuth, frontAzimuth + .pi / 2, frontAzimuth - .pi / 2]
  }

  static func bucketsInZone(_ zone: Float) -> [Int] {
    (0..<PhotoTuning.bucketCount).filter {
      abs(wrapAngle(bucketCenter($0) - zone)) <= PhotoTuning.soloZoneHalfWidthRad
    }
  }

  static func zoneSatisfied(_ zone: Float, covered: Set<Int>) -> Bool {
    bucketsInZone(zone).contains { covered.contains($0) }
  }

  static func requirementMet(
    mode: PhotoCaptureMode, covered: Set<Int>, frontAzimuth: Float, photoCount: Int
  ) -> Bool {
    switch mode {
    case .helper:
      return photoCount >= PhotoTuning.helperMinPhotos
        && coverage(covered) >= PhotoTuning.helperMinCoverage
    case .solo:
      return photoCount >= PhotoTuning.soloMinPhotos
        && coverage(covered) >= PhotoTuning.soloMinCoverage
        && soloZones(frontAzimuth: frontAzimuth).allSatisfy { zoneSatisfied($0, covered: covered) }
    }
  }

  /// The nearest bucket still needed for the requirement, or nil when coverage
  /// needs nothing more. Solo: missing zones first, then any uncovered bucket.
  static func targetBucket(
    mode: PhotoCaptureMode, covered: Set<Int>, frontAzimuth: Float, currentAzimuth: Float
  ) -> Int? {
    var candidates: [Int] = []
    switch mode {
    case .helper:
      if coverage(covered) < PhotoTuning.helperMinCoverage {
        candidates = (0..<PhotoTuning.bucketCount).filter { !covered.contains($0) }
      }
    case .solo:
      let missingZones = soloZones(frontAzimuth: frontAzimuth).filter {
        !zoneSatisfied($0, covered: covered)
      }
      if !missingZones.isEmpty {
        candidates = missingZones.flatMap(bucketsInZone)
      } else if coverage(covered) < PhotoTuning.soloMinCoverage {
        candidates = (0..<PhotoTuning.bucketCount).filter { !covered.contains($0) }
      }
    }
    return candidates.min {
      abs(wrapAngle(bucketCenter($0) - currentAzimuth)) < abs(wrapAngle(bucketCenter($1) - currentAzimuth))
    }
  }

  /// Which way the person holding the phone moves to raise azimuth. With +Y up,
  /// a camera facing the axis has its right along -d(position)/d(azimuth), so
  /// increasing azimuth is always to the left.
  static func direction(from currentAzimuth: Float, to targetAzimuth: Float) -> OrbitDirection {
    wrapAngle(targetAzimuth - currentAzimuth) > 0 ? .left : .right
  }

  /// Point nearest the ray (perpendicular distance), within maxDistance and in front.
  /// Leg surface point along the aim ray from tracked feature points: the
  /// median depth of points inside a narrow cone around the ray, between
  /// minAimDepthM and maxAimDistanceM. A median over the cone is robust to the
  /// stray near-camera points and false estimated planes that a single
  /// raycast hit picks up on non-LiDAR phones (device run 2026-09-30: the first
  /// raycast hit landed at the camera, so every frame read as "too close").
  static func aimPointFromFeatures(
    _ points: [SIMD3<Float>], origin: SIMD3<Float>, direction: SIMD3<Float>
  ) -> SIMD3<Float>? {
    let d = simd_normalize(direction)
    let cosLimit = cos(PhotoTuning.aimConeHalfAngleRad)
    var depths: [Float] = []
    for p in points {
      let v = p - origin
      let t = simd_dot(v, d)
      guard t >= PhotoTuning.minAimDepthM, t <= PhotoTuning.maxAimDistanceM else { continue }
      if t / simd_length(v) >= cosLimit { depths.append(t) }
    }
    guard depths.count >= PhotoTuning.minAimFeaturePoints else { return nil }
    depths.sort()
    return origin + d * depths[depths.count / 2]
  }

  /// Leg axis point: the shin hit pushed toward the leg center along the
  /// horizontal view direction.
  static func axisPoint(hit: SIMD3<Float>, rayDirection: SIMD3<Float>) -> SIMD3<Float> {
    let flat = SIMD2<Float>(rayDirection.x, rayDirection.z)
    guard simd_length(flat) > 1e-3 else { return hit }
    let n = simd_normalize(flat)
    return hit + PhotoTuning.surfaceToAxisM * SIMD3<Float>(n.x, 0, n.y)
  }

  static func blurThreshold(acceptedVariances: [Float]) -> Float {
    guard acceptedVariances.count >= PhotoTuning.blurMedianMinSamples else {
      return PhotoTuning.blurAbsoluteFloor
    }
    let sorted = acceptedVariances.sorted()
    let median = sorted[sorted.count / 2]
    return max(PhotoTuning.blurAbsoluteFloor, PhotoTuning.blurMedianFraction * median)
  }

  /// Image point inside the central fraction of an image of this size.
  static func isCentered(_ point: CGPoint, imageSize: CGSize) -> Bool {
    let margin = (1 - PhotoTuning.targetCentralFraction) / 2
    return point.x >= imageSize.width * margin && point.x <= imageSize.width * (1 - margin)
      && point.y >= imageSize.height * margin && point.y <= imageSize.height * (1 - margin)
  }

  static func rejectMessage(_ reason: PhotoRejectReason) -> String {
    switch reason {
    case .trackingLimited: return "Move the phone slowly."
    case .tooDark: return "Turn on more light."
    case .movingTooFast: return "Slow down."
    case .blurry: return "Hold steady."
    case .tooClose: return "Move the phone back."
    case .tooFar: return "Bring the phone closer."
    case .offTarget: return "Keep your leg in the middle of the screen."
    }
  }

  static func progressMessage(direction: OrbitDirection?, requirementMet: Bool) -> String {
    switch direction {
    case .left: return "Keep going to your left."
    case .right: return "Keep going to your right."
    case nil: return requirementMet ? "Looking good. Tap Done when you are ready." : "Looking good. Keep going."
    }
  }

  /// Variance of a 3x3 Laplacian over the luma (Y) plane scaled to blurImageWidth.
  /// Nil when the buffer has no readable 8-bit luma plane.
  static func laplacianVariance(_ pixelBuffer: CVPixelBuffer) -> Float? {
    CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
    guard CVPixelBufferGetPlaneCount(pixelBuffer) >= 1,
      let base = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0)
    else { return nil }
    let srcWidth = CVPixelBufferGetWidthOfPlane(pixelBuffer, 0)
    let srcHeight = CVPixelBufferGetHeightOfPlane(pixelBuffer, 0)
    guard srcWidth > 0, srcHeight > 0 else { return nil }
    var src = vImage_Buffer(
      data: base, height: vImagePixelCount(srcHeight), width: vImagePixelCount(srcWidth),
      rowBytes: CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0))

    let width = min(PhotoTuning.blurImageWidth, srcWidth)
    let height = max(3, srcHeight * width / srcWidth)
    let count = width * height
    var small = [UInt8](repeating: 0, count: count)
    var floats = [Float](repeating: 0, count: count)
    var laplacian = [Float](repeating: 0, count: count)
    let kernel: [Float] = [0, 1, 0, 1, -4, 1, 0, 1, 0]

    let ok: Bool = small.withUnsafeMutableBytes { smallPtr in
      var dst = vImage_Buffer(
        data: smallPtr.baseAddress, height: vImagePixelCount(height), width: vImagePixelCount(width),
        rowBytes: width)
      guard vImageScale_Planar8(&src, &dst, nil, vImage_Flags(kvImageNoFlags)) == kvImageNoError else {
        return false
      }
      return true
    }
    guard ok else { return nil }
    vDSP_vfltu8(small, 1, &floats, 1, vDSP_Length(count))

    let convolved: Bool = floats.withUnsafeMutableBytes { inPtr in
      laplacian.withUnsafeMutableBytes { outPtr in
        var input = vImage_Buffer(
          data: inPtr.baseAddress, height: vImagePixelCount(height), width: vImagePixelCount(width),
          rowBytes: width * MemoryLayout<Float>.stride)
        var output = vImage_Buffer(
          data: outPtr.baseAddress, height: vImagePixelCount(height), width: vImagePixelCount(width),
          rowBytes: width * MemoryLayout<Float>.stride)
        return vImageConvolve_PlanarF(
          &input, &output, nil, 0, 0, kernel, 3, 3, 0, vImage_Flags(kvImageEdgeExtend)) == kvImageNoError
      }
    }
    guard convolved else { return nil }
    var mean: Float = 0
    var meanSquare: Float = 0
    vDSP_meanv(laplacian, 1, &mean, vDSP_Length(count))
    vDSP_measqv(laplacian, 1, &meanSquare, vDSP_Length(count))
    return max(0, meanSquare - mean * mean)
  }

  /// Angle of the relative rotation between two camera poses.
  static func rotationAngle(_ a: simd_float4x4, _ b: simd_float4x4) -> Float {
    func rotation(_ m: simd_float4x4) -> simd_float3x3 {
      simd_float3x3(
        SIMD3(m.columns.0.x, m.columns.0.y, m.columns.0.z),
        SIMD3(m.columns.1.x, m.columns.1.y, m.columns.1.z),
        SIMD3(m.columns.2.x, m.columns.2.y, m.columns.2.z))
    }
    let relative = rotation(a).transpose * rotation(b)
    let trace = relative.columns.0.x + relative.columns.1.y + relative.columns.2.z
    return acos(max(-1, min(1, (trace - 1) / 2)))
  }
}

/// One guidance message at a time, each held at least guidanceHoldS so the
/// label does not flicker between reasons on alternate frames.
struct GuidanceGate {
  private(set) var current = ""
  private var shownAt: TimeInterval = -.infinity

  /// Returns the message to display now.
  mutating func offer(_ message: String, now: TimeInterval) -> String {
    if message != current, now - shownAt >= PhotoTuning.guidanceHoldS {
      current = message
      shownAt = now
    }
    return current
  }

  /// Show immediately (response to a tap), restarting the hold.
  mutating func force(_ message: String, now: TimeInterval) -> String {
    current = message
    shownAt = now
    return current
  }
}
