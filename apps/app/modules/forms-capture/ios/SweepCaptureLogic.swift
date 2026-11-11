import CoreGraphics
import Foundation
import simd

/*
 Pure decision logic for the sweep capture spike (docs/SCAN-V3-PLAN.md
 sections 5.2 and 5.3, Phase 0.5): keyframes kept by azimuth spacing instead
 of fixed stations, framing checks per keyframe, coverage credited by the leg
 heights a keyframe shows, the finish thresholds, and the one instruction to
 show. Used by SilhouetteCaptureController when started with mode "sweep".

 Value in, value out, and Foundation, simd and CoreGraphics only, so it
 compiles and is unit tested on macOS (modules/forms-capture/logic-tests).

 Conventions are SilhouetteCaptureLogic's: ARKit world with worldAlignment
 .gravity (+Y up). Azimuths in this file are RELATIVE to the front: camera
 azimuth (PhotoCaptureLogic.azimuth) minus front_azimuth_rad, wrapped to
 (-pi, pi]. Image points are pixels in sensor orientation, u right, v down,
 origin top-left: the capture.json and silhouette.py convention.
*/

/// Tuning constants. All unverified on real legs; tune from device runs.
enum SweepTuning {
  // Keyframes (plan 5.2).
  /// Minimum azimuth between kept keyframes, and the width of a replacement bin.
  static let binWidthRad: Float = 6 * .pi / 180
  /// Phase 0.5 cap; the server accepts at most this many sweep images.
  static let maxKeyframes = 24

  // Finish (plan 5.3).
  static let autoStopMinKeyframes = 12
  static let autoStopMinSpanRad: Float = 120 * .pi / 180
  static let doneMinKeyframes = 8
  static let doneMinSpanRad: Float = 90 * .pi / 180
  /// A side view is within this of 90 degrees from the front: without one, OD
  /// is not observed at all (plan 4.4).
  static let sideViewToleranceRad: Float = 20 * .pi / 180
  /// Knee end in frame in at least this many keyframes ...
  static let kneeMinKeyframes = 3
  /// ... falling in at least this many equal parts of the kept arc (plan 5.3,
  /// lessons from the video harness: the knee must be seen across the arc).
  static let kneeArcParts = 3

  // Leg ends, estimated from the aim anchor (mid shin) and the floor.
  /// Ankle joint centre above the floor.
  static let ankleAboveFloorM: Float = 0.08
  /// Anchor to ankle when no floor was found.
  static let defaultAnchorToAnkleM: Float = 0.20
  /// Clamp on the anchor to ankle distance (a child's to a tall adult's half shin).
  static let minAnchorToAnkleM: Float = 0.12
  static let maxAnchorToAnkleM: Float = 0.30
  /// "A little thigh above the knee" (plan 5.3) must also be in frame.
  static let thighMarginM: Float = 0.06

  // Framing.
  /// A point is in frame only this far (fraction of the short image side) from every edge.
  static let frameMarginFraction: Float = 0.03
  /// The too-close rule looks at mask contact with the frame between these
  /// fractions of the ankle to knee axis: below is the foot (toes may leave
  /// the frame freely), above is the knee and thigh (the knee rule covers it).
  static let sideBandLow: Float = 0.15
  static let sideBandHigh: Float = 0.90
  /// A frame edge counts as running along the leg's side when its direction is
  /// within 45 degrees of the projected leg axis.
  static let sideParallelCos: Float = 0.7071
  /// Mask pixels on a side edge needed to call it touching (noise floor).
  static let minSideContactPx = 3

  // Coverage (the ghost leg).
  /// Height bands from the ankle to the knee.
  static let coverageBands = 8
  /// Opacity steps of a band on the ghost leg (0 is the outline only).
  static let ghostSteps = 3

  // Per frame.
  /// Sweeping turns the phone continuously; blur is caught by the sharpness
  /// check, so this only rejects whip pans.
  static let maxAngularSpeedRadPerS: Float = 0.8
  /// Vision runs at most 4 times a second.
  static let checkIntervalS: TimeInterval = 0.25
  /// A framing result older than this no longer drives the instruction.
  static let framingMaxAgeS: TimeInterval = 0.75
}

