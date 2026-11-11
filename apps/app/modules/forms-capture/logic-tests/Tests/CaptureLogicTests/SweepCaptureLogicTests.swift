import Foundation
import XCTest
import simd

@testable import CaptureLogic

private func deg(_ d: Float) -> Float { d * .pi / 180 }

private func quality(knee: Bool = true, ankle: Bool = true, sharpness: Float = 100) -> SweepQuality {
  SweepQuality(kneeInFrame: knee, ankleInFrame: ankle, sharpness: sharpness)
}

private let allBands = Array(repeating: true, count: SweepTuning.coverageBands)

/// Keyframes at the given azimuths (degrees), knee in frame where `knee` says so.
private func keyframes(_ degrees: [Float], knee: (Int) -> Bool = { _ in true }) -> [SweepKeyframe] {
  degrees.enumerated().map { i, d in
    SweepKeyframe(
      slot: i, azimuth: PhotoCaptureLogic.wrapAngle(deg(d)), quality: quality(knee: knee(i)),
      visibleBands: allBands)
  }
}

/// Camera at `position` looking at `target`, world +Y up (ARKit camera axes:
/// looks down -Z, +Y up).
private func lookAt(from position: SIMD3<Float>, to target: SIMD3<Float>) -> simd_float4x4 {
  let z = simd_normalize(position - target)
  let x = simd_normalize(simd_cross(SIMD3<Float>(0, 1, 0), z))
  let y = simd_cross(z, x)
  return simd_float4x4(
    SIMD4(x, 0), SIMD4(y, 0), SIMD4(z, 0), SIMD4(position, 1))
}

/// Row-major mask, width x height, on where `on(x, y)`.
private func mask(_ width: Int, _ height: Int, _ on: (Int, Int) -> Bool) -> [UInt8] {
  var bytes = [UInt8](repeating: 0, count: width * height)
  for y in 0..<height {
    for x in 0..<width where on(x, y) { bytes[y * width + x] = 255 }
  }
  return bytes
}

/// A vertical leg in a 200 x 100 image: ankle at row 90, knee at row 20.
private func verticalLegPoints(kneeTopY: Float = 12) -> SweepFramePoints {
  SweepFramePoints(
    ankle: SIMD2(100, 90), knee: SIMD2(100, 20), kneeTop: SIMD2(100, kneeTopY),
    bands: (0..<SweepTuning.coverageBands).map { i in
      SIMD2<Float>(100, 90 - (Float(i) + 0.5) / Float(SweepTuning.coverageBands) * 70)
    })
}

final class SweepSelectionTests: XCTestCase {
  func testBinsAreSixDegreesWideFromMinusPi() {
    XCTAssertEqual(SweepSelection.bin(forAzimuth: 0), 30)
    XCTAssertEqual(SweepSelection.bin(forAzimuth: deg(5.9)), 30)
    XCTAssertEqual(SweepSelection.bin(forAzimuth: deg(6.1)), 31)
    XCTAssertEqual(SweepSelection.bin(forAzimuth: deg(-0.1)), 29)
    XCTAssertEqual(SweepSelection.bin(forAzimuth: -.pi + 0.001), 0)
    XCTAssertEqual(SweepSelection.bin(forAzimuth: .pi), 59)
    XCTAssertEqual(SweepSelection.bin(forAzimuth: 2 * .pi + deg(3)), 30, "wraps before binning")
  }

  func testSpacedFramesAreAddedInFreeSlots() {
    var selection = SweepSelection()
    for d: Float in [0, 10, 20] {
      let decision = selection.decide(azimuth: deg(d), quality: quality())
      XCTAssertEqual(decision, .add(slot: selection.count))
      selection.apply(decision, azimuth: deg(d), quality: quality(), visibleBands: allBands)
    }
    XCTAssertEqual(selection.keyframes.map(\.slot), [0, 1, 2])
  }

  func testCloseFrameInAnotherBinIsRejectedEvenIfBetter() {
    var selection = SweepSelection()
    selection.apply(.add(slot: 0), azimuth: deg(5.9), quality: quality(sharpness: 10), visibleBands: allBands)
    XCTAssertEqual(selection.decide(azimuth: deg(6.2), quality: quality(sharpness: 500)), .reject(.nearKept))
    XCTAssertFalse(selection.canPossiblyAccept(azimuth: deg(6.2)))
  }

