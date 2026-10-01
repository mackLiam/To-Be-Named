import CoreGraphics
import Foundation
import simd

/*
 Pure decision logic for solo silhouette capture (SilhouetteCaptureController).
 Value in, value out: stations, auto-capture conditions, mask validity, copy.

 Geometry conventions are PhotoCaptureLogic's: ARKit world with
 worldAlignment .gravity (+Y up), azimuth atan2(p.z - anchor.z, p.x - anchor.x)
 of the camera around the vertical axis through the aim anchor, the value
 capture.json records as front_azimuth_rad.
*/

enum SilhouetteLeg: String {
  case left = "L"
  case right = "R"
}

/// capture.json v2 "station" values. Order is capture order and the on-disk
/// index: station i is written as images/00i.jpg and masks/00i.png.
enum SilhouetteStation: String, CaseIterable {
  case front
  case frontInner = "front_inner"
  case inner
  case frontOuter = "front_outer"
  case outer

  var index: Int { Self.allCases.firstIndex(of: self) ?? 0 }

  var spokenName: String {
    switch self {
    case .front: return "front"
    case .frontInner: return "front of the inner side"
    case .inner: return "inner side"
    case .frontOuter: return "front of the outer side"
    case .outer: return "outer side"
    }
  }
}

/// Auto-capture conditions; raw values are the keys of onSilhouetteStats.failures
/// (SilhouetteCondition in src/types.ts).
enum SilhouetteCondition: String {
  case tracking
  case spot
  case distance
  case level
  case still
  case mask
  case blur
}

/// Why a leg mask does or does not qualify a frame.
enum SilhouetteMaskVerdict: Equatable {
  case valid
  /// No foreground instance at (or near) the projected anchor.
  case notFound
  /// The leg touches the left or right edge of the upright image.
  case cutOffSide
  /// The leg spans less than minLegSpanFraction of the upright image height.
  case tooShort
}

/// Which written-image axis world up runs along, and its sign. Images stay in
/// sensor orientation (landscape), so a phone held upright puts the leg along
/// the image x axis; the mask rules are stated for the upright view.
struct ImageUpAxis: Equatable {
  /// True when world up projects mostly onto image x (columns).
  let alongX: Bool
  /// True when up is toward increasing pixel index on that axis.
  let positive: Bool
}

/// Tuning constants. All unverified on real legs; tune from the
/// [silhouette-stats] Metro log (onSilhouetteStats).
enum SilhouetteTuning {
  static let stationCount = 5

  // Floor.
  static let floorTimeoutS: TimeInterval = 6
  /// A horizontal plane counts as the floor only this far below the camera.
  static let floorMinDropM: Float = 0.2

  // Auto-capture conditions (all must hold for holdS).
  static let azimuthToleranceRad: Float = 12 * .pi / 180
  static let minDistanceM: Float = 0.30
  static let maxDistanceM: Float = 0.90
  /// Auto aim: body-pose attempts per second and the joint confidence needed.
  static let autoAimIntervalS: TimeInterval = 0.4
  static let autoAimMinConfidence: Float = 0.5
  /// Seconds without an automatic find before offering the tap.
  static let autoAimFallbackS: TimeInterval = 6
  static let maxAngularSpeedRadPerS: Float = 0.3
  /// Seated users naturally look down at their shin; the server handles angled views, so
  /// only reject steep top-down shots (device run 2026-09-30: 30 degrees blocked capture).
  static let maxLevelRad: Float = 40 * .pi / 180
  static let holdS: TimeInterval = 0.5

  // Mask.
  /// Live mask checks run only this close to the target station's azimuth.
  static let maskCheckNearRad: Float = 25 * .pi / 180
  /// Vision runs at most 4 times a second while near a station.
  static let maskCheckIntervalS: TimeInterval = 0.25
  /// A live verdict older than this no longer counts.
  static let maskVerdictMaxAgeS: TimeInterval = 0.75
  static let minLegSpanFraction: Float = 0.45
  /// Fallback instance choice: overlap with a disc this wide (sensor px) around the anchor.
  static let instanceDiscRadiusPx: CGFloat = 60
  /// The side-edge rule is checked from the floor end of the mask up to the
  /// anchor (mid shin) plus this fraction of the floor-to-anchor height again,
  /// so a thigh running sideways out of frame above the knee at the inner and
  /// outer stations does not fail it. 1.0 reaches about the knee.
  static let sideCheckAboveAnchorFraction: Float = 0.6
  static let maxMaskPngBytes = 1024 * 1024

  // Light.
  /// ARKit ambientIntensity is about 1000 in a well lit room.
  static let lowAmbientIntensity: CGFloat = 400
  /// Consecutive mask failures, with every other condition passing, that read as "too dark".
  static let darkMaskFailStreak = 3
  static let torchLevel: Float = 0.6

  // Help.
  static let troubleAfterS: TimeInterval = 20