/// The leg axis: the vertical line through the aim anchor, with the ankle and
/// knee heights estimated from the floor. The anchor sits at mid shin (auto aim
/// takes the midpoint of the knee and ankle joints), so the knee is mirrored
/// from the ankle about it.
struct SweepLegAxis: Equatable {
  let anchor: SIMD3<Float>
  let ankleY: Float
  let kneeY: Float

  init(anchor: SIMD3<Float>, floorY: Float?) {
    self.anchor = anchor
    var below = SweepTuning.defaultAnchorToAnkleM
    if let floorY {
      below = anchor.y - (floorY + SweepTuning.ankleAboveFloorM)
    }
    below = min(max(below, SweepTuning.minAnchorToAnkleM), SweepTuning.maxAnchorToAnkleM)
    ankleY = anchor.y - below
    kneeY = anchor.y + below
  }

  func point(atHeight y: Float) -> SIMD3<Float> { SIMD3(anchor.x, y, anchor.z) }
  var ankle: SIMD3<Float> { point(atHeight: ankleY) }
  var knee: SIMD3<Float> { point(atHeight: kneeY) }
  var kneeTop: SIMD3<Float> { point(atHeight: kneeY + SweepTuning.thighMarginM) }

  /// Centre of height band i (0 at the ankle) of SweepTuning.coverageBands.
  func bandCenter(_ i: Int) -> SIMD3<Float> {
    let t = (Float(i) + 0.5) / Float(SweepTuning.coverageBands)
    return point(atHeight: ankleY + t * (kneeY - ankleY))
  }
}

/// The leg axis projected into one image (mask pixels). Nil: behind the camera.
struct SweepFramePoints: Equatable {
  var ankle: SIMD2<Float>?
  var knee: SIMD2<Float>?
  var kneeTop: SIMD2<Float>?
  var bands: [SIMD2<Float>?]
}

/// Framing verdict for one frame, from its leg mask and the projected axis.
struct SweepFraming: Equatable {
  var legFound: Bool
  /// The knee and a little thigh above it are inside the frame.
  var kneeInFrame: Bool
  var ankleInFrame: Bool
  /// The mask touches the frame along the leg's sides (ankle to knee).
  var tooClose: Bool
  /// Height bands (ankle first) whose axis point is inside the frame.
  var visibleBands: [Bool]

  static let notFound = SweepFraming(
    legFound: false, kneeInFrame: false, ankleInFrame: false, tooClose: false,
    visibleBands: Array(repeating: false, count: SweepTuning.coverageBands))
}

/// Ranks two candidates for the same bin: the knee in frame first (the check
/// that matters, plan 5.3), then the ankle, then sharpness.
struct SweepQuality: Equatable {
  var kneeInFrame: Bool
  var ankleInFrame: Bool
  var sharpness: Float

  func isBetter(than other: SweepQuality) -> Bool {
    if kneeInFrame != other.kneeInFrame { return kneeInFrame }
    if ankleInFrame != other.ankleInFrame { return ankleInFrame }
    return sharpness > other.sharpness
  }
}

struct SweepKeyframe: Equatable {
  /// On-disk slot: images/NNN.jpg, masks/NNN.png, station sweep_NN.
  let slot: Int
  /// Relative to the front, (-pi, pi].
  let azimuth: Float
  let quality: SweepQuality
  let visibleBands: [Bool]
}

enum SweepRejectReason: Equatable {
  /// Within binWidth of a kept keyframe in another bin, or of a better one.
  case nearKept
  case capReached
}

enum SweepDecision: Equatable {
  case add(slot: Int)
  case replace(slot: Int)
  case reject(SweepRejectReason)
}

/// The kept keyframes. Invariant: every pair is at least binWidthRad apart, so
/// a bin (binWidthRad wide) never holds two.
struct SweepSelection: Equatable {
  private(set) var keyframes: [SweepKeyframe] = []

  var count: Int { keyframes.count }