  func testSharperFrameReplacesWorseInSameBinKeepingItsSlot() {
    var selection = SweepSelection()
    selection.apply(.add(slot: 0), azimuth: deg(1), quality: quality(sharpness: 100), visibleBands: allBands)
    selection.apply(.add(slot: 1), azimuth: deg(20), quality: quality(sharpness: 100), visibleBands: allBands)
    XCTAssertTrue(selection.canPossiblyAccept(azimuth: deg(4)))
    XCTAssertEqual(selection.decide(azimuth: deg(4), quality: quality(sharpness: 90)), .reject(.nearKept))
    XCTAssertEqual(selection.decide(azimuth: deg(4), quality: quality(sharpness: 100)), .reject(.nearKept))
    let decision = selection.decide(azimuth: deg(4), quality: quality(sharpness: 200))
    XCTAssertEqual(decision, .replace(slot: 0))
    selection.apply(decision, azimuth: deg(4), quality: quality(sharpness: 200), visibleBands: allBands)
    XCTAssertEqual(selection.count, 2)
    XCTAssertEqual(selection.keyframes[0].slot, 0)
    XCTAssertEqual(selection.keyframes[0].azimuth, deg(4), accuracy: 1e-6)
    XCTAssertEqual(selection.keyframes[0].quality.sharpness, 200)
  }

  func testKneeInFrameOutranksSharpness() {
    let blurryKnee = quality(knee: true, sharpness: 50)
    let sharpNoKnee = quality(knee: false, sharpness: 900)
    XCTAssertTrue(blurryKnee.isBetter(than: sharpNoKnee))
    XCTAssertFalse(sharpNoKnee.isBetter(than: blurryKnee))
    XCTAssertTrue(quality(ankle: true, sharpness: 1).isBetter(than: quality(ankle: false, sharpness: 9)))

    var selection = SweepSelection()
    selection.apply(.add(slot: 0), azimuth: 0, quality: sharpNoKnee, visibleBands: allBands)
    XCTAssertEqual(selection.decide(azimuth: deg(2), quality: blurryKnee), .replace(slot: 0))
  }

  func testCapOfTwentyFourStillAllowsReplacement() {
    var selection = SweepSelection()
    for i in 0..<SweepTuning.maxKeyframes {
      let a = deg(-88 + Float(i) * 7.5)
      let decision = selection.decide(azimuth: a, quality: quality())
      XCTAssertEqual(decision, .add(slot: i))
      selection.apply(decision, azimuth: a, quality: quality(), visibleBands: allBands)
    }
    XCTAssertEqual(selection.count, 24)
    XCTAssertEqual(selection.decide(azimuth: deg(150), quality: quality()), .reject(.capReached))
    XCTAssertFalse(selection.canPossiblyAccept(azimuth: deg(150)))
    // -87 shares bin 15 with the frame at -88 and is 6.5 degrees from the next one.
    XCTAssertEqual(selection.decide(azimuth: deg(-87), quality: quality(sharpness: 999)), .replace(slot: 0))
  }

  func testInvariantHoldsOverAMessySweep() {
    var selection = SweepSelection()
    var seed: UInt32 = 12345
    for _ in 0..<2000 {
      seed = seed &* 1_664_525 &+ 1_013_904_223
      let a = Float(seed % 36000) / 100 - 180
      seed = seed &* 1_664_525 &+ 1_013_904_223
      let q = quality(knee: seed % 3 != 0, ankle: seed % 5 != 0, sharpness: Float(seed % 1000))
      let decision = selection.decide(azimuth: deg(a), quality: q)
      selection.apply(decision, azimuth: deg(a), quality: q, visibleBands: allBands)
    }
    let frames = selection.keyframes
    XCTAssertLessThanOrEqual(frames.count, SweepTuning.maxKeyframes)
    XCTAssertEqual(Set(frames.map(\.slot)).count, frames.count)
    XCTAssertTrue(frames.allSatisfy { (0..<SweepTuning.maxKeyframes).contains($0.slot) })
    for i in frames.indices {
      for j in frames.indices where j > i {
        XCTAssertGreaterThanOrEqual(
          SweepCaptureLogic.angularDistance(frames[i].azimuth, frames[j].azimuth), SweepTuning.binWidthRad - 1e-5)
      }
    }
  }

