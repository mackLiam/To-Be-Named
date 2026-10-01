import ARKit
import AVFoundation
import Accelerate
import CoreImage
import ExpoModulesCore
import ImageIO
import RealityKit
import UIKit
import Vision

/*
 Solo silhouette capture: five still photos at fixed stations across the
 front half of the leg, each with an on-device leg mask and the ARKit pose.
 A continuous sweep around one's own shin is impractical alone (device run
 2026-09-30: coverage 19-44%), so the server reconstructs the shape from
 silhouettes instead. Flow: floor (plane detection, 6 s max), aim (tap, as in
 PhotoCaptureController), then stations front, front_inner, inner,
 front_outer, outer, each auto-captured once every condition holds for
 SilhouetteTuning.holdS. Writes:

   <Application Support>/photo-captures/<sessionId>/capture.json   (v2, method silhouette)
   <Application Support>/photo-captures/<sessionId>/images/NNN.jpg
   <Application Support>/photo-captures/<sessionId>/masks/NNN.png

 Pixel conventions (must match the v1 photo capture; the server relies on them):
   - JPEGs are PhotoCaptureController.encodeAndWrite output: capturedImage in
     sensor orientation (landscape), long side <= 2048, intrinsics scaled to the
     written size per axis (fx, cx by scaleX; fy, cy by scaleY).
   - Masks are computed by Vision on the same pixel buffer with orientation
     .up (no rotation), then resized to EXACTLY the written JPEG size, 8-bit
     grayscale, 0 or 255 (255 = leg).
   - Mask rules (span, side edges) are stated for the upright view; with the
     phone upright the leg runs along image x, so ImageUpAxis maps "height"
     and "left/right edge" onto the sensor image per frame.

 Sensitive data (CLAUDE.md gotcha 5): nothing here logs an image, a mask, a
 pose, or a path; onSilhouetteStats carries scalars only. Files stay in the
 app sandbox, excluded from iCloud backup, deleted on cancel or failure.

 Cannot be unit tested off-device: every input is a live ARFrame. Decision
 rules live in SilhouetteCaptureLogic.swift; constants in SilhouetteTuning.
*/
@MainActor
final class SilhouetteCaptureController: UIViewController, ARSessionDelegate {
  private enum Phase {
    case floor
    case aim
    case stations
  }

  private enum StationOutcome {
    case written(width: Int, height: Int, scaleX: Float, scaleY: Float, joints: [String: Any])
    case rejected(SilhouetteMaskVerdict)
    case retry
    case writeFailed
  }

  private let leg: SilhouetteLeg
  private let onStats: ([String: Any]) -> Void
  private let sessionId = UUID().uuidString
  private let sessionDir: URL
  private let imagesDir: URL
  private let masksDir: URL
  private var promise: Promise?

  private let arView = ARView(frame: .zero, cameraMode: .ar, automaticallyConfigureSession: false)
  private let ciContext = CIContext()
  /// Vision and file writes; serial so a live mask check never races a capture.
  private let workQueue = DispatchQueue(label: "forms.silhouette.work", qos: .userInitiated)
  private let haptic = UINotificationFeedbackGenerator()

  private var phase: Phase = .floor
  private var startedAt: TimeInterval?
  private var floorPlanes: [UUID: Float] = [:]

  // Aim.
  private var anchor: SIMD3<Float>?
  private var frontAzimuth: Float = 0
  private var aimError = false
  private var lineAnchor: AnchorEntity?

  // Stations.
  private var captured: [SilhouetteStation: [String: Any]] = [:]
  private var selected: SilhouetteStation?
  private var capturing = false
  private var acceptedVariances: [Float] = []

  // Per frame.
  private var motionSamples: [(time: TimeInterval, transform: simd_float4x4)] = []
  private var lastEvaluatedAt: TimeInterval = -.infinity
  private var lastStatsAt: TimeInterval = -.infinity
  private var holdStart: TimeInterval?
  private var lastMaskCheckAt: TimeInterval = -.infinity
  private var maskCheckInFlight = false
  private var maskVerdict: SilhouetteMaskVerdict?
  private var maskVerdictAt: TimeInterval = -.infinity
  private var maskFailStreak = 0
  private var blurry = false
  private var lastAzimuthOffset: Float?
  private var lastDistance: Float?
  private var lastPitch: Float?
  private var lastAmbient: CGFloat?
  private var failures: [SilhouetteCondition: Int] = [:]
  private var attemptFailures: [SilhouetteCondition: Int] = [:]
  private var attemptStartedAt: TimeInterval?
  private var troubleShown = false
  private var torchOn = false
  private var guidance = GuidanceGate()

  private var finishRequested = false
  private var finishedEarly = false
  private var finished = false
  private var previousIdleTimerDisabled = false

  // Overlay.
  private let messageLabel = UILabel()
  private let detailLabel = UILabel()
  private let mapView = StationMapView()
  private let reticle = UIView()
  private let flashView = UIView()
  private let checklistPanel = UIStackView()
  private let spotRow = ChecklistRow(title: SilhouetteCaptureLogic.title(.spot))
  private let distanceRow = ChecklistRow(title: SilhouetteCaptureLogic.title(.distance))
  private let levelRow = ChecklistRow(title: SilhouetteCaptureLogic.title(.level))
  private let stillRow = ChecklistRow(title: SilhouetteCaptureLogic.title(.still))
  private let maskRow = ChecklistRow(title: SilhouetteCaptureLogic.title(.mask))
  private let tiltView = TiltView()
  private let cancelButton = UIButton(type: .system)
  private let doneButton = UIButton(type: .system)
  private let torchButton = UIButton(type: .system)
  private let lightPromptButton = UIButton(type: .system)
  private let finishFourButton = UIButton(type: .system)

  init(leg: SilhouetteLeg, onStats: @escaping ([String: Any]) -> Void) {
    self.leg = leg
    self.onStats = onStats
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    sessionDir = support.appendingPathComponent("photo-captures/\(sessionId)", isDirectory: true)
    imagesDir = sessionDir.appendingPathComponent("images", isDirectory: true)
    masksDir = sessionDir.appendingPathComponent("masks", isDirectory: true)
    super.init(nibName: nil, bundle: nil)
    modalPresentationStyle = .fullScreen
    isModalInPresentation = true
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not supported")
  }

  deinit {
    // Off unconditionally: the torch must never outlive the capture.
    _ = Self.setTorch(false)
  }

  // MARK: - Lifecycle