  // Cadence.
  static let evaluateIntervalS: TimeInterval = 1.0 / 30
  static let statsIntervalS: TimeInterval = 1
  static let motionWindowS: TimeInterval = 0.1
}

enum SilhouetteCaptureLogic {
  /// Station azimuth relative to the aim (front) azimuth.
  ///
  /// Derivation: the person sits facing the phone, so their right appears on
  /// the camera's left. The medial (inner) side of the LEFT leg faces the
  /// person's right, which is the camera's left; for the RIGHT leg it faces the
  /// camera's right. Seeing a side head-on means moving the camera toward it.
  /// PhotoCaptureLogic.direction: increasing azimuth always moves the camera
  /// to its left. So for the left leg the inner side is at +90 degrees
  /// (+45 for front_inner) and the outer side at -90 (-45); the right leg is
  /// mirrored.
  static func azimuthOffset(_ station: SilhouetteStation, leg: SilhouetteLeg) -> Float {
    let inner: Float = leg == .left ? 1 : -1
    switch station {
    case .front: return 0
    case .frontInner: return inner * .pi / 4
    case .inner: return inner * .pi / 2
    case .frontOuter: return -inner * .pi / 4
    case .outer: return -inner * .pi / 2
    }
  }

  /// The station to capture next: a retake the user picked, else the first
  /// uncaptured one in order (front, then the inner side, then the outer side).
  static func target(captured: Set<SilhouetteStation>, selected: SilhouetteStation?) -> SilhouetteStation? {
    if let selected, !captured.contains(selected) { return selected }
    return SilhouetteStation.allCases.first { !captured.contains($0) }
  }

  /// Median of the nearest group of depths: the first depth that has at least
  /// `minCount` depths (itself included) within `window` meters behind it.
  /// Points on the leg's front surface sit nearest the camera; stray points
  /// on the back of the calf or beyond come later and are ignored.
  static func nearestDepthCluster(_ depths: [Float], window: Float = 0.04, minCount: Int = 3) -> Float? {
    let sorted = depths.sorted()
    for (i, start) in sorted.enumerated() {
      let group = sorted[i...].prefix { $0 - start <= window }
      if group.count >= minCount { return group[group.startIndex + group.count / 2] }
    }
    return nil
  }

  /// "Finish with 4": the front plus at least one station on each side.
  static func canFinishWithFour(_ captured: Set<SilhouetteStation>) -> Bool {
    captured.count == SilhouetteTuning.stationCount - 1
      && captured.contains(.front)
      && (captured.contains(.frontInner) || captured.contains(.inner))
      && (captured.contains(.frontOuter) || captured.contains(.outer))
  }

  /// Optical axis (camera -Z) angle from horizontal, signed: positive looks up.
  static func pitch(cameraTransform m: simd_float4x4) -> Float {
    let forward = -SIMD3<Float>(m.columns.2.x, m.columns.2.y, m.columns.2.z)
    let length = simd_length(forward)
    guard length > 1e-6 else { return 0 }
    return asin(max(-1, min(1, forward.y / length)))
  }

  /// World up expressed on the written image. ARKit camera axes: +x is image
  /// +x (columns), +y is image -y (rows grow downward), in sensor orientation.
  static func imageUpAxis(cameraTransform m: simd_float4x4) -> ImageUpAxis {
    // Camera-space components of world up are the y components of the camera axes.
    let ux = m.columns.0.y
    let uy = m.columns.1.y
    let imageX = ux
    let imageY = -uy
    if abs(imageX) >= abs(imageY) {
      return ImageUpAxis(alongX: true, positive: imageX > 0)
    }
    return ImageUpAxis(alongX: false, positive: imageY > 0)
  }

  /// Instance label containing the anchor, else the label with the largest
  /// overlap with a disc around it. Labels: 0 is background.
  static func chooseInstance(
    labels: [UInt8], width: Int, height: Int, at point: CGPoint, radius: CGFloat
  ) -> UInt8? {
    let cx = Int(point.x.rounded())
    let cy = Int(point.y.rounded())
    if cx >= 0, cx < width, cy >= 0, cy < height {
      let label = labels[cy * width + cx]
      if label != 0 { return label }
    }
    let r = max(1, Int(radius.rounded()))
    let x0 = max(0, cx - r)
    let x1 = min(width - 1, cx + r)
    let y0 = max(0, cy - r)
    let y1 = min(height - 1, cy + r)
    guard x0 <= x1, y0 <= y1 else { return nil }
    var counts: [UInt8: Int] = [:]
    for y in y0...y1 {
      for x in x0...x1 {
        let dx = x - cx
        let dy = y - cy
        guard dx * dx + dy * dy <= r * r else { continue }
        let label = labels[y * width + x]
        if label != 0 { counts[label, default: 0] += 1 }
      }
    }
    return counts.max { $0.value < $1.value }?.key
  }