  func testStationNamesMatchTheServerPattern() throws {
    let pattern = try NSRegularExpression(pattern: "^sweep_\\d{2}$")
    for slot in 0..<SweepTuning.maxKeyframes {
      let name = SweepCaptureLogic.stationName(slot: slot)
      XCTAssertEqual(pattern.numberOfMatches(in: name, range: NSRange(name.startIndex..., in: name)), 1)
    }
    XCTAssertEqual(SweepCaptureLogic.stationName(slot: 3), "sweep_03")
  }
}

final class SweepProgressTests: XCTestCase {
  func testSpanHandlesThePlusMinusPiWrap() {
    XCTAssertEqual(SweepCaptureLogic.arc([]).span, 0)
    XCTAssertEqual(SweepCaptureLogic.arc([deg(40)]).span, 0)
    XCTAssertEqual(SweepCaptureLogic.arc([deg(-60), deg(60)]).span, deg(120), accuracy: 1e-5)
    let wrapped = SweepCaptureLogic.arc([deg(170), deg(-170), deg(175)])
    XCTAssertEqual(wrapped.span, deg(20), accuracy: 1e-5)
    XCTAssertEqual(wrapped.start, deg(170), accuracy: 1e-5)
    XCTAssertEqual(SweepCaptureLogic.arc([deg(-100), deg(100), deg(0)]).span, deg(200), accuracy: 1e-4)
    let p = SweepCaptureLogic.progress(keyframes([150, 165, 180, -165, -150, -135]))
    XCTAssertEqual(p.spanRad, deg(75), accuracy: 1e-4)
  }

  func testAutoStopNeedsASideView() {
    let front = keyframes(stride(from: Float(-60), through: 60, by: 10).map { $0 })
    var p = SweepCaptureLogic.progress(front)
    XCTAssertEqual(p.keyframes, 13)
    XCTAssertEqual(p.spanRad, deg(120), accuracy: 1e-4)
    XCTAssertFalse(p.sideView)
    XCTAssertFalse(p.autoStop)
    XCTAssertFalse(p.canFinish)

    p = SweepCaptureLogic.progress(keyframes(stride(from: Float(-60), through: 60, by: 10).map { $0 } + [72]))
    XCTAssertTrue(p.sideView)
    XCTAssertTrue(p.positiveSideReached)
    XCTAssertFalse(p.negativeSideReached)
    XCTAssertTrue(p.autoStop)
    XCTAssertTrue(SweepCaptureLogic.isSideView(deg(-109)))
    XCTAssertFalse(SweepCaptureLogic.isSideView(deg(-112)))
    XCTAssertFalse(SweepCaptureLogic.isSideView(deg(68)))
  }

  func testAutoStopNeedsTwelveKeyframesOver120Degrees() {
    // 11 frames over 130 degrees with a side view.
    var p = SweepCaptureLogic.progress(keyframes(stride(from: Float(-40), through: 90, by: 13).map { $0 }))
    XCTAssertEqual(p.keyframes, 11)
    XCTAssertFalse(p.autoStop)
    XCTAssertTrue(p.canFinish)
    // 12 frames over 110 degrees.
    p = SweepCaptureLogic.progress(keyframes((0..<12).map { -20 + Float($0) * 10 }))
    XCTAssertEqual(p.spanRad, deg(110), accuracy: 1e-4)
    XCTAssertFalse(p.autoStop)
  }

  func testDoneAppearsAtEightOver90() {
    let seven = keyframes([0, 15, 30, 45, 60, 75, 90])
    XCTAssertFalse(SweepCaptureLogic.progress(seven).canFinish)
    let eightNarrow = keyframes([10, 20, 30, 40, 50, 60, 70, 80])
    XCTAssertFalse(SweepCaptureLogic.progress(eightNarrow).canFinish, "70 degrees is short of 90")
    let eight = keyframes([-5, 10, 20, 35, 45, 60, 70, 85])
    let p = SweepCaptureLogic.progress(eight)
    XCTAssertTrue(p.canFinish)
    XCTAssertFalse(p.autoStop)
  }