  func start(promise: Promise) {
    self.promise = promise
    do {
      try FileManager.default.createDirectory(at: imagesDir, withIntermediateDirectories: true)
      try FileManager.default.createDirectory(at: masksDir, withIntermediateDirectories: true)
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      var dir = sessionDir
      try dir.setResourceValues(values)
    } catch {
      self.promise = nil
      try? FileManager.default.removeItem(at: sessionDir)
      promise.reject(CaptureWriteFailedException("could not create the session folder"))
      return
    }
    guard let root = PhotoCaptureController.topViewController() else {
      self.promise = nil
      try? FileManager.default.removeItem(at: sessionDir)
      promise.reject(CaptureUnknownException("no view controller available to present capture UI"))
      return
    }
    root.present(self, animated: true)
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    arView.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(arView)
    NSLayoutConstraint.activate([
      arView.topAnchor.constraint(equalTo: view.topAnchor),
      arView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      arView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      arView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
    ])
    arView.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(screenTapped)))
    buildOverlay()
    messageLabel.text = guidance.force(SilhouetteCaptureLogic.floorInstruction, now: 0)
    refreshOverlay()
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    guard !finished else { return }
    previousIdleTimerDisabled = UIApplication.shared.isIdleTimerDisabled
    UIApplication.shared.isIdleTimerDisabled = true
    haptic.prepare()
    let configuration = ARWorldTrackingConfiguration()
    configuration.worldAlignment = .gravity
    configuration.planeDetection = [.horizontal]
    configuration.isLightEstimationEnabled = true
    arView.session.delegate = self
    arView.session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
  }

  /// External cancel (module cancel() or screen unmount).
  func cancel() {
    teardown(deleteFiles: true) { [weak self] in
      self?.settle { $0.reject(CaptureCancelledException()) }
    }
  }

  // MARK: - ARSessionDelegate (delivered on the main queue: delegateQueue is nil)

  nonisolated func session(_ session: ARSession, didUpdate frame: ARFrame) {
    MainActor.assumeIsolated { self.handle(frame) }
  }

  nonisolated func session(_ session: ARSession, didAdd anchors: [ARAnchor]) {
    let planes = Self.horizontalPlanes(anchors)
    MainActor.assumeIsolated { self.notePlanes(planes) }
  }

  nonisolated func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
    let planes = Self.horizontalPlanes(anchors)
    MainActor.assumeIsolated { self.notePlanes(planes) }
  }

  nonisolated func session(_ session: ARSession, didRemove anchors: [ARAnchor]) {
    let ids = anchors.map(\.identifier)
    MainActor.assumeIsolated {
      for id in ids { self.floorPlanes.removeValue(forKey: id) }
    }
  }

  nonisolated func session(_ session: ARSession, didFailWithError error: Error) {
    let denied = (error as? ARError)?.code == .cameraUnauthorized
    let detail = error.localizedDescription
    MainActor.assumeIsolated {
      self.teardown(deleteFiles: true) { [weak self] in
        self?.settle { promise in
          if denied {
            promise.reject(CaptureCameraDeniedException())
          } else {
            promise.reject(CaptureUnknownException("AR session failed: \(detail)"))
          }
        }
      }
    }
  }

  // MARK: - Floor

  private nonisolated static func horizontalPlanes(_ anchors: [ARAnchor]) -> [(UUID, Float)] {
    anchors.compactMap { anchor in
      guard let plane = anchor as? ARPlaneAnchor, plane.alignment == .horizontal else { return nil }
      return (plane.identifier, plane.transform.columns.3.y)
    }
  }

  /// Keeps planes seen below the camera; the lowest is the floor.
  private func notePlanes(_ planes: [(UUID, Float)]) {
    guard !finished, let cameraY = arView.session.currentFrame?.camera.transform.columns.3.y else { return }
    for (id, y) in planes where y < cameraY - SilhouetteTuning.floorMinDropM {
      floorPlanes[id] = y
    }
  }

  private var floorY: Float? { floorPlanes.values.min() }

  // MARK: - Aim

  @objc private func screenTapped() {
    guard phase == .aim, !finished, let frame = arView.session.currentFrame else { return }
    let now = frame.timestamp
    let center = CGPoint(x: arView.bounds.midX, y: arView.bounds.midY)
    guard let ray = arView.ray(through: center) else {
      showAimFailure(now: now)
      return
    }
    var hit: SIMD3<Float>?
    if let points = frame.rawFeaturePoints?.points {
      hit = PhotoCaptureLogic.aimPointFromFeatures(points, origin: ray.origin, direction: ray.direction)
    }
    if hit == nil,
      let query = arView.makeRaycastQuery(from: center, allowing: .estimatedPlane, alignment: .any),
      let result = arView.session.raycast(query).first
    {
      let t = result.worldTransform.columns.3
      let candidate = SIMD3<Float>(t.x, t.y, t.z)
      if simd_distance(candidate, ray.origin) >= PhotoTuning.minAimDepthM { hit = candidate }
    }
    guard let hit, simd_distance(hit, ray.origin) <= PhotoTuning.maxAimDistanceM else {
      showAimFailure(now: now)
      return
    }
    let axis = PhotoCaptureLogic.axisPoint(hit: hit, rayDirection: ray.direction)
    anchor = axis
    frontAzimuth = PhotoCaptureLogic.azimuth(of: PhotoCaptureController.translation(frame.camera.transform), around: axis)
    aimError = false
    phase = .stations
    startAttempt(now: now)
    showAnchorLine(at: axis)
    haptic.notificationOccurred(.success)
    messageLabel.text = guidance.force("Move to the next dot", now: now)
    refreshOverlay()
  }

  private func showAimFailure(now: TimeInterval) {
    aimError = true
    messageLabel.text = guidance.force(SilhouetteCaptureLogic.aimFailed, now: now)
  }

  private func showAnchorLine(at axis: SIMD3<Float>) {
    if let lineAnchor {
      arView.scene.removeAnchor(lineAnchor)
    }
    let line = ModelEntity(
      mesh: .generateBox(size: SIMD3<Float>(0.004, PhotoTuning.anchorLineHeightM, 0.004)),
      materials: [UnlitMaterial(color: .systemGreen)])
    let entityAnchor = AnchorEntity(world: axis)
    entityAnchor.addChild(line)
    arView.scene.addAnchor(entityAnchor)
    lineAnchor = entityAnchor
  }

  // MARK: - Frames

  private func handle(_ frame: ARFrame) {
    guard !finished else { return }
    let now = frame.timestamp
    if startedAt == nil { startedAt = now }
    motionSamples.append((now, frame.camera.transform))
    motionSamples.removeAll { now - $0.time > 3 * SilhouetteTuning.motionWindowS }
    lastAmbient = frame.lightEstimate?.ambientIntensity
    if now - lastStatsAt >= SilhouetteTuning.statsIntervalS {
      lastStatsAt = now
      emitStats()
    }
    guard now - lastEvaluatedAt >= SilhouetteTuning.evaluateIntervalS else { return }
    lastEvaluatedAt = now

    switch phase {
    case .floor:
      if floorY != nil || now - (startedAt ?? now) >= SilhouetteTuning.floorTimeoutS {
        phase = .aim
        refreshOverlay()
      }
      show(
        PhotoCaptureController.trackingMessage(frame.camera.trackingState)
          ?? SilhouetteCaptureLogic.floorInstruction, now: now)
    case .aim:
      show(
        PhotoCaptureController.trackingMessage(frame.camera.trackingState)
          ?? (aimError ? SilhouetteCaptureLogic.aimFailed : SilhouetteCaptureLogic.aimInstruction), now: now)
    case .stations:
      guard !capturing, !finishRequested, presentedViewController == nil else { return }
      evaluate(frame, now: now)
    }
  }

  private func evaluate(_ frame: ARFrame, now: TimeInterval) {
    guard let anchor else { return }
    guard let target = SilhouetteCaptureLogic.target(captured: capturedSet, selected: selected) else {
      holdStart = nil
      show(SilhouetteCaptureLogic.allDone, now: now)
      refreshHint(target: nil)
      return
    }
    let camera = frame.camera
    let transform = camera.transform
    let position = PhotoCaptureController.translation(transform)
    let azimuth = PhotoCaptureLogic.azimuth(of: position, around: anchor)
    let stationAzimuth = frontAzimuth + SilhouetteCaptureLogic.azimuthOffset(target, leg: leg)
    let offset = PhotoCaptureLogic.wrapAngle(azimuth - stationAzimuth)
    let distance = PhotoCaptureLogic.horizontalDistance(position, toAxis: anchor)
    let pitch = SilhouetteCaptureLogic.pitch(cameraTransform: transform)
    lastAzimuthOffset = offset
    lastDistance = distance
    lastPitch = pitch
    mapView.current = CGFloat(azimuth)

    let trackingOK: Bool
    if case .normal = camera.trackingState { trackingOK = true } else { trackingOK = false }
    let spotOK = abs(offset) <= SilhouetteTuning.azimuthToleranceRad
    let distanceOK = distance >= SilhouetteTuning.minDistanceM && distance <= SilhouetteTuning.maxDistanceM
    let levelOK = abs(pitch) <= SilhouetteTuning.maxLevelRad
    let stillOK = angularSpeed(now: now, transform: transform) < SilhouetteTuning.maxAngularSpeedRadPerS
    let othersOK = trackingOK && spotOK && distanceOK && levelOK && stillOK
    let verdict = now - maskVerdictAt <= SilhouetteTuning.maskVerdictMaxAgeS ? maskVerdict : nil
    let maskOK = verdict == .valid

    if trackingOK, !maskCheckInFlight, abs(offset) <= SilhouetteTuning.maskCheckNearRad,
      now - lastMaskCheckAt >= SilhouetteTuning.maskCheckIntervalS
    {
      requestMaskCheck(frame, anchor: anchor, othersOK: othersOK)
    }

    var failing: [SilhouetteCondition] = []
    if !trackingOK { failing.append(.tracking) }
    if !spotOK { failing.append(.spot) }
    if !distanceOK { failing.append(.distance) }
    if !levelOK { failing.append(.level) }
    if !stillOK { failing.append(.still) }
    if !maskOK { failing.append(.mask) }
    for condition in failing {
      failures[condition, default: 0] += 1
      attemptFailures[condition, default: 0] += 1
    }

    let direction = PhotoCaptureLogic.direction(from: azimuth, to: stationAzimuth)
    spotRow.update(ok: spotOK, detail: spotOK ? "On the dot" : SilhouetteCaptureLogic.spotMessage(direction))
    distanceRow.update(
      ok: distanceOK,
      detail: distanceOK ? "\(Int((distance * 100).rounded())) cm" : SilhouetteCaptureLogic.distanceMessage(distance))
    levelRow.update(ok: levelOK, detail: levelOK ? "Level" : SilhouetteCaptureLogic.levelMessage(pitch: pitch))
    tiltView.pitch = CGFloat(pitch)
    let stillDetail = !stillOK ? "Hold still" : (blurry ? "Hold steady a moment" : "Steady")
    stillRow.update(ok: stillOK && !blurry, detail: stillDetail)
    maskRow.update(ok: verdict.map { $0 == .valid }, detail: SilhouetteCaptureLogic.maskMessage(verdict))

    if failing.isEmpty {
      if holdStart == nil { holdStart = now }
      if let holdStart, now - holdStart >= SilhouetteTuning.holdS {
        tryCapture(frame, station: target, anchor: anchor, now: now)
      }
    } else {
      holdStart = nil
      blurry = false
    }

    show(primaryMessage(failing: failing, camera: camera, distance: distance, pitch: pitch, verdict: verdict), now: now)
    refreshHint(target: target)

    if let attemptStartedAt, !troubleShown, now - attemptStartedAt >= SilhouetteTuning.troubleAfterS {
      showTrouble()
    }
  }

  private func primaryMessage(
    failing: [SilhouetteCondition], camera: ARCamera, distance: Float, pitch: Float,
    verdict: SilhouetteMaskVerdict?
  ) -> String {
    switch failing.first {
    case .tracking: return PhotoCaptureController.trackingMessage(camera.trackingState) ?? "Move the phone slowly."
    case .spot: return "Move to the next dot"
    case .distance: return SilhouetteCaptureLogic.distanceMessage(distance)
    case .level: return SilhouetteCaptureLogic.levelMessage(pitch: pitch)
    case .still: return "Hold still"
    case .mask: return verdict == nil ? "Hold still" : SilhouetteCaptureLogic.maskMessage(verdict)
    case .blur, nil: return blurry ? "Hold steady a moment" : "Hold still"
    }
  }

  /// Rotation rate against the newest sample at least motionWindowS old.
  private func angularSpeed(now: TimeInterval, transform: simd_float4x4) -> Float {
    guard let reference = motionSamples.last(where: { now - $0.time >= SilhouetteTuning.motionWindowS })
      ?? motionSamples.first
    else { return 0 }
    let dt = Float(now - reference.time)
    guard dt >= Float(PhotoTuning.motionMinBaselineS) else { return 0 }
    return PhotoCaptureLogic.rotationAngle(reference.transform, transform) / dt
  }

  /// Anchor in sensor pixels, nil when behind the camera (projectPoint mirrors those).
  private static func anchorPixel(_ camera: ARCamera, anchor: SIMD3<Float>) -> CGPoint? {
    let local = camera.transform.inverse * SIMD4<Float>(anchor, 1)
    guard local.z < 0 else { return nil }
    return camera.projectPoint(anchor, orientation: .landscapeRight, viewportSize: camera.imageResolution)
  }

  private var capturedSet: Set<SilhouetteStation> { Set(captured.keys) }

  private var lowLight: Bool {
    (lastAmbient.map { $0 < SilhouetteTuning.lowAmbientIntensity } ?? false)
      || maskFailStreak >= SilhouetteTuning.darkMaskFailStreak
  }

  // MARK: - Mask check (live, throttled)

  private func requestMaskCheck(_ frame: ARFrame, anchor: SIMD3<Float>, othersOK: Bool) {
    lastMaskCheckAt = frame.timestamp
    guard let pixel = Self.anchorPixel(frame.camera, anchor: anchor) else {
      maskVerdict = .notFound
      maskVerdictAt = frame.timestamp
      return
    }
    maskCheckInFlight = true
    let pixelBuffer = frame.capturedImage
    let up = SilhouetteCaptureLogic.imageUpAxis(cameraTransform: frame.camera.transform)
    let checkedAt = frame.timestamp
    workQueue.async { [weak self] in
      let verdict = SilhouetteMasking.liveVerdict(pixelBuffer, anchorPixel: pixel, up: up)
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          guard let self, !self.finished else { return }
          self.maskCheckInFlight = false
          self.maskVerdict = verdict
          self.maskVerdictAt = checkedAt
          if verdict == .valid {
            self.maskFailStreak = 0
          } else if othersOK {
            self.maskFailStreak += 1
          }
        }
      }
    }
  }

  // MARK: - Capture

  private func tryCapture(_ frame: ARFrame, station: SilhouetteStation, anchor: SIMD3<Float>, now: TimeInterval) {
    guard let sharpness = PhotoCaptureLogic.laplacianVariance(frame.capturedImage),
      sharpness >= PhotoCaptureLogic.blurThreshold(acceptedVariances: acceptedVariances)
    else {
      blurry = true
      failures[.blur, default: 0] += 1
      attemptFailures[.blur, default: 0] += 1
      return
    }
    blurry = false
    guard let pixel = Self.anchorPixel(frame.camera, anchor: anchor) else { return }
    capturing = true
    holdStart = nil
    let stem = String(format: "%03d", station.index)
    let jpegURL = imagesDir.appendingPathComponent("\(stem).jpg")
    let maskURL = masksDir.appendingPathComponent("\(stem).png")
    let pixelBuffer = frame.capturedImage
    let camera = frame.camera
    let transform = camera.transform
    let intrinsics = camera.intrinsics
    let up = SilhouetteCaptureLogic.imageUpAxis(cameraTransform: transform)
    let timestamp = frame.timestamp
    let context = ciContext
    let leg = leg

    workQueue.async { [weak self] in
      let outcome = Self.writeStation(
        pixelBuffer: pixelBuffer, jpegURL: jpegURL, maskURL: maskURL, anchorPixel: pixel, up: up, leg: leg,
        context: context)
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          guard let self else { return }
          self.capturing = false
          guard !self.finished else { return }
          switch outcome {
          case .writeFailed:
            self.teardown(deleteFiles: true) { [weak self] in
              self?.settle { $0.reject(CaptureWriteFailedException("could not write a photo or mask")) }
            }
            return
          case .retry:
            break
          case let .rejected(verdict):
            self.maskVerdict = verdict
            self.maskVerdictAt = timestamp
            self.failures[.mask, default: 0] += 1
            self.attemptFailures[.mask, default: 0] += 1
          case let .written(width, height, scaleX, scaleY, joints):
            let columns = [transform.columns.0, transform.columns.1, transform.columns.2, transform.columns.3]
            self.captured[station] = [
              "file": "\(stem).jpg",
              "mask": "\(stem).png",
              "station": station.rawValue,
              "timestamp": timestamp,
              "camera_to_world": columns.flatMap { [Double($0.x), Double($0.y), Double($0.z), Double($0.w)] },
              "intrinsics": [
                Double(intrinsics[0][0] * scaleX),
                Double(intrinsics[1][1] * scaleY),
                Double(intrinsics[2][0] * scaleX),
                Double(intrinsics[2][1] * scaleY),
              ],
              "width": width,
              "height": height,
              "tracking": "normal",
              "joints": joints,
            ]
            if self.selected == station { self.selected = nil }
            self.acceptedVariances.append(sharpness)
            self.startAttempt(now: timestamp)
            self.flash()
            self.haptic.notificationOccurred(.success)
            if self.captured.count == SilhouetteTuning.stationCount {
              self.messageLabel.text = self.guidance.force(SilhouetteCaptureLogic.allDone, now: timestamp)
            }
            self.refreshOverlay()
          }
          if self.finishRequested {
            self.finish()
          }
        }
      }
    }
  }

  /// Mask first (cheap rejection, nothing written), then JPEG, then the mask
  /// at exactly the written JPEG size.
  private nonisolated static func writeStation(
    pixelBuffer: CVPixelBuffer, jpegURL: URL, maskURL: URL, anchorPixel: CGPoint, up: ImageUpAxis,
    leg: SilhouetteLeg, context: CIContext
  ) -> StationOutcome {
    guard let detection = SilhouetteMasking.detect(pixelBuffer, anchorPixel: anchorPixel) else {
      return .rejected(.notFound)
    }
    let verdict = SilhouetteMasking.verdict(detection, pixelBuffer: pixelBuffer, anchorPixel: anchorPixel, up: up)
    guard verdict == .valid else { return .rejected(verdict) }
    switch PhotoCaptureController.encodeAndWrite(pixelBuffer: pixelBuffer, to: jpegURL, context: context) {
    case .skipped:
      return .retry
    case .writeFailed:
      return .writeFailed
    case let .written(width, height, scaleX, scaleY):
      guard let mask = SilhouetteMasking.fullMask(detection, width: width, height: height) else {
        try? FileManager.default.removeItem(at: jpegURL)
        return .retry
      }
      guard let bytes = SilhouetteMasking.writePNG(mask, width: width, height: height, to: maskURL) else {
        try? FileManager.default.removeItem(at: jpegURL)
        return .writeFailed
      }
      guard bytes <= SilhouetteTuning.maxMaskPngBytes else {
        try? FileManager.default.removeItem(at: jpegURL)
        try? FileManager.default.removeItem(at: maskURL)
        return .retry
      }
      let joints = SilhouetteJoints.detect(pixelBuffer, up: up, leg: leg, width: width, height: height)
      return .written(width: width, height: height, scaleX: scaleX, scaleY: scaleY, joints: joints)
    }
  }

  private func flash() {
    flashView.alpha = 0.8
    UIView.animate(withDuration: 0.25) { self.flashView.alpha = 0 }
  }

  private func startAttempt(now: TimeInterval) {
    attemptStartedAt = now
    attemptFailures = [:]
    troubleShown = false
    holdStart = nil
    blurry = false
  }

  // MARK: - Retake, trouble, torch

  private func retake(_ station: SilhouetteStation) {
    guard phase == .stations, !capturing, !finishRequested, !finished else { return }
    if captured.removeValue(forKey: station) != nil {
      removeFiles(for: station)
    }
    selected = station
    startAttempt(now: arView.session.currentFrame?.timestamp ?? 0)
    refreshOverlay()
  }

  private func removeFiles(for station: SilhouetteStation) {
    let stem = String(format: "%03d", station.index)
    try? FileManager.default.removeItem(at: imagesDir.appendingPathComponent("\(stem).jpg"))
    try? FileManager.default.removeItem(at: masksDir.appendingPathComponent("\(stem).png"))
  }

  private func retakeFromStart() {
    guard !capturing, !finished else { return }
    for station in SilhouetteStation.allCases { removeFiles(for: station) }
    captured = [:]
    selected = nil
    acceptedVariances = []
    anchor = nil
    aimError = false
    if let lineAnchor {
      arView.scene.removeAnchor(lineAnchor)
      self.lineAnchor = nil
    }
    phase = .aim
    attemptStartedAt = nil
    let now = arView.session.currentFrame?.timestamp ?? 0
    messageLabel.text = guidance.force(SilhouetteCaptureLogic.aimInstruction, now: now)
    refreshOverlay()
  }

  private func showTrouble() {
    troubleShown = true
    let worst = SilhouetteCaptureLogic.mostFrequent(attemptFailures) ?? .spot
    let alert = UIAlertController(
      title: "Having trouble?",
      message: "\(SilhouetteCaptureLogic.title(worst)): \(SilhouetteCaptureLogic.fix(worst))",
      preferredStyle: .actionSheet)
    alert.addAction(UIAlertAction(title: "Keep trying", style: .cancel) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        self.startAttempt(now: self.arView.session.currentFrame?.timestamp ?? 0)
      }
    })
    alert.addAction(UIAlertAction(title: "Retake from start", style: .default) { [weak self] _ in
      MainActor.assumeIsolated { self?.retakeFromStart() }
    })
    alert.addAction(UIAlertAction(title: "Enter measurements by hand", style: .default) { [weak self] _ in
      MainActor.assumeIsolated { self?.switchToManual() }
    })
    if let popover = alert.popoverPresentationController {
      popover.sourceView = view
      popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.maxY, width: 1, height: 1)
    }
    present(alert, animated: true)
  }

  private func switchToManual() {
    teardown(deleteFiles: true) { [weak self] in
      self?.settle { $0.reject(CaptureSwitchToManualException()) }
    }
  }

  @objc private func torchTapped() {
    setTorchState(!torchOn)
  }

  @objc private func lightPromptTapped() {
    setTorchState(true)
  }

  private func setTorchState(_ on: Bool) {
    if Self.setTorch(on) { torchOn = on }
    refreshOverlay()
  }

  /// UNVERIFIED on device: ARKit owns the AVCaptureSession, but setting the
  /// torch through the shared default video device is the documented way to
  /// light a running camera. Returns false when the device has no usable torch.
  nonisolated static func setTorch(_ on: Bool) -> Bool {
    guard let device = AVCaptureDevice.default(for: .video), device.hasTorch,
      device.isTorchModeSupported(.on)
    else { return false }
    do {
      try device.lockForConfiguration()
      defer { device.unlockForConfiguration() }
      if on {
        try device.setTorchModeOn(level: SilhouetteTuning.torchLevel)
      } else {
        device.torchMode = .off
      }
      return true
    } catch {
      return false
    }
  }

  private lazy var torchUsable: Bool = {
    guard let device = AVCaptureDevice.default(for: .video) else { return false }
    return device.hasTorch && device.isTorchModeSupported(.on)
  }()

  // MARK: - Stats

  private func emitStats() {
    onStats([
      "stationsCaptured": captured.count,
      "currentStation": currentStationName ?? NSNull(),
      "azimuthOffsetDeg": lastAzimuthOffset.map { Double($0 * 180 / .pi) } ?? NSNull(),
      "distanceM": lastDistance.map { Double($0) } ?? NSNull(),
      "levelDeg": lastPitch.map { Double(abs($0) * 180 / .pi) } ?? NSNull(),
      "maskValid": maskVerdict == .valid,
      "floorFound": floorY != nil,
      "failures": Dictionary(uniqueKeysWithValues: failures.map { ($0.key.rawValue, $0.value) }),
      "torchOn": torchOn,
      "ambientIntensity": lastAmbient.map { Double($0) } ?? NSNull(),
    ])
  }

  private var currentStationName: String? {
    guard phase == .stations else { return nil }
    return SilhouetteCaptureLogic.target(captured: capturedSet, selected: selected)?.rawValue
  }

  // MARK: - Finish

  @objc private func doneTapped() {
    guard captured.count == SilhouetteTuning.stationCount else { return }
    requestFinish(early: false)
  }

  @objc private func finishFourTapped() {
    guard SilhouetteCaptureLogic.canFinishWithFour(capturedSet) else { return }
    requestFinish(early: true)
  }

  @objc private func cancelTapped() {
    cancel()
  }

  private func requestFinish(early: Bool) {
    guard !finishRequested else { return }
    finishRequested = true
    finishedEarly = early
    refreshOverlay()
    if !capturing {
      finish()
    }
  }

  private func finish() {
    guard !finished, let anchor else { return }
    let images = SilhouetteStation.allCases.compactMap { captured[$0] }
    let coverage = Double(images.count) / Double(SilhouetteTuning.stationCount)
    let finishedEarly = images.count < SilhouetteTuning.stationCount
    let manifest: [String: Any] = [
      "format": "forms.photo-capture",
      "version": 2,
      "method": "silhouette",
      "device": ["model": PhotoCaptureController.deviceModel(), "os": UIDevice.current.systemVersion],
      "capture": [
        "mode": "solo",
        "anchor_world": [Double(anchor.x), Double(anchor.y), Double(anchor.z)],
        "front_azimuth_rad": Double(frontAzimuth),
        "coverage": coverage,
        "finished_early": finishedEarly,
      ] as [String: Any],
      "floor_y": floorY.map { Double($0) } ?? NSNull(),
      "images": images,
    ]
    let manifestURL = sessionDir.appendingPathComponent("capture.json")
    do {
      let data = try JSONSerialization.data(withJSONObject: manifest, options: [])
      try data.write(to: manifestURL, options: .atomic)
    } catch {
      teardown(deleteFiles: true) { [weak self] in
        self?.settle { $0.reject(CaptureWriteFailedException("could not write capture.json")) }
      }
      return
    }
    let result: [String: Any] = [
      "method": "silhouette",
      "sessionId": sessionId,
      "bundleDir": sessionDir.path,
      "manifestPath": manifestURL.path,
      "imageCount": images.count,
      "coverage": coverage,
      "mode": "solo",
      "finishedEarly": finishedEarly,
      "floorFound": floorY != nil,
    ]
    teardown(deleteFiles: false) { [weak self] in
      self?.settle { $0.resolve(result) }
    }
  }

  private func teardown(deleteFiles: Bool, then completion: @escaping @MainActor () -> Void) {
    guard !finished else { return }
    finished = true
    if torchOn {
      _ = Self.setTorch(false)
      torchOn = false
    }
    arView.session.pause()
    arView.session.delegate = nil
    UIApplication.shared.isIdleTimerDisabled = previousIdleTimerDisabled
    if deleteFiles {
      try? FileManager.default.removeItem(at: sessionDir)
    }
    if presentingViewController != nil {
      dismiss(animated: true) { MainActor.assumeIsolated { completion() } }
    } else {
      completion()
    }
  }

  private func settle(_ body: (Promise) -> Void) {
    guard let promise else { return }
    self.promise = nil
    body(promise)
  }

  // MARK: - Overlay

  private func show(_ message: String, now: TimeInterval) {
    let text = guidance.offer(message, now: now)
    if messageLabel.text != text {
      messageLabel.text = text
    }
  }

  private func buildOverlay() {
    let topPanel = UIView()
    topPanel.backgroundColor = UIColor.black.withAlphaComponent(0.6)
    topPanel.layer.cornerRadius = 12
    topPanel.translatesAutoresizingMaskIntoConstraints = false

    messageLabel.font = .preferredFont(forTextStyle: .title3)
    messageLabel.textColor = .white
    messageLabel.numberOfLines = 0
    messageLabel.adjustsFontForContentSizeCategory = true
    detailLabel.font = .preferredFont(forTextStyle: .callout)
    detailLabel.textColor = UIColor.white.withAlphaComponent(0.85)
    detailLabel.numberOfLines = 0
    detailLabel.adjustsFontForContentSizeCategory = true

    let textStack = UIStackView(arrangedSubviews: [messageLabel, detailLabel])
    textStack.axis = .vertical
    textStack.spacing = 6
    mapView.translatesAutoresizingMaskIntoConstraints = false
    mapView.onTap = { [weak self] station in self?.retake(station) }
    let topRow = UIStackView(arrangedSubviews: [mapView, textStack])
    topRow.axis = .horizontal
    topRow.alignment = .center
    topRow.spacing = 14
    topRow.translatesAutoresizingMaskIntoConstraints = false
    topPanel.addSubview(topRow)

    levelRow.accessory = tiltView
    checklistPanel.axis = .vertical
    checklistPanel.spacing = 8
    checklistPanel.isLayoutMarginsRelativeArrangement = true
    checklistPanel.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 12, leading: 12, bottom: 12, trailing: 12)
    checklistPanel.backgroundColor = UIColor.black.withAlphaComponent(0.6)
    checklistPanel.layer.cornerRadius = 12
    for row in [spotRow, distanceRow, levelRow, stillRow, maskRow] {
      checklistPanel.addArrangedSubview(row)
    }

    reticle.translatesAutoresizingMaskIntoConstraints = false
    reticle.isUserInteractionEnabled = false
    reticle.layer.borderColor = UIColor.white.cgColor
    reticle.layer.borderWidth = 3
    reticle.layer.cornerRadius = 32
    reticle.isAccessibilityElement = true
    reticle.accessibilityLabel = "Aiming circle. Point it at the front of your shin, then tap the screen."

    flashView.translatesAutoresizingMaskIntoConstraints = false
    flashView.backgroundColor = .white
    flashView.alpha = 0
    flashView.isUserInteractionEnabled = false

    configure(button: cancelButton, title: "Cancel", filled: false, action: #selector(cancelTapped))
    configure(button: doneButton, title: "Done", filled: false, action: #selector(doneTapped))
    configure(button: torchButton, title: "Light on", filled: false, action: #selector(torchTapped))
    configure(button: lightPromptButton, title: "Turn on light", filled: true, action: #selector(lightPromptTapped))
    configure(button: finishFourButton, title: "Finish with 4", filled: false, action: #selector(finishFourTapped))
    let secondary = UIStackView(arrangedSubviews: [torchButton, lightPromptButton, finishFourButton])
    secondary.axis = .horizontal
    secondary.distribution = .fillEqually
    secondary.spacing = 12
    let primary = UIStackView(arrangedSubviews: [cancelButton, doneButton])
    primary.axis = .horizontal
    primary.distribution = .fillEqually
    primary.spacing = 12
    let bottom = UIStackView(arrangedSubviews: [checklistPanel, secondary, primary])
    bottom.axis = .vertical
    bottom.spacing = 12
    bottom.translatesAutoresizingMaskIntoConstraints = false

    view.addSubview(reticle)
    view.addSubview(topPanel)
    view.addSubview(bottom)
    view.addSubview(flashView)
    let guide = view.safeAreaLayoutGuide
    NSLayoutConstraint.activate([
      topPanel.topAnchor.constraint(equalTo: guide.topAnchor, constant: 12),
      topPanel.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 16),
      topPanel.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -16),
      topRow.topAnchor.constraint(equalTo: topPanel.topAnchor, constant: 12),
      topRow.bottomAnchor.constraint(equalTo: topPanel.bottomAnchor, constant: -12),
      topRow.leadingAnchor.constraint(equalTo: topPanel.leadingAnchor, constant: 12),
      topRow.trailingAnchor.constraint(equalTo: topPanel.trailingAnchor, constant: -12),
      mapView.widthAnchor.constraint(equalToConstant: 112),
      mapView.heightAnchor.constraint(equalToConstant: 112),
      reticle.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      reticle.centerYAnchor.constraint(equalTo: view.centerYAnchor),
      reticle.widthAnchor.constraint(equalToConstant: 64),
      reticle.heightAnchor.constraint(equalToConstant: 64),
      bottom.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 16),
      bottom.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -16),
      bottom.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -16),
      primary.heightAnchor.constraint(greaterThanOrEqualToConstant: 52),
      secondary.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
      flashView.topAnchor.constraint(equalTo: view.topAnchor),
      flashView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      flashView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      flashView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
    ])
  }

  /// Per-frame part of the overlay: the detail line and the low light prompt.
  private func refreshHint(target: SilhouetteStation?) {
    let text: String
    switch phase {
    case .floor, .aim:
      text = SilhouetteCaptureLogic.setupHint
    case .stations:
      if lowLight && !torchOn {
        text = SilhouetteCaptureLogic.darkHint
      } else if let target {
        text = "Photo \(captured.count + 1) of \(SilhouetteTuning.stationCount): \(target.spokenName). Tap a dot to retake it."
      } else {
        text = "Tap a dot to retake it."
      }
    }
    if detailLabel.text != text { detailLabel.text = text }
    let prompt = torchUsable && phase == .stations && lowLight && !torchOn
    if lightPromptButton.isHidden == prompt { lightPromptButton.isHidden = !prompt }
  }

  private func configure(button: UIButton, title: String, filled: Bool, action: Selector) {
    style(button: button, title: title, filled: filled)
    button.addTarget(self, action: action, for: .touchUpInside)
  }

  private func style(button: UIButton, title: String, filled: Bool) {
    var config: UIButton.Configuration = filled ? .filled() : .gray()
    config.title = title
    config.cornerStyle = .medium
    config.baseBackgroundColor = filled ? .white : UIColor.black.withAlphaComponent(0.55)
    config.baseForegroundColor = filled ? .black : .white
    button.configuration = config
  }

  private func refreshOverlay() {
    let stations = phase == .stations
    let target = stations ? SilhouetteCaptureLogic.target(captured: capturedSet, selected: selected) : nil
    reticle.isHidden = phase != .aim
    checklistPanel.isHidden = !stations || target == nil
    mapView.isHidden = !stations
    mapView.frontAzimuth = CGFloat(frontAzimuth)
    mapView.stations = SilhouetteStation.allCases.map {
      ($0, CGFloat(frontAzimuth + SilhouetteCaptureLogic.azimuthOffset($0, leg: leg)))
    }
    mapView.captured = capturedSet
    mapView.target = target
    if !stations { mapView.current = nil }

    refreshHint(target: target)
    torchButton.isHidden = !torchUsable
    style(button: torchButton, title: torchOn ? "Light off" : "Light on", filled: false)
    let canFinish = captured.count == SilhouetteTuning.stationCount
    style(button: doneButton, title: "Done", filled: canFinish)
    doneButton.isEnabled = canFinish && !finishRequested
    finishFourButton.isHidden = !SilhouetteCaptureLogic.canFinishWithFour(capturedSet) || finishRequested
  }
}