  /// Mask rules, in upright terms: something is on, it does not touch the
  /// left or right image edge between the floor end and the band above the
  /// anchor, and it spans at least minLegSpanFraction of the upright height.
  /// mask: nonzero = leg, row-major. anchor: in mask pixel coordinates.
  static func validateMask(
    _ mask: [UInt8], width: Int, height: Int, anchor: CGPoint, up: ImageUpAxis
  ) -> SilhouetteMaskVerdict {
    guard width > 0, height > 0, mask.count >= width * height else { return .notFound }
    let length = up.alongX ? width : height
    var minV = Int.max
    var maxV = Int.min
    for y in 0..<height {
      let row = y * width
      for x in 0..<width where mask[row + x] != 0 {
        let v = up.alongX ? x : y
        if v < minV { minV = v }
        if v > maxV { maxV = v }
      }
    }
    guard minV <= maxV else { return .notFound }

    // Height above the floor end of the mask, along the up axis.
    func heightAboveFloor(_ v: Int) -> Int { up.positive ? v - minV : maxV - v }
    let anchorV = Int((up.alongX ? anchor.x : anchor.y).rounded())
    let anchorHeight = max(0, heightAboveFloor(min(max(anchorV, minV), maxV)))
    let bandTop = Int(Float(anchorHeight) * (1 + SilhouetteTuning.sideCheckAboveAnchorFraction))
    for v in minV...maxV where heightAboveFloor(v) <= bandTop {
      let touches: Bool
      if up.alongX {
        touches = mask[v] != 0 || mask[(height - 1) * width + v] != 0
      } else {
        touches = mask[v * width] != 0 || mask[v * width + width - 1] != 0
      }
      if touches { return .cutOffSide }
    }

    let span = Float(maxV - minV + 1) / Float(length)
    if span < SilhouetteTuning.minLegSpanFraction { return .tooShort }
    return .valid
  }

  static func mostFrequent(_ counts: [SilhouetteCondition: Int]) -> SilhouetteCondition? {
    counts.filter { $0.value > 0 }.max { $0.value < $1.value }?.key
  }

  // MARK: - Copy

  static let floorInstruction = "Point the phone at the floor near your foot for a moment."
  static let setupHint =
    "Sit on a chair, foot flat, shin upright. Shorts on or trousers rolled above the knee. Move the other leg out of the way."
  static let aimInstruction = "Point the phone at your lower leg, foot to knee in view. It finds your shin by itself."
  static let aimTapFallback = "Still looking. Show your foot and knee, or tap your shin to help."
  static let aimFailed = "Could not find your leg. Move a little closer and tap again."
  static let allDone = "All five photos taken. Tap Done."
  static let darkHint = "It's a bit dark here."

  static func maskMessage(_ verdict: SilhouetteMaskVerdict?) -> String {
    switch verdict {
    case .valid: return "Whole leg in view"
    case .notFound: return "Can't see your leg clearly, add light or move the other leg away"
    case .cutOffSide: return "Leg cut off at the side"
    case .tooShort: return "Show from the floor to above the knee"
    case nil: return "Checking"
    }
  }

  static func levelMessage(pitch: Float) -> String {
    pitch < 0 ? "Bring the phone a little lower and level" : "Tilt the phone down a little"
  }

  static func distanceMessage(_ distance: Float) -> String {
    distance < SilhouetteTuning.minDistanceM ? "Move back" : "Move closer"
  }

  /// `direction` is in the camera's frame (PhotoCaptureLogic.direction). In solo
  /// capture the person holds the phone toward their own shin, so the camera
  /// faces them and its left is the person's right; the words are mirrored
  /// (device run 2026-09-30: following "to your left" moved the user away).
  static func spotMessage(_ direction: OrbitDirection) -> String {
    direction == .left ? "Move the phone to your right" : "Move the phone to your left"
  }

  static func title(_ condition: SilhouetteCondition) -> String {
    switch condition {
    case .tracking: return "Tracking"
    case .spot: return "Right spot"
    case .distance: return "Distance"
    case .level: return "Level"
    case .still, .blur: return "Still"
    case .mask: return "Whole leg in view"
    }
  }

  /// The specific fix offered in "Having trouble?".
  static func fix(_ condition: SilhouetteCondition) -> String {
    switch condition {
    case .tracking:
      return "Move the phone slowly and keep some of the floor in view."
    case .spot:
      return "Follow the map: move the phone around your leg until your marker sits on the highlighted dot."
    case .distance:
      return "Hold the phone 30 to 80 cm from your shin, about a forearm and a hand away."
    case .level:
      return "Hold the phone upright at shin height, not tilted down from above."
    case .still, .blur:
      return "Rest your elbow on your knee and hold the phone still for a second."
    case .mask:
      return "Turn on the light, move the other leg out of view, and keep the whole lower leg, from the floor to above the knee, on screen."
    }
  }
}