  func testKneeMustBeInFrameAcrossTheArc() {
    let arc = (0..<13).map { -40 + Float($0) * 10 }  // -40 ... 80, side view at 80
    // Knee only in the first third.
    var p = SweepCaptureLogic.progress(keyframes(arc) { $0 < 4 })
    XCTAssertEqual(p.kneeKeyframes, 4)
    XCTAssertFalse(p.kneeSpread)
    XCTAssertFalse(p.autoStop)
    XCTAssertFalse(p.canFinish)
    // Knee in two frames only, one at each end.
    p = SweepCaptureLogic.progress(keyframes(arc) { $0 == 0 || $0 == 12 })
    XCTAssertFalse(p.kneeSpread)
    // One knee frame in each third.
    p = SweepCaptureLogic.progress(keyframes(arc) { [0, 6, 12].contains($0) })
    XCTAssertTrue(p.kneeSpread)
    XCTAssertTrue(p.autoStop)
    // Knee missing from the far end only.
    p = SweepCaptureLogic.progress(keyframes(arc) { $0 < 8 })
    XCTAssertFalse(p.kneeSpread)
  }

  func testKneeSpreadAcrossTheWrap() {
    // Arc 150 ... -150 through 180, knee seen at both ends and in the middle.
    let arc: [Float] = [150, 160, 170, 180, -170, -160, -150]
    let p = SweepCaptureLogic.progress(keyframes(arc) { [0, 3, 6].contains($0) })
    XCTAssertEqual(p.spanRad, deg(60), accuracy: 1e-4)
    XCTAssertTrue(p.kneeSpread)
  }

  func testNeedsOtherSide() {
    var p = SweepCaptureLogic.progress(keyframes([0, 20, 40, 60, 80]))
    XCTAssertTrue(p.needsOtherSide)
    p = SweepCaptureLogic.progress(keyframes([-80, -40, 0, 40, 80]))
    XCTAssertFalse(p.needsOtherSide, "both sides reached")
    p = SweepCaptureLogic.progress(keyframes([0, 20, 40]))
    XCTAssertFalse(p.needsOtherSide, "no side reached yet")
    p = SweepCaptureLogic.progress(keyframes([-40, 0, 40, 85]))
    XCTAssertFalse(p.needsOtherSide, "arc already 125 degrees")
  }
}

final class SweepFramingTests: XCTestCase {
  func testProjectionUsesTheCaptureJsonConvention() {
    let camera = lookAt(from: SIMD3(0, 0, 1), to: SIMD3(0, 0, 0))
    let k = SIMD4<Float>(1000, 1000, 960, 720)
    let center = SweepCaptureLogic.project(SIMD3(0, 0, 0), cameraToWorld: camera, intrinsics: k)
    XCTAssertEqual(center?.x ?? -1, 960, accuracy: 1e-3)
    XCTAssertEqual(center?.y ?? -1, 720, accuracy: 1e-3)
    let right = SweepCaptureLogic.project(SIMD3(0.1, 0, 0), cameraToWorld: camera, intrinsics: k)
    XCTAssertEqual(right?.x ?? -1, 1060, accuracy: 1e-3)
    let up = SweepCaptureLogic.project(SIMD3(0, 0.1, 0), cameraToWorld: camera, intrinsics: k)
    XCTAssertEqual(up?.y ?? -1, 620, accuracy: 1e-3, "world up is image v decreasing")
    XCTAssertNil(SweepCaptureLogic.project(SIMD3(0, 0, 2), cameraToWorld: camera, intrinsics: k))
  }

  func testLegAxisFromFloorAndAnchor() {
    let axis = SweepLegAxis(anchor: SIMD3(0, 0.30, 0), floorY: 0)
    XCTAssertEqual(axis.ankleY, 0.08, accuracy: 1e-5)
    XCTAssertEqual(axis.kneeY, 0.52, accuracy: 1e-5)
    XCTAssertEqual(axis.kneeTop.y, 0.58, accuracy: 1e-5)
    XCTAssertEqual(SweepLegAxis(anchor: SIMD3(0, 0.30, 0), floorY: nil).ankleY, 0.10, accuracy: 1e-5)
    XCTAssertEqual(SweepLegAxis(anchor: SIMD3(0, 0.30, 0), floorY: -2).ankleY, 0.0, accuracy: 1e-5)
    XCTAssertEqual(SweepLegAxis(anchor: SIMD3(0, 0.30, 0), floorY: 0.25).ankleY, 0.18, accuracy: 1e-5)
    XCTAssertLessThan(axis.bandCenter(0).y, axis.bandCenter(SweepTuning.coverageBands - 1).y)
  }