  static func bin(forAzimuth azimuth: Float) -> Int {
    let count = Int((2 * Float.pi / SweepTuning.binWidthRad).rounded())
    let a = PhotoCaptureLogic.wrapAngle(azimuth) + .pi
    // The nudge keeps whole-degree boundaries (0 is the front) from falling
    // into the bin below through float rounding.
    return min(count - 1, max(0, Int(a / SweepTuning.binWidthRad + 1e-4)))
  }

  private func conflicts(_ azimuth: Float) -> [SweepKeyframe] {
    keyframes.filter { SweepCaptureLogic.angularDistance($0.azimuth, azimuth) < SweepTuning.binWidthRad }
  }

  /// Cheap pre-check before running Vision: false when no quality could win.
  func canPossiblyAccept(azimuth: Float) -> Bool {
    let near = conflicts(azimuth)
    if near.isEmpty { return keyframes.count < SweepTuning.maxKeyframes }
    let bin = Self.bin(forAzimuth: azimuth)
    return near.count == 1 && Self.bin(forAzimuth: near[0].azimuth) == bin
  }

  func decide(azimuth: Float, quality: SweepQuality) -> SweepDecision {
    let near = conflicts(azimuth)
    if near.isEmpty {
      guard keyframes.count < SweepTuning.maxKeyframes, let slot = freeSlot else { return .reject(.capReached) }
      return .add(slot: slot)
    }
    guard near.count == 1, Self.bin(forAzimuth: near[0].azimuth) == Self.bin(forAzimuth: azimuth),
      quality.isBetter(than: near[0].quality)
    else { return .reject(.nearKept) }
    return .replace(slot: near[0].slot)
  }

  /// Applies a decision from decide(azimuth:quality:) made on this same state.
  mutating func apply(_ decision: SweepDecision, azimuth: Float, quality: SweepQuality, visibleBands: [Bool]) {
    let frame: (Int) -> SweepKeyframe = {
      SweepKeyframe(
        slot: $0, azimuth: PhotoCaptureLogic.wrapAngle(azimuth), quality: quality, visibleBands: visibleBands)
    }
    switch decision {
    case let .add(slot):
      keyframes.append(frame(slot))
    case let .replace(slot):
      guard let index = keyframes.firstIndex(where: { $0.slot == slot }) else { return }
      keyframes[index] = frame(slot)
    case .reject:
      break
    }
  }

  /// Lowest unused slot below the cap.
  private var freeSlot: Int? {
    let used = Set(keyframes.map(\.slot))
    return (0..<SweepTuning.maxKeyframes).first { !used.contains($0) }
  }
}

struct SweepProgress: Equatable {
  let keyframes: Int
  /// Smallest arc holding every keyframe azimuth (handles the +-pi wrap).
  let spanRad: Float
  let sideView: Bool
  let kneeKeyframes: Int
  let kneeSpread: Bool
  /// A keyframe within sideViewToleranceRad of +90 / -90 degrees.
  let positiveSideReached: Bool
  let negativeSideReached: Bool

  /// The lower minimum: Done may appear.
  var canFinish: Bool {
    keyframes >= SweepTuning.doneMinKeyframes && spanRad >= SweepTuning.doneMinSpanRad - 1e-4
      && sideView && kneeSpread
  }

  /// Enough: stop on its own.
  var autoStop: Bool {
    keyframes >= SweepTuning.autoStopMinKeyframes && spanRad >= SweepTuning.autoStopMinSpanRad - 1e-4
      && sideView && kneeSpread
  }

  /// One side is seen and the arc is still short: the other side is what is missing.
  var needsOtherSide: Bool {
    positiveSideReached != negativeSideReached && spanRad < SweepTuning.autoStopMinSpanRad - 1e-4
  }
}

/// One instruction at a time (plan 5.3), declared in priority order. The copy
/// says "the shin" and "the leg", never "your leg", so it reads right for a
/// self-scan and for a helper, and never "left" or "right", which flip between
/// the two.
enum SweepInstruction: Equatable, CaseIterable {
  case tooDark
  case moveSlowly
  case pointAtShin
  case moveBack
  case moveBackForKnee
  case moveCloser
  case lowerPhone
  case finished
  case otherSide
  case keepGoing