// MARK: - Vision masks

/// Leg masks from Vision. Every function runs off the main thread on the
/// capture's work queue, on a pixel buffer in sensor orientation (.up).
enum SilhouetteMasking {
  /// Row-major 8-bit plane.
  struct Grid {
    var bytes: [UInt8]
    let width: Int
    let height: Int
  }

  /// The leg at the mask model's resolution (0 or 255) plus what is needed to
  /// render it at full resolution.
  struct Detection {
    let grid: Grid
    let observation: VNInstanceMaskObservation?
    let instances: IndexSet
    let handler: VNImageRequestHandler
  }

  /// Foreground instance containing the anchor (else the best overlap with a
  /// disc around it); person segmentation when instance masks are unavailable
  /// or empty. Nil when no leg is found.
  static func detect(_ pixelBuffer: CVPixelBuffer, anchorPixel: CGPoint) -> Detection? {
    let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .up, options: [:])
    let nativeWidth = CGFloat(CVPixelBufferGetWidth(pixelBuffer))
    let nativeHeight = CGFloat(CVPixelBufferGetHeight(pixelBuffer))
    guard nativeWidth > 0, nativeHeight > 0 else { return nil }

    let foreground = VNGenerateForegroundInstanceMaskRequest()
    if (try? handler.perform([foreground])) != nil,
      let observation = foreground.results?.first,
      !observation.allInstances.isEmpty,
      let labels = readPlane(observation.instanceMask, normalizeFloat: false)
    {
      let sx = CGFloat(labels.width) / nativeWidth
      let sy = CGFloat(labels.height) / nativeHeight
      let point = CGPoint(x: anchorPixel.x * sx, y: anchorPixel.y * sy)
      guard
        let instance = SilhouetteCaptureLogic.chooseInstance(
          labels: labels.bytes, width: labels.width, height: labels.height, at: point,
          radius: SilhouetteTuning.instanceDiscRadiusPx * sx)
      else { return nil }
      let grid = Grid(bytes: labels.bytes.map { $0 == instance ? 255 : 0 }, width: labels.width, height: labels.height)
      return Detection(grid: grid, observation: observation, instances: IndexSet(integer: Int(instance)), handler: handler)
    }