  func testMovingCloserPutsTheKneeOutOfFrame() {
    let axis = SweepLegAxis(anchor: SIMD3(0, 0.30, 0), floorY: 0)
    let k = SIMD4<Float>(1000, 1000, 960, 720)
    let full = mask(1920, 1440) { x, _ in x > 900 && x < 1020 }
    let far = SweepCaptureLogic.framePoints(
      axis: axis, cameraToWorld: lookAt(from: SIMD3(0, 0.30, 0.5), to: axis.anchor), intrinsics: k)
    let farFraming = SweepCaptureLogic.framing(mask: full, width: 1920, height: 1440, points: far)
    XCTAssertTrue(farFraming.kneeInFrame)
    XCTAssertTrue(farFraming.ankleInFrame)
    XCTAssertFalse(farFraming.tooClose)
    XCTAssertEqual(farFraming.visibleBands, allBands)

    let near = SweepCaptureLogic.framePoints(
      axis: axis, cameraToWorld: lookAt(from: SIMD3(0, 0.30, 0.25), to: axis.anchor), intrinsics: k)
    let nearFraming = SweepCaptureLogic.framing(mask: full, width: 1920, height: 1440, points: near)
    XCTAssertFalse(nearFraming.kneeInFrame)
    XCTAssertFalse(nearFraming.ankleInFrame)
    XCTAssertTrue(nearFraming.visibleBands.contains(true))
    XCTAssertTrue(nearFraming.visibleBands.contains(false))

    let scaled = SweepCaptureLogic.framePoints(
      axis: axis, cameraToWorld: lookAt(from: SIMD3(0, 0.30, 0.5), to: axis.anchor), intrinsics: k,
      scaleX: 0.25, scaleY: 0.25)
    XCTAssertEqual(scaled.ankle?.y ?? 0, (far.ankle?.y ?? 0) * 0.25, accuracy: 1e-3)
  }

  func testEmptyMaskIsNotFound() {
    let empty = [UInt8](repeating: 0, count: 200 * 100)
    XCTAssertEqual(SweepCaptureLogic.framing(mask: empty, width: 200, height: 100, points: verticalLegPoints()), .notFound)
    XCTAssertEqual(SweepCaptureLogic.framing(mask: [], width: 200, height: 100, points: verticalLegPoints()), .notFound)
  }

  func testCentredLegIsFine() {
    let leg = mask(200, 100) { x, y in x >= 80 && x < 120 && y >= 10 && y <= 92 }
    let framing = SweepCaptureLogic.framing(mask: leg, width: 200, height: 100, points: verticalLegPoints())
    XCTAssertEqual(
      framing,
      SweepFraming(legFound: true, kneeInFrame: true, ankleInFrame: true, tooClose: false, visibleBands: allBands))
  }

  func testTooCloseWhenTheShinTouchesTheFrameAlongItsSide() {
    let wide = mask(200, 100) { x, _ in x < 130 }
    XCTAssertTrue(SweepCaptureLogic.framing(mask: wide, width: 200, height: 100, points: verticalLegPoints()).tooClose)
    let rightSide = mask(200, 100) { x, y in x > 60 && y > 30 && y < 70 }
    XCTAssertTrue(
      SweepCaptureLogic.framing(mask: rightSide, width: 200, height: 100, points: verticalLegPoints()).tooClose)
  }

  func testToesOffTheFrameDoNotWarn() {
    // Shin centred; the foot runs off the bottom and side edges below the ankle.
    let leg = mask(200, 100) { x, y in (x >= 80 && x < 120 && y >= 10) || (y >= 88 && x >= 80) }
    let framing = SweepCaptureLogic.framing(mask: leg, width: 200, height: 100, points: verticalLegPoints())
    XCTAssertFalse(framing.tooClose)
    XCTAssertTrue(framing.kneeInFrame)
    XCTAssertTrue(framing.ankleInFrame)
    let input = SweepInstructionInput(framing: framing, distance: 0.5, progress: SweepCaptureLogic.progress([]))
    XCTAssertEqual(SweepCaptureLogic.instruction(input), .keepGoing)
  }

  func testThighOffTheTopEdgeIsNotTooClose() {
    // Thigh leaves the top edge above the knee: an edge across the leg, not along it.
    let leg = mask(200, 100) { x, _ in x >= 80 && x < 120 }
    let points = verticalLegPoints()
    XCTAssertFalse(SweepCaptureLogic.framing(mask: leg, width: 200, height: 100, points: points).tooClose)
  }