  var text: String {
    switch self {
    case .tooDark: return "Too dark. Turn on the light"
    case .moveSlowly, .keepGoing: return "Move slowly round the leg"
    case .pointAtShin: return "Point at the shin"
    case .moveBack: return "Move the phone further back"
    case .moveBackForKnee: return "Move the phone further back so the knee fits"
    case .moveCloser: return "Move closer"
    case .lowerPhone: return "Lower the phone to shin height"
    case .finished: return "Got it"
    case .otherSide: return "Now round the other side"
    }
  }
}

struct SweepInstructionInput {
  var tooDark = false
  var trackingNormal = true
  /// Nil until a fresh framing check exists.
  var framing: SweepFraming?
  /// Horizontal camera to leg axis distance.
  var distance: Float?
  /// Optical axis from horizontal (SilhouetteCaptureLogic.pitch), positive looks up.
  var pitch: Float = 0
  var angularSpeed: Float = 0
  var progress: SweepProgress
}

enum SweepCaptureLogic {
  static func angularDistance(_ a: Float, _ b: Float) -> Float {
    abs(PhotoCaptureLogic.wrapAngle(a - b))
  }

  /// capture.json v2 station for a sweep slot; the server accepts ^sweep_\d{2}$.
  static func stationName(slot: Int) -> String { String(format: "sweep_%02d", slot) }

  /// Pixel of a world point. intrinsics is capture.json's [fx, fy, cx, cy] for
  /// the same image; ARKit camera space looks down -Z with +Y up and image v
  /// grows downward. Nil when the point is not in front of the camera.
  static func project(
    _ point: SIMD3<Float>, cameraToWorld: simd_float4x4, intrinsics k: SIMD4<Float>
  ) -> SIMD2<Float>? {
    let local = cameraToWorld.inverse * SIMD4<Float>(point, 1)
    guard local.z < -1e-4 else { return nil }
    let depth = -local.z
    return SIMD2(k.z + k.x * local.x / depth, k.w - k.y * local.y / depth)
  }

  /// The axis points of `axis` in an image of the camera's intrinsics, scaled
  /// by (scaleX, scaleY) into mask pixels.
  static func framePoints(
    axis: SweepLegAxis, cameraToWorld: simd_float4x4, intrinsics: SIMD4<Float>, scaleX: Float = 1,
    scaleY: Float = 1
  ) -> SweepFramePoints {
    let scale = SIMD2<Float>(scaleX, scaleY)
    func pixel(_ p: SIMD3<Float>) -> SIMD2<Float>? {
      project(p, cameraToWorld: cameraToWorld, intrinsics: intrinsics).map { $0 * scale }
    }
    return SweepFramePoints(
      ankle: pixel(axis.ankle), knee: pixel(axis.knee), kneeTop: pixel(axis.kneeTop),
      bands: (0..<SweepTuning.coverageBands).map { pixel(axis.bandCenter($0)) })
  }

  static func inFrame(_ p: SIMD2<Float>?, width: Int, height: Int) -> Bool {
    guard let p else { return false }
    let margin = SweepTuning.frameMarginFraction * Float(min(width, height))
    return p.x >= margin && p.x <= Float(width - 1) - margin && p.y >= margin && p.y <= Float(height - 1) - margin
  }

  /// Framing checks for one frame. mask: nonzero = leg, row-major, width x
  /// height; points in the same pixels. The foot below the ankle may leave the
  /// frame without any verdict changing.
  static func framing(mask: [UInt8], width: Int, height: Int, points: SweepFramePoints) -> SweepFraming {
    guard width > 0, height > 0, mask.count >= width * height, mask.contains(where: { $0 != 0 }) else {
      return .notFound
    }
    let knee = inFrame(points.knee, width: width, height: height)
      && inFrame(points.kneeTop, width: width, height: height)
    return SweepFraming(
      legFound: true,
      kneeInFrame: knee,
      ankleInFrame: inFrame(points.ankle, width: width, height: height),
      tooClose: touchesSides(mask: mask, width: width, height: height, ankle: points.ankle, knee: points.knee),
      visibleBands: points.bands.map { inFrame($0, width: width, height: height) })
  }