    let person = VNGeneratePersonSegmentationRequest()
    person.qualityLevel = .accurate
    person.outputPixelFormat = kCVPixelFormatType_OneComponent8
    guard (try? handler.perform([person])) != nil,
      let buffer = person.results?.first?.pixelBuffer,
      let plane = readPlane(buffer, normalizeFloat: true)
    else { return nil }
    let grid = Grid(bytes: plane.bytes.map { $0 >= 128 ? 255 : 0 }, width: plane.width, height: plane.height)
    let x = Int((anchorPixel.x * CGFloat(grid.width) / nativeWidth).rounded())
    let y = Int((anchorPixel.y * CGFloat(grid.height) / nativeHeight).rounded())
    guard x >= 0, x < grid.width, y >= 0, y < grid.height, grid.bytes[y * grid.width + x] != 0 else {
      return nil
    }
    return Detection(grid: grid, observation: nil, instances: IndexSet(), handler: handler)
  }

  static func verdict(
    _ detection: Detection, pixelBuffer: CVPixelBuffer, anchorPixel: CGPoint, up: ImageUpAxis
  ) -> SilhouetteMaskVerdict {
    let grid = detection.grid
    let sx = CGFloat(grid.width) / CGFloat(CVPixelBufferGetWidth(pixelBuffer))
    let sy = CGFloat(grid.height) / CGFloat(CVPixelBufferGetHeight(pixelBuffer))
    return SilhouetteCaptureLogic.validateMask(
      grid.bytes, width: grid.width, height: grid.height,
      anchor: CGPoint(x: anchorPixel.x * sx, y: anchorPixel.y * sy), up: up)
  }

  static func liveVerdict(_ pixelBuffer: CVPixelBuffer, anchorPixel: CGPoint, up: ImageUpAxis) -> SilhouetteMaskVerdict {
    guard let detection = detect(pixelBuffer, anchorPixel: anchorPixel) else { return .notFound }
    return verdict(detection, pixelBuffer: pixelBuffer, anchorPixel: anchorPixel, up: up)
  }

  /// Binary mask (0 or 255) at exactly width x height: the instance rendered
  /// at input resolution by Vision when available, else the low resolution
  /// grid, resized and thresholded at 128.
  static func fullMask(_ detection: Detection, width: Int, height: Int) -> [UInt8]? {
    var source = detection.grid
    if let observation = detection.observation,
      let scaled = try? observation.generateScaledMaskForImage(forInstances: detection.instances, from: detection.handler),
      let plane = readPlane(scaled, normalizeFloat: true)
    {
      source = plane
    }
    return resizeBinary(source, width: width, height: height)
  }

  static func resizeBinary(_ grid: Grid, width: Int, height: Int) -> [UInt8]? {
    guard width > 0, height > 0 else { return nil }
    if grid.width == width, grid.height == height {
      return grid.bytes.map { $0 >= 128 ? 255 : 0 }
    }
    var source = grid.bytes
    var output = [UInt8](repeating: 0, count: width * height)
    let status: vImage_Error = source.withUnsafeMutableBytes { sourcePtr in
      output.withUnsafeMutableBytes { outputPtr in
        var src = vImage_Buffer(
          data: sourcePtr.baseAddress, height: vImagePixelCount(grid.height), width: vImagePixelCount(grid.width),
          rowBytes: grid.width)
        var dst = vImage_Buffer(
          data: outputPtr.baseAddress, height: vImagePixelCount(height), width: vImagePixelCount(width),
          rowBytes: width)
        return vImageScale_Planar8(&src, &dst, nil, vImage_Flags(kvImageNoFlags))
      }
    }
    guard status == kvImageNoError else { return nil }
    return output.map { $0 >= 128 ? 255 : 0 }
  }

  /// Copy a one-component plane. 8-bit values are copied raw (instance labels
  /// or 0...255 confidence); 32-bit float 0...1 becomes 0...255 when
  /// normalizeFloat, and is refused otherwise.
  static func readPlane(_ buffer: CVPixelBuffer, normalizeFloat: Bool) -> Grid? {
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    let width = CVPixelBufferGetWidth(buffer)
    let height = CVPixelBufferGetHeight(buffer)
    let rowBytes = CVPixelBufferGetBytesPerRow(buffer)
    guard width > 0, height > 0, let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }
    var bytes = [UInt8](repeating: 0, count: width * height)
    switch CVPixelBufferGetPixelFormatType(buffer) {
    case kCVPixelFormatType_OneComponent8:
      bytes.withUnsafeMutableBytes { out in
        guard let dst = out.baseAddress else { return }
        for y in 0..<height {
          memcpy(dst.advanced(by: y * width), base.advanced(by: y * rowBytes), width)
        }
      }
    case kCVPixelFormatType_OneComponent32Float where normalizeFloat:
      let status: vImage_Error = bytes.withUnsafeMutableBytes { out in
        var src = vImage_Buffer(
          data: base, height: vImagePixelCount(height), width: vImagePixelCount(width), rowBytes: rowBytes)
        var dst = vImage_Buffer(
          data: out.baseAddress, height: vImagePixelCount(height), width: vImagePixelCount(width), rowBytes: width)
        return vImageConvert_PlanarFtoPlanar8(&src, &dst, 1, 0, vImage_Flags(kvImageNoFlags))
      }
      guard status == kvImageNoError else { return nil }
    default:
      return nil
    }
    return Grid(bytes: bytes, width: width, height: height)
  }

  /// 8-bit grayscale PNG (public.png). Returns the written size in bytes.
  static func writePNG(_ bytes: [UInt8], width: Int, height: Int, to url: URL) -> Int? {
    guard bytes.count == width * height,
      let provider = CGDataProvider(data: Data(bytes) as CFData),
      let image = CGImage(
        width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: width,
        space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
        provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent),
      let destination = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil)
    else { return nil }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { return nil }
    let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue
    return size
  }
}