  func testKneeNeedsALittleThighInFrame() {
    let leg = mask(200, 100) { x, y in x >= 80 && x < 120 && y >= 10 }
    let cut = SweepCaptureLogic.framing(mask: leg, width: 200, height: 100, points: verticalLegPoints(kneeTopY: 1))
    XCTAssertFalse(cut.kneeInFrame, "margin is 3 px on a 100 px side")
    XCTAssertTrue(cut.ankleInFrame)
    var noKnee = verticalLegPoints()
    noKnee.knee = nil
    XCTAssertFalse(SweepCaptureLogic.framing(mask: leg, width: 200, height: 100, points: noKnee).kneeInFrame)
  }

  func testLegAlongImageXUsesRowsAsSides() {
    // Sensor orientation with the phone upright: the leg runs along x.
    let points = SweepFramePoints(
      ankle: SIMD2(30, 50), knee: SIMD2(170, 50), kneeTop: SIMD2(185, 50), bands: [])
    let touching = mask(200, 100) { _, y in y < 70 }
    XCTAssertTrue(SweepCaptureLogic.framing(mask: touching, width: 200, height: 100, points: points).tooClose)
    let clear = mask(200, 100) { x, y in y > 30 && y < 70 && x > 20 }
    XCTAssertFalse(SweepCaptureLogic.framing(mask: clear, width: 200, height: 100, points: points).tooClose)
  }

  func testKeepableNeedsLegSharpnessAndAVisibleBand() {
    let good = SweepFraming(legFound: true, kneeInFrame: false, ankleInFrame: true, tooClose: false, visibleBands: allBands)
    XCTAssertTrue(SweepCaptureLogic.isKeepable(good, sharpness: 50, threshold: 25))
    XCTAssertFalse(SweepCaptureLogic.isKeepable(good, sharpness: 20, threshold: 25))
    var close = good
    close.tooClose = true
    XCTAssertFalse(SweepCaptureLogic.isKeepable(close, sharpness: 50, threshold: 25))
    var blind = good
    blind.visibleBands = Array(repeating: false, count: SweepTuning.coverageBands)
    XCTAssertFalse(SweepCaptureLogic.isKeepable(blind, sharpness: 50, threshold: 25))
    XCTAssertFalse(SweepCaptureLogic.isKeepable(.notFound, sharpness: 50, threshold: 25))
  }

  func testFailingConditions() {
    XCTAssertEqual(SweepCaptureLogic.failing(trackingNormal: true, distance: 0.5, pitch: 0, angularSpeed: 0.3), [])
    XCTAssertEqual(
      SweepCaptureLogic.failing(trackingNormal: false, distance: 0.2, pitch: deg(60), angularSpeed: 2),
      [.tracking, .distance, .level, .still])
    XCTAssertEqual(SweepCaptureLogic.failing(trackingNormal: true, distance: 1.2, pitch: 0, angularSpeed: 0), [.distance])
  }
}

final class SweepCoverageTests: XCTestCase {
  func testKeyframesCreditOnlyTheHeightsTheyShow() {
    let lower = (0..<SweepTuning.coverageBands).map { $0 < 4 }
    let frames = (0..<12).map { i in
      SweepKeyframe(slot: i, azimuth: deg(Float(i) * 10), quality: quality(knee: false), visibleBands: lower)
    }
    XCTAssertEqual(SweepCaptureLogic.bandCounts(frames), [12, 12, 12, 12, 0, 0, 0, 0])
    XCTAssertEqual(SweepCaptureLogic.ghostLevels(frames), [3, 3, 3, 3, 0, 0, 0, 0])
    XCTAssertEqual(SweepCaptureLogic.coverage(frames), 0.5, accuracy: 1e-9)
  }

  func testGhostStepsAndCoverageCap() {
    let one = [SweepKeyframe(slot: 0, azimuth: 0, quality: quality(), visibleBands: allBands)]
    XCTAssertEqual(SweepCaptureLogic.ghostLevels(one), Array(repeating: 1, count: SweepTuning.coverageBands))
    XCTAssertEqual(SweepCaptureLogic.ghostLevels([]), Array(repeating: 0, count: SweepTuning.coverageBands))
    XCTAssertEqual(SweepCaptureLogic.coverage([]), 0)
    let many = keyframes((0..<20).map { Float($0) * 7 })
    XCTAssertEqual(SweepCaptureLogic.coverage(many), 1, accuracy: 1e-9)
    XCTAssertEqual(SweepCaptureLogic.ghostLevels(keyframes((0..<6).map { Float($0) * 7 })).first, 2)
  }