  /// Mask pixels on a frame edge that runs along the leg (within 45 degrees of
  /// the projected axis) and sit between sideBandLow and sideBandHigh of the
  /// way from the ankle to the knee. Edges across the axis are the knee and
  /// ankle rules' business; contact below the band is the foot.
  static func touchesSides(
    mask: [UInt8], width: Int, height: Int, ankle: SIMD2<Float>?, knee: SIMD2<Float>?
  ) -> Bool {
    guard let ankle, let knee else { return false }
    let axis = knee - ankle
    let length2 = simd_length_squared(axis)
    guard length2 > 1 else { return false }
    let direction = axis / length2.squareRoot()
    let rowsAlongLeg = abs(direction.x) >= SweepTuning.sideParallelCos
    let columnsAlongLeg = abs(direction.y) >= SweepTuning.sideParallelCos
    var contacts = 0
    func check(_ x: Int, _ y: Int) {
      guard mask[y * width + x] != 0 else { return }
      let t = simd_dot(SIMD2<Float>(Float(x), Float(y)) - ankle, axis) / length2
      if t >= SweepTuning.sideBandLow, t <= SweepTuning.sideBandHigh { contacts += 1 }
    }
    if rowsAlongLeg {
      for x in 0..<width {
        check(x, 0)
        if height > 1 { check(x, height - 1) }
      }
    }
    if columnsAlongLeg {
      for y in 0..<height {
        check(0, y)
        if width > 1 { check(width - 1, y) }
      }
    }
    return contacts >= SweepTuning.minSideContactPx
  }

  /// Per-frame conditions that stop a frame being considered at all. Raw
  /// values are SilhouetteCondition so onSilhouetteStats keeps one key set.
  static func failing(
    trackingNormal: Bool, distance: Float, pitch: Float, angularSpeed: Float
  ) -> [SilhouetteCondition] {
    var failing: [SilhouetteCondition] = []
    if !trackingNormal { failing.append(.tracking) }
    if distance < SilhouetteTuning.minDistanceM || distance > SilhouetteTuning.maxDistanceM {
      failing.append(.distance)
    }
    if abs(pitch) > SilhouetteTuning.maxLevelRad { failing.append(.level) }
    if angularSpeed >= SweepTuning.maxAngularSpeedRadPerS { failing.append(.still) }
    return failing
  }

  /// A framed, sharp frame may become a keyframe: the leg is there, not cut
  /// off along its sides, and shows at least one height band.
  static func isKeepable(_ framing: SweepFraming, sharpness: Float, threshold: Float) -> Bool {
    framing.legFound && !framing.tooClose && framing.visibleBands.contains(true) && sharpness >= threshold
  }

  /// Smallest arc on the circle containing every angle: 2 pi minus the largest
  /// gap between neighbours, so a set straddling +-pi is measured correctly.
  /// Returns the arc's start (the angle after the largest gap) and its length.
  static func arc(_ angles: [Float]) -> (start: Float, span: Float) {
    guard let first = angles.first else { return (0, 0) }
    let sorted = angles.map { a -> Float in
      var x = a.truncatingRemainder(dividingBy: 2 * .pi)
      if x < 0 { x += 2 * .pi }
      return x
    }.sorted()
    guard sorted.count > 1 else { return (PhotoCaptureLogic.wrapAngle(first), 0) }
    var largestGap = sorted[0] + 2 * .pi - sorted[sorted.count - 1]
    var start = sorted[0]
    for i in 1..<sorted.count where sorted[i] - sorted[i - 1] > largestGap {
      largestGap = sorted[i] - sorted[i - 1]
      start = sorted[i]
    }
    return (PhotoCaptureLogic.wrapAngle(start), 2 * .pi - largestGap)
  }