// MARK: - Joints

/// Knee and ankle of the captured leg from VNDetectHumanBodyPoseRequest, in
/// pixels of the WRITTEN image (sensor orientation, u right, v down, origin
/// top-left), the mask's convention.
///
/// Vision runs with the orientation that makes the person upright (body pose
/// is trained on upright people; a phone held upright puts them sideways in
/// the sensor image). Its points are normalized with the origin bottom-left in
/// that ORIENTED image, so: oriented top-left (ou, ov) = (x, 1 - y), then
/// undo the orientation (sensorNormalized), then scale by the written size.
/// With orientation .up this reduces to u = x * width, v = (1 - y) * height.
/// Vision names the person's own left and right: leftKnee/leftAnkle for leg L.
enum SilhouetteJoints {
  static let minConfidence: Float = 0.3

  static func detect(
    _ pixelBuffer: CVPixelBuffer, up: ImageUpAxis, leg: SilhouetteLeg, width: Int, height: Int
  ) -> [String: Any] {
    var joints: [String: Any] = ["knee": NSNull(), "ankle": NSNull()]
    let orientation = uprightOrientation(up)
    let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: orientation, options: [:])
    let request = VNDetectHumanBodyPoseRequest()
    guard (try? handler.perform([request])) != nil, let observation = request.results?.first else {
      return joints
    }
    let names: [(String, VNHumanBodyPoseObservation.JointName)] =
      leg == .left ? [("knee", .leftKnee), ("ankle", .leftAnkle)] : [("knee", .rightKnee), ("ankle", .rightAnkle)]
    for (key, name) in names {
      guard let point = try? observation.recognizedPoint(name), point.confidence >= minConfidence else { continue }
      let sensor = sensorNormalized(CGPoint(x: point.location.x, y: 1 - point.location.y), from: orientation)
      let u = min(max(sensor.x, 0), 1) * CGFloat(width)
      let v = min(max(sensor.y, 0), 1) * CGFloat(height)
      joints[key] = [Double(u), Double(v), Double(min(max(point.confidence, 0), 1))]
    }
    return joints
  }

  /// EXIF orientation under which the sensor image shows world up at the top.
  /// .right (row 0 on the right, column 0 at the top) is a phone held upright.
  static func uprightOrientation(_ up: ImageUpAxis) -> CGImagePropertyOrientation {
    switch (up.alongX, up.positive) {
    case (false, false): return .up
    case (false, true): return .down
    case (true, false): return .right
    case (true, true): return .left
    }
  }

  /// Oriented top-left normalized point back to sensor top-left normalized.
  static func sensorNormalized(_ p: CGPoint, from orientation: CGImagePropertyOrientation) -> CGPoint {
    switch orientation {
    case .down: return CGPoint(x: 1 - p.x, y: 1 - p.y)
    case .right: return CGPoint(x: p.y, y: 1 - p.x)
    case .left: return CGPoint(x: 1 - p.y, y: p.x)
    default: return p
    }
  }
}