  func testShortBandArraysCountAsNotVisible() {
    let frame = SweepKeyframe(slot: 0, azimuth: 0, quality: quality(), visibleBands: [true])
    XCTAssertEqual(SweepCaptureLogic.bandCounts([frame]), [1, 0, 0, 0, 0, 0, 0, 0])
  }
}

final class SweepInstructionTests: XCTestCase {
  private let badFraming = SweepFraming(
    legFound: true, kneeInFrame: false, ankleInFrame: false, tooClose: true, visibleBands: allBands)

  func testPriorityIsOneInstructionAtATime() {
    let done = SweepCaptureLogic.progress(keyframes((0..<13).map { -40 + Float($0) * 10 }))
    XCTAssertTrue(done.autoStop)
    let oneSide = SweepCaptureLogic.progress(keyframes([0, 20, 40, 60, 80]))
    var input = SweepInstructionInput(
      tooDark: true, trackingNormal: false, framing: .notFound, distance: 0.2, pitch: -deg(60),
      angularSpeed: 2, progress: done)
    var seen: [SweepInstruction] = []
    func step(_ change: (inout SweepInstructionInput) -> Void) {
      seen.append(SweepCaptureLogic.instruction(input))
      change(&input)
    }
    step { $0.tooDark = false }
    step { $0.trackingNormal = true }
    step { $0.framing = self.badFraming }
    step { $0.distance = 0.5 }
    step { $0.framing?.tooClose = false }
    step { $0.framing?.kneeInFrame = true }
    step { $0.framing?.ankleInFrame = true; $0.distance = 1.2 }
    step { $0.distance = 0.5 }
    step { $0.pitch = 0 }
    step { $0.angularSpeed = 0.1 }
    step { $0.progress = oneSide }
    step { $0.progress = SweepCaptureLogic.progress([]) }
    seen.append(SweepCaptureLogic.instruction(input))
    XCTAssertEqual(
      seen,
      [
        .tooDark, .moveSlowly, .pointAtShin, .moveBack, .moveBack, .moveBackForKnee, .moveBack, .moveCloser,
        .lowerPhone, .moveSlowly, .finished, .otherSide, .keepGoing,
      ])
  }

  func testLookingUpSteeplyPointsBackAtTheShin() {
    let input = SweepInstructionInput(pitch: deg(60), progress: SweepCaptureLogic.progress([]))
    XCTAssertEqual(SweepCaptureLogic.instruction(input), .pointAtShin)
  }

  func testNoFramingYetDoesNotWarn() {
    let input = SweepInstructionInput(framing: nil, distance: 0.5, progress: SweepCaptureLogic.progress([]))
    XCTAssertEqual(SweepCaptureLogic.instruction(input), .keepGoing)
  }

  func testCopyIsRelativeToTheLegAndHasNoDashes() throws {
    let lines = SweepInstruction.allCases.map(\.text) + [
      SweepCaptureLogic.countLine(SweepCaptureLogic.progress([])),
      SweepCaptureLogic.countLine(SweepCaptureLogic.progress(keyframes([-5, 10, 20, 35, 45, 60, 70, 85]))),
    ]
    let forbidden = try NSRegularExpression(pattern: "\\b(left|right|your)\\b", options: [.caseInsensitive])
    for line in lines {
      XCTAssertEqual(forbidden.numberOfMatches(in: line, range: NSRange(line.startIndex..., in: line)), 0, line)
      XCTAssertFalse(line.contains("\u{2014}"), line)
      XCTAssertFalse(line.contains("\u{2013}"), line)
      XCTAssertFalse(line.contains("-"), line)
      XCTAssertFalse(line.isEmpty)
    }
    XCTAssertEqual(SweepInstruction.moveBackForKnee.text, "Move the phone further back so the knee fits")
    XCTAssertEqual(SweepInstruction.moveBack.text, "Move the phone further back")
    XCTAssertTrue(SweepInstruction.allCases.map(\.text).contains { $0.contains("the leg") })
  }
}