  static func isSideView(_ azimuth: Float) -> Bool {
    abs(abs(PhotoCaptureLogic.wrapAngle(azimuth)) - .pi / 2) <= SweepTuning.sideViewToleranceRad
  }

  static func progress(_ keyframes: [SweepKeyframe]) -> SweepProgress {
    let azimuths = keyframes.map(\.azimuth)
    let (start, span) = arc(azimuths)
    let knee = keyframes.filter(\.quality.kneeInFrame)
    var parts = Set<Int>()
    for frame in knee {
      var offset = PhotoCaptureLogic.wrapAngle(frame.azimuth - start)
      if offset < 0 { offset += 2 * .pi }
      // Every keyframe lies on the arc; past its end is the start frame by rounding.
      if offset > span { offset = offset > (span + 2 * .pi) / 2 ? 0 : span }
      let part = span > 1e-6 ? Int(offset / span * Float(SweepTuning.kneeArcParts)) : 0
      parts.insert(min(SweepTuning.kneeArcParts - 1, max(0, part)))
    }
    return SweepProgress(
      keyframes: keyframes.count,
      spanRad: span,
      sideView: azimuths.contains(where: isSideView),
      kneeKeyframes: knee.count,
      kneeSpread: knee.count >= SweepTuning.kneeMinKeyframes && parts.count >= SweepTuning.kneeArcParts,
      positiveSideReached: azimuths.contains { isSideView($0) && PhotoCaptureLogic.wrapAngle($0) > 0 },
      negativeSideReached: azimuths.contains { isSideView($0) && PhotoCaptureLogic.wrapAngle($0) < 0 })
  }

  /// Keyframes crediting each height band (ankle first).
  static func bandCounts(_ keyframes: [SweepKeyframe]) -> [Int] {
    (0..<SweepTuning.coverageBands).map { band in
      keyframes.filter { band < $0.visibleBands.count && $0.visibleBands[band] }.count
    }
  }

  /// Ghost leg opacity step per band, 0 (outline) to ghostSteps (full at the
  /// auto-stop keyframe count), so a band never seen stays faint.
  static func ghostLevels(_ keyframes: [SweepKeyframe]) -> [Int] {
    let target = SweepTuning.autoStopMinKeyframes
    let steps = SweepTuning.ghostSteps
    return bandCounts(keyframes).map { min(steps, ($0 * steps + target - 1) / target) }
  }

  /// capture.json coverage (advisory, the server recomputes): credited band
  /// views over the auto-stop target in every band, 0...1.
  static func coverage(_ keyframes: [SweepKeyframe]) -> Double {
    let target = SweepTuning.autoStopMinKeyframes
    let credited = bandCounts(keyframes).reduce(0) { $0 + min($1, target) }
    return Double(credited) / Double(target * SweepTuning.coverageBands)
  }

  static func instruction(_ input: SweepInstructionInput) -> SweepInstruction {
    if input.tooDark { return .tooDark }
    if !input.trackingNormal { return .moveSlowly }
    if let framing = input.framing, !framing.legFound { return .pointAtShin }
    let tooNear = input.distance.map { $0 < SilhouetteTuning.minDistanceM } ?? false
    if tooNear || input.framing?.tooClose == true { return .moveBack }
    if input.framing?.kneeInFrame == false { return .moveBackForKnee }
    if input.framing?.ankleInFrame == false { return .moveBack }
    if let distance = input.distance, distance > SilhouetteTuning.maxDistanceM { return .moveCloser }
    if input.pitch < -SilhouetteTuning.maxLevelRad { return .lowerPhone }
    if input.pitch > SilhouetteTuning.maxLevelRad { return .pointAtShin }
    if input.angularSpeed >= SweepTuning.maxAngularSpeedRadPerS { return .moveSlowly }
    if input.progress.autoStop { return .finished }
    if input.progress.needsOtherSide { return .otherSide }
    return .keepGoing
  }

  /// Detail line under the instruction.
  static func countLine(_ progress: SweepProgress) -> String {
    progress.canFinish
      ? "\(progress.keyframes) views. Tap Done or keep going."
      : "\(progress.keyframes) views"
  }
}