// MARK: - Overlay views

/// One auto-capture condition: status icon, plain-word title, live detail.
private final class ChecklistRow: UIStackView {
  private let icon = UIImageView()
  private let titleLabel = UILabel()
  private let detailLabel = UILabel()
  private let accessoryHolder = UIStackView()

  var accessory: UIView? {
    didSet {
      accessoryHolder.arrangedSubviews.forEach { $0.removeFromSuperview() }
      if let accessory { accessoryHolder.addArrangedSubview(accessory) }
    }
  }

  init(title: String) {
    super.init(frame: .zero)
    axis = .horizontal
    alignment = .center
    spacing = 10
    icon.translatesAutoresizingMaskIntoConstraints = false
    icon.contentMode = .scaleAspectFit
    icon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(textStyle: .title3)
    titleLabel.text = title
    titleLabel.font = .preferredFont(forTextStyle: .headline)
    titleLabel.textColor = .white
    titleLabel.adjustsFontForContentSizeCategory = true
    detailLabel.font = .preferredFont(forTextStyle: .body)
    detailLabel.textColor = UIColor.white.withAlphaComponent(0.85)
    detailLabel.numberOfLines = 0
    detailLabel.adjustsFontForContentSizeCategory = true
    let text = UIStackView(arrangedSubviews: [titleLabel, detailLabel])
    text.axis = .vertical
    text.spacing = 2
    addArrangedSubview(icon)
    addArrangedSubview(text)
    addArrangedSubview(accessoryHolder)
    NSLayoutConstraint.activate([
      icon.widthAnchor.constraint(equalToConstant: 28),
      icon.heightAnchor.constraint(equalToConstant: 28),
    ])
    isAccessibilityElement = true
    update(ok: nil, detail: "Checking")
  }

  @available(*, unavailable)
  required init(coder: NSCoder) {
    fatalError("init(coder:) is not supported")
  }

  /// ok nil: not known yet.
  func update(ok: Bool?, detail: String) {
    let symbol: String
    let tint: UIColor
    switch ok {
    case true?:
      symbol = "checkmark.circle.fill"
      tint = .systemGreen
    case false?:
      symbol = "xmark.circle.fill"
      tint = .systemOrange
    case nil:
      symbol = "circle.dotted"
      tint = UIColor.white.withAlphaComponent(0.6)
    }
    icon.image = UIImage(systemName: symbol)
    icon.tintColor = tint
    if detailLabel.text != detail { detailLabel.text = detail }
    accessibilityLabel = titleLabel.text
    accessibilityValue = "\(ok == true ? "OK" : ok == false ? "Not yet" : "Checking"). \(detail)"
  }
}

/// Vertical level gauge: the dot sits in the middle band when the optical axis
/// is within maxLevelRad of horizontal, above it when the phone points up.
private final class TiltView: UIView {
  private let band = UIView()
  private let dot = UIView()

  var pitch: CGFloat = 0 {
    didSet { setNeedsLayout() }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    translatesAutoresizingMaskIntoConstraints = false
    backgroundColor = UIColor.white.withAlphaComponent(0.2)
    layer.cornerRadius = 5
    band.backgroundColor = UIColor.systemGreen.withAlphaComponent(0.6)
    dot.backgroundColor = .white
    dot.layer.cornerRadius = 6
    addSubview(band)
    addSubview(dot)
    NSLayoutConstraint.activate([
      widthAnchor.constraint(equalToConstant: 12),
      heightAnchor.constraint(equalToConstant: 48),
    ])
    isAccessibilityElement = false
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not supported")
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let range = CGFloat.pi / 4
    let half = bounds.height / 2
    let bandHalf = half * CGFloat(SilhouetteTuning.maxLevelRad) / range
    band.frame = CGRect(x: 0, y: half - bandHalf, width: bounds.width, height: 2 * bandHalf)
    let clamped = max(-range, min(range, pitch))
    let y = half - clamped / range * (half - 6)
    dot.frame = CGRect(x: bounds.midX - 6, y: y - 6, width: 12, height: 12)
  }
}

/// Top-down map: the leg at the center, the five stations on a ring with the
/// front at the bottom (the user stands at the bottom looking at the leg), the
/// next station highlighted and the phone's live azimuth as a marker. Same
/// angle mapping as CoverageRingView, so moving left moves the marker left.
/// Tapping a dot asks to retake that station.
private final class StationMapView: UIView {
  var frontAzimuth: CGFloat = 0 { didSet { setNeedsLayout() } }
  var stations: [(SilhouetteStation, CGFloat)] = [] { didSet { setNeedsLayout() } }
  var captured = Set<SilhouetteStation>() { didSet { if captured != oldValue { setNeedsLayout() } } }
  var target: SilhouetteStation? { didSet { if target != oldValue { setNeedsLayout() } } }
  var current: CGFloat? { didSet { setNeedsLayout() } }
  var onTap: ((SilhouetteStation) -> Void)?

  private let ring = CAShapeLayer()
  private let legDot = UIView()
  private let marker = UIView()
  private var dots: [SilhouetteStation: UIView] = [:]

  override init(frame: CGRect) {
    super.init(frame: frame)
    ring.fillColor = UIColor.clear.cgColor
    ring.strokeColor = UIColor.white.withAlphaComponent(0.3).cgColor
    ring.lineWidth = 2
    layer.addSublayer(ring)
    legDot.backgroundColor = UIColor.white.withAlphaComponent(0.8)
    legDot.layer.cornerRadius = 6
    addSubview(legDot)
    for station in SilhouetteStation.allCases {
      let dot = UIView()
      dot.layer.borderColor = UIColor.white.cgColor
      addSubview(dot)
      dots[station] = dot
    }
    marker.backgroundColor = .systemYellow
    marker.layer.cornerRadius = 7
    marker.layer.borderColor = UIColor.black.cgColor
    marker.layer.borderWidth = 2
    addSubview(marker)
    addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped(_:))))
    isAccessibilityElement = true
    accessibilityLabel = "Photo stations around your leg"
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not supported")
  }

  private var radius: CGFloat { min(bounds.width, bounds.height) / 2 - 14 }

  private func point(forAzimuth azimuth: CGFloat) -> CGPoint {
    let angle = CGFloat.pi / 2 - frontAzimuth + azimuth
    return CGPoint(x: bounds.midX + radius * cos(angle), y: bounds.midY + radius * sin(angle))
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    ring.frame = bounds
    ring.path = UIBezierPath(
      arcCenter: CGPoint(x: bounds.midX, y: bounds.midY), radius: radius, startAngle: 0, endAngle: 2 * .pi,
      clockwise: true
    ).cgPath
    legDot.frame = CGRect(x: bounds.midX - 6, y: bounds.midY - 6, width: 12, height: 12)
    for (station, azimuth) in stations {
      guard let dot = dots[station] else { continue }
      let isTarget = station == target
      let size: CGFloat = isTarget ? 24 : 18
      let center = point(forAzimuth: azimuth)
      dot.frame = CGRect(x: center.x - size / 2, y: center.y - size / 2, width: size, height: size)
      dot.layer.cornerRadius = size / 2
      dot.layer.borderWidth = isTarget ? 3 : 2
      dot.backgroundColor =
        captured.contains(station)
        ? .systemGreen : isTarget ? UIColor.white.withAlphaComponent(0.9) : UIColor.white.withAlphaComponent(0.15)
    }
    if let current {
      marker.isHidden = false
      let center = point(forAzimuth: current)
      marker.frame = CGRect(x: center.x - 7, y: center.y - 7, width: 14, height: 14)
    } else {
      marker.isHidden = true
    }
    accessibilityValue = "\(captured.count) of \(SilhouetteTuning.stationCount) photos taken"
  }

  @objc private func tapped(_ gesture: UITapGestureRecognizer) {
    let location = gesture.location(in: self)
    let nearest = stations.min {
      hypot(point(forAzimuth: $0.1).x - location.x, point(forAzimuth: $0.1).y - location.y)
        < hypot(point(forAzimuth: $1.1).x - location.x, point(forAzimuth: $1.1).y - location.y)
    }
    guard let nearest else { return }
    let p = point(forAzimuth: nearest.1)
    if hypot(p.x - location.x, p.y - location.y) <= 26 {
      onTap?(nearest.0)
    }
  }
}
