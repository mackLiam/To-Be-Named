import ARKit
import CoreImage
import ExpoModulesCore
import RealityKit
import UIKit

/*
 Guided photo capture for iPhones without ObjectCaptureSession (no LiDAR).
 Presents a full-screen ARKit camera. The user first aims at the shin (a tap
 fixes a vertical leg axis), then sweeps the phone around it while sharp,
 well spaced frames are kept automatically. Writes the bundle the
 reconstruction worker consumes:

   <Application Support>/photo-captures/<sessionId>/capture.json
   <Application Support>/photo-captures/<sessionId>/images/NNN.jpg

 capture.json is the frozen "forms.photo-capture" v1 contract plus the
 optional "capture" object (validated in src/lib/upload.ts and
 services/pipeline reconstruct/bundle.py, which requires exactly its five
 keys). Images are written in the camera sensor orientation (landscape, as
 ARKit delivers capturedImage), the orientation camera.transform and
 camera.intrinsics are defined in; rotating them would invalidate the poses.

 Coverage is measured around the aimed axis, not a center guessed from
 viewing rays: a solo user sweeps only part of a circle, and ray
 intersection is unreliable on a partial arc.

 Sensitive data (CLAUDE.md gotcha 5): nothing here logs an image, a pose, or a
 path; onPhotoCaptureStats carries scalars only. Files stay in the app
 sandbox, excluded from iCloud backup, and the session folder is deleted on
 cancel or failure.

 Cannot be unit tested off-device: every input is a live ARFrame. Decision
 rules live in PhotoCaptureLogic.swift; constants in PhotoTuning.
*/
@MainActor
final class PhotoCaptureController: UIViewController, ARSessionDelegate {
  nonisolated static let maxLongSidePx: CGFloat = 2048
  nonisolated static let maxJpegBytes = 2 * 1024 * 1024

  private static let aimInstruction = "Point the circle at the front of your shin, halfway up, then tap."
  private static let aimFailed = "Could not find your leg. Move a little closer and tap again."
  private static let capReached = "Photo limit reached. Tap Done."

  private let mode: PhotoCaptureMode
  private let onStats: ([String: Any]) -> Void
  private let sessionId = UUID().uuidString
  private let sessionDir: URL
  private let imagesDir: URL
  private var promise: Promise?

  private let arView = ARView(frame: .zero, cameraMode: .ar, automaticallyConfigureSession: false)
  private let ciContext = CIContext()
  private let encodeQueue = DispatchQueue(label: "forms.photo-capture.encode", qos: .userInitiated)
  private let haptic = UIImpactFeedbackGenerator(style: .light)

  // Aim.
  private var aiming = true
  private var anchor: SIMD3<Float>?
  private var frontAzimuth: Float = 0
  private var aimError = false
  private var aimDistance: Float?
  private var lineAnchor: AnchorEntity?

  // Kept frames.
  private var images: [[String: Any]] = []
  private var keptPositions: [SIMD3<Float>] = []
  private var acceptedVariances: [Float] = []
  private var coveredBuckets = Set<Int>()

  // Per-frame state.
  private var motionSamples: [(time: TimeInterval, transform: simd_float4x4)] = []
  private var lastEvaluatedAt: TimeInterval = -.infinity
  private var lastStatsAt: TimeInterval = -.infinity
  private var currentBucket: Int?
  private var lastDistance: Float?
  private var lastAmbient: CGFloat?
  private var rejected: [String: Int] = [:]
  private var guidance = GuidanceGate()

  private var encoding = false
  private var finishRequested = false
  private var finishedEarly = false
  private var finished = false
  private var previousIdleTimerDisabled = false

  // Overlay.
  private let messageLabel = UILabel()
  private let countLabel = UILabel()
  private let targetLabel = UILabel()
  private let ringView = CoverageRingView(segments: PhotoTuning.bucketCount)
  private let reticle = UIView()
  private let cancelButton = UIButton(type: .system)
  private let doneButton = UIButton(type: .system)
  private let reaimButton = UIButton(type: .system)
  private let finishAnywayButton = UIButton(type: .system)

  init(mode: PhotoCaptureMode, onStats: @escaping ([String: Any]) -> Void) {
    self.mode = mode
    self.onStats = onStats
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    sessionDir = support.appendingPathComponent("photo-captures/\(sessionId)", isDirectory: true)
    imagesDir = sessionDir.appendingPathComponent("images", isDirectory: true)
    super.init(nibName: nil, bundle: nil)
    modalPresentationStyle = .fullScreen
    isModalInPresentation = true
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not supported")
  }

  // MARK: - Lifecycle

  func start(promise: Promise) {
    self.promise = promise
    do {
      try FileManager.default.createDirectory(at: imagesDir, withIntermediateDirectories: true)
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      var dir = sessionDir
      try dir.setResourceValues(values)
    } catch {
      self.promise = nil
      promise.reject(CaptureWriteFailedException("could not create the session folder"))
      return
    }
    guard let root = Self.topViewController() else {
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
    messageLabel.text = guidance.force(Self.aimInstruction, now: 0)
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

  // MARK: - Aim

  @objc private func screenTapped() {
    guard aiming, !finished, let frame = arView.session.currentFrame else { return }
    let now = frame.timestamp
    let center = CGPoint(x: arView.bounds.midX, y: arView.bounds.midY)
    guard let ray = arView.ray(through: center) else {
      showAimFailure(now: now)
      return
    }
    var hit: SIMD3<Float>?
    if let points = frame.rawFeaturePoints?.points {
      hit = PhotoCaptureLogic.aimPointFromFeatures(
        points, origin: ray.origin, direction: ray.direction)
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
    let cameraPosition = Self.translation(frame.camera.transform)
    anchor = axis
    aimDistance = simd_distance(hit, ray.origin)
    frontAzimuth = PhotoCaptureLogic.azimuth(of: cameraPosition, around: axis)
    aiming = false
    aimError = false
    showAnchorLine(at: axis)
    recomputeCoverage()
    haptic.impactOccurred()
    messageLabel.text = guidance.force(
      PhotoCaptureLogic.progressMessage(direction: nil, requirementMet: false), now: now)
    refreshOverlay()
  }

  private func showAimFailure(now: TimeInterval) {
    aimError = true
    messageLabel.text = guidance.force(Self.aimFailed, now: now)
  }

  @objc private func reaimTapped() {
    guard !finished, !finishRequested else { return }
    aiming = true
    aimError = false
    let now = arView.session.currentFrame?.timestamp ?? 0
    messageLabel.text = guidance.force(Self.aimInstruction, now: now)
    refreshOverlay()
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

  // MARK: - Frame acceptance

  private func handle(_ frame: ARFrame) {
    guard !finished else { return }
    let now = frame.timestamp
    let camera = frame.camera
    motionSamples.append((now, camera.transform))
    motionSamples.removeAll { now - $0.time > 3 * PhotoTuning.motionWindowS }
    lastAmbient = frame.lightEstimate?.ambientIntensity
    if let anchor {
      let position = Self.translation(camera.transform)
      lastDistance = PhotoCaptureLogic.horizontalDistance(position, toAxis: anchor)
      currentBucket = PhotoCaptureLogic.bucket(
        forAzimuth: PhotoCaptureLogic.azimuth(of: position, around: anchor))
      ringView.current = currentBucket
    }
    if now - lastStatsAt >= PhotoTuning.statsIntervalS {
      lastStatsAt = now
      emitStats()
    }
    guard !finishRequested, images.count < PhotoTuning.maxPhotos, !encoding,
      now - lastEvaluatedAt >= PhotoTuning.evaluateIntervalS
    else { return }
    lastEvaluatedAt = now
    evaluate(frame, now: now)
  }

  private func evaluate(_ frame: ARFrame, now: TimeInterval) {
    let camera = frame.camera
    if let message = Self.trackingMessage(camera.trackingState) {
      if !aiming, anchor != nil { count(.trackingLimited) }
      show(message, now: now)
      return
    }
    guard !aiming, let anchor else {
      show(aimError ? Self.aimFailed : Self.aimInstruction, now: now)
      return
    }
    let position = Self.translation(camera.transform)
    var variance: Float = 0
    if let reason = firstFailingCheck(frame, anchor: anchor, position: position, variance: &variance) {
      count(reason)
      show(PhotoCaptureLogic.rejectMessage(reason), now: now)
      return
    }
    show(progressMessage(position: position, anchor: anchor), now: now)
    if let last = keptPositions.last {
      let step = abs(PhotoCaptureLogic.wrapAngle(
        PhotoCaptureLogic.azimuth(of: position, around: anchor)
          - PhotoCaptureLogic.azimuth(of: last, around: anchor)))
      if step < PhotoTuning.minOrbitStepRad, abs(position.y - last.y) < PhotoTuning.minHeightStepM {
        return
      }
    }
    keep(frame: frame, position: position, variance: variance)
  }

  /// Checks in priority order; returns the first that fails. variance is the
  /// frame's sharpness once the blur check has run.
  private func firstFailingCheck(
    _ frame: ARFrame, anchor: SIMD3<Float>, position: SIMD3<Float>, variance: inout Float
  ) -> PhotoRejectReason? {
    if let ambient = frame.lightEstimate?.ambientIntensity, ambient < PhotoTuning.minAmbientIntensity {
      return .tooDark
    }
    if movingTooFast(now: frame.timestamp, transform: frame.camera.transform) {
      return .movingTooFast
    }
    guard let sharpness = PhotoCaptureLogic.laplacianVariance(frame.capturedImage),
      sharpness >= PhotoCaptureLogic.blurThreshold(acceptedVariances: acceptedVariances)
    else { return .blurry }
    variance = sharpness
    let distance = PhotoCaptureLogic.horizontalDistance(position, toAxis: anchor)
    if distance < PhotoTuning.minDistanceM { return .tooClose }
    if distance > PhotoTuning.maxDistanceM { return .tooFar }
    if !anchorCentered(frame.camera, anchor: anchor) { return .offTarget }
    return nil
  }

  /// Finite differences against the newest sample at least motionWindowS old.
  private func movingTooFast(now: TimeInterval, transform: simd_float4x4) -> Bool {
    guard let reference = motionSamples.last(where: { now - $0.time >= PhotoTuning.motionWindowS })
      ?? motionSamples.first
    else { return false }
    let dt = Float(now - reference.time)
    guard dt >= Float(PhotoTuning.motionMinBaselineS) else { return false }
    let angular = PhotoCaptureLogic.rotationAngle(reference.transform, transform) / dt
    let linear = simd_distance(Self.translation(reference.transform), Self.translation(transform)) / dt
    return angular > PhotoTuning.maxAngularSpeedRadPerS || linear > PhotoTuning.maxLinearSpeedMPerS
  }

  private func anchorCentered(_ camera: ARCamera, anchor: SIMD3<Float>) -> Bool {
    // projectPoint mirrors points behind the camera into the image; the camera looks down -Z.
    let local = camera.transform.inverse * SIMD4<Float>(anchor, 1)
    guard local.z < 0 else { return false }
    let point = camera.projectPoint(anchor, orientation: .landscapeRight, viewportSize: camera.imageResolution)
    return PhotoCaptureLogic.isCentered(point, imageSize: camera.imageResolution)
  }

  private func progressMessage(position: SIMD3<Float>, anchor: SIMD3<Float>) -> String {
    let azimuth = PhotoCaptureLogic.azimuth(of: position, around: anchor)
    let target = PhotoCaptureLogic.targetBucket(
      mode: mode, covered: coveredBuckets, frontAzimuth: frontAzimuth, currentAzimuth: azimuth)
    let direction = target.flatMap { bucket -> OrbitDirection? in
      // Already standing in the needed bucket: no hint.
      bucket == PhotoCaptureLogic.bucket(forAzimuth: azimuth)
        ? nil
        : PhotoCaptureLogic.direction(from: azimuth, to: PhotoCaptureLogic.bucketCenter(bucket))
    }
    return PhotoCaptureLogic.progressMessage(direction: direction, requirementMet: requirementMet)
  }

  private func count(_ reason: PhotoRejectReason) {
    rejected[reason.rawValue, default: 0] += 1
  }

  private func show(_ message: String, now: TimeInterval) {
    let text = guidance.offer(message, now: now)
    if messageLabel.text != text {
      messageLabel.text = text
    }
  }

  private func keep(frame: ARFrame, position: SIMD3<Float>, variance: Float) {
    encoding = true
    let index = images.count
    let fileName = String(format: "%03d.jpg", index)
    let fileURL = imagesDir.appendingPathComponent(fileName)
    let pixelBuffer = frame.capturedImage
    let camera = frame.camera
    let transform = camera.transform
    let intrinsics = camera.intrinsics
    let timestamp = frame.timestamp
    let context = ciContext

    encodeQueue.async { [weak self] in
      let outcome = Self.encodeAndWrite(pixelBuffer: pixelBuffer, to: fileURL, context: context)
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          guard let self else { return }
          self.encoding = false
          guard !self.finished else { return }
          switch outcome {
          case .skipped:
            break
          case .writeFailed:
            self.teardown(deleteFiles: true) { [weak self] in
              self?.settle { $0.reject(CaptureWriteFailedException("could not write a photo")) }
            }
            return
          case let .written(width, height, scaleX, scaleY):
            let columns = [transform.columns.0, transform.columns.1, transform.columns.2, transform.columns.3]
            let cameraToWorld: [Double] = columns.flatMap { [Double($0.x), Double($0.y), Double($0.z), Double($0.w)] }
            self.images.append([
              "file": fileName,
              "timestamp": timestamp,
              "camera_to_world": cameraToWorld,
              "intrinsics": [
                Double(intrinsics[0][0] * scaleX),
                Double(intrinsics[1][1] * scaleY),
                Double(intrinsics[2][0] * scaleX),
                Double(intrinsics[2][1] * scaleY),
              ],
              "width": width,
              "height": height,
              "tracking": "normal",
            ])
            self.keptPositions.append(position)
            self.acceptedVariances.append(variance)
            if self.acceptedVariances.count > PhotoTuning.blurMedianWindow {
              self.acceptedVariances.removeFirst()
            }
            self.recomputeCoverage()
            self.haptic.impactOccurred()
            if self.images.count >= PhotoTuning.maxPhotos {
              self.messageLabel.text = self.guidance.force(Self.capReached, now: timestamp)
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

  enum EncodeOutcome {
    case written(width: Int, height: Int, scaleX: Float, scaleY: Float)
    case skipped
    case writeFailed
  }

  /// Downscale so the long side is at most maxLongSidePx, encode JPEG, write.
  /// Shared with SilhouetteCaptureController: both bundles use these pixels.
  nonisolated static func encodeAndWrite(pixelBuffer: CVPixelBuffer, to url: URL, context: CIContext) -> EncodeOutcome {
    let nativeWidth = CGFloat(CVPixelBufferGetWidth(pixelBuffer))
    let nativeHeight = CGFloat(CVPixelBufferGetHeight(pixelBuffer))
    guard nativeWidth > 0, nativeHeight > 0 else { return .skipped }
    let scale = min(1, maxLongSidePx / max(nativeWidth, nativeHeight))
    let width = Int((nativeWidth * scale).rounded())
    let height = Int((nativeHeight * scale).rounded())
    let scaleX = CGFloat(width) / nativeWidth
    let scaleY = CGFloat(height) / nativeHeight

    var image = CIImage(cvPixelBuffer: pixelBuffer)
    if width != Int(nativeWidth) || height != Int(nativeHeight) {
      image = image.transformed(by: CGAffineTransform(scaleX: scaleX, y: scaleY))
    }
    let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
    var data: Data?
    for quality in [0.85, 0.7, 0.55] {
      let options = [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: quality]
      guard let encoded = context.jpegRepresentation(of: image, colorSpace: colorSpace, options: options) else {
        return .skipped
      }
      data = encoded
      if encoded.count <= maxJpegBytes { break }
    }
    guard let data, data.count <= maxJpegBytes else { return .skipped }
    do {
      try data.write(to: url, options: .atomic)
    } catch {
      return .writeFailed
    }
    return .written(width: width, height: height, scaleX: Float(scaleX), scaleY: Float(scaleY))
  }

  // MARK: - Coverage

  private func recomputeCoverage() {
    guard let anchor else {
      coveredBuckets = []
      return
    }
    coveredBuckets = Set(keptPositions.map {
      PhotoCaptureLogic.bucket(forAzimuth: PhotoCaptureLogic.azimuth(of: $0, around: anchor))
    })
  }

  private var coverage: Double {
    PhotoCaptureLogic.coverage(coveredBuckets)
  }

  private var requirementMet: Bool {
    anchor != nil
      && PhotoCaptureLogic.requirementMet(
        mode: mode, covered: coveredBuckets, frontAzimuth: frontAzimuth, photoCount: images.count)
  }

  private var atCap: Bool { images.count >= PhotoTuning.maxPhotos }

  private var canFinish: Bool { requirementMet || atCap }

  private var canFinishEarly: Bool {
    !canFinish && images.count >= PhotoTuning.finishAnywayMinPhotos
  }

  private func emitStats() {
    onStats([
      "kept": images.count,
      "rejected": rejected,
      "coverage": coverage,
      "distanceM": lastDistance.map { Double($0) } ?? NSNull(),
      "ambientIntensity": lastAmbient.map { Double($0) } ?? NSNull(),
      "mode": mode.rawValue,
      "aimed": anchor != nil && !aiming,
      "aimDistanceM": aimDistance.map { Double($0) } ?? NSNull(),
    ])
  }

  // MARK: - Finish

  @objc private func doneTapped() {
    guard canFinish else { return }
    requestFinish(early: !requirementMet)
  }

  @objc private func finishAnywayTapped() {
    guard canFinishEarly, !finishRequested else { return }
    let alert = UIAlertController(
      title: "Finish with fewer photos?", message: "The fit may be less accurate.", preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: "Keep scanning", style: .cancel))
    alert.addAction(UIAlertAction(title: "Finish", style: .default) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self, self.canFinishEarly else { return }
        self.requestFinish(early: true)
      }
    })
    present(alert, animated: true)
  }

  private func requestFinish(early: Bool) {
    guard !finishRequested else { return }
    finishRequested = true
    finishedEarly = early
    refreshOverlay()
    if !encoding {
      finish()
    }
  }

  @objc private func cancelTapped() {
    cancel()
  }

  private func finish() {
    guard !finished else { return }
    var manifest: [String: Any] = [
      "format": "forms.photo-capture",
      "version": 1,
      "device": ["model": Self.deviceModel(), "os": UIDevice.current.systemVersion],
      "images": images,
    ]
    if let anchor {
      manifest["capture"] = [
        "mode": mode.rawValue,
        "anchor_world": [Double(anchor.x), Double(anchor.y), Double(anchor.z)],
        "front_azimuth_rad": Double(frontAzimuth),
        "coverage": coverage,
        "finished_early": finishedEarly,
      ] as [String: Any]
    }
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
      "sessionId": sessionId,
      "bundleDir": sessionDir.path,
      "manifestPath": manifestURL.path,
      "imageCount": images.count,
      "coverage": coverage,
      "mode": mode.rawValue,
      "finishedEarly": finishedEarly,
    ]
    teardown(deleteFiles: false) { [weak self] in
      self?.settle { $0.resolve(result) }
    }
  }

  private func teardown(deleteFiles: Bool, then completion: @escaping @MainActor () -> Void) {
    guard !finished else { return }
    finished = true
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

  private func buildOverlay() {
    let panel = UIView()
    panel.backgroundColor = UIColor.black.withAlphaComponent(0.55)
    panel.layer.cornerRadius = 12
    panel.translatesAutoresizingMaskIntoConstraints = false

    messageLabel.font = .preferredFont(forTextStyle: .headline)
    messageLabel.textColor = .white
    messageLabel.numberOfLines = 0
    messageLabel.adjustsFontForContentSizeCategory = true
    countLabel.font = .monospacedDigitSystemFont(ofSize: 13, weight: .regular)
    countLabel.textColor = UIColor.white.withAlphaComponent(0.85)
    targetLabel.font = .preferredFont(forTextStyle: .caption1)
    targetLabel.textColor = UIColor.white.withAlphaComponent(0.7)
    targetLabel.numberOfLines = 0
    targetLabel.adjustsFontForContentSizeCategory = true
    targetLabel.text = mode == .solo
      ? "Aim for 50% around in solo mode, with the front and both sides."
      : "Aim for 85% around with a helper."

    let textStack = UIStackView(arrangedSubviews: [messageLabel, countLabel, targetLabel])
    textStack.axis = .vertical
    textStack.spacing = 4
    ringView.translatesAutoresizingMaskIntoConstraints = false
    let topRow = UIStackView(arrangedSubviews: [ringView, textStack])
    topRow.axis = .horizontal
    topRow.alignment = .center
    topRow.spacing = 16
    topRow.translatesAutoresizingMaskIntoConstraints = false
    panel.addSubview(topRow)

    reticle.translatesAutoresizingMaskIntoConstraints = false
    reticle.isUserInteractionEnabled = false
    reticle.layer.borderColor = UIColor.white.cgColor
    reticle.layer.borderWidth = 3
    reticle.layer.cornerRadius = 32
    reticle.isAccessibilityElement = true
    reticle.accessibilityLabel = "Aiming circle. Point it at the front of your shin, then tap the screen."

    configure(button: cancelButton, title: "Cancel", filled: false, action: #selector(cancelTapped))
    configure(button: doneButton, title: "Done", filled: false, action: #selector(doneTapped))
    configure(button: reaimButton, title: "Re-aim", filled: false, action: #selector(reaimTapped))
    configure(button: finishAnywayButton, title: "Finish anyway", filled: false, action: #selector(finishAnywayTapped))
    let secondary = UIStackView(arrangedSubviews: [reaimButton, finishAnywayButton])
    secondary.axis = .horizontal
    secondary.distribution = .fillEqually
    secondary.spacing = 12
    let primary = UIStackView(arrangedSubviews: [cancelButton, doneButton])
    primary.axis = .horizontal
    primary.distribution = .fillEqually
    primary.spacing = 12
    let buttons = UIStackView(arrangedSubviews: [secondary, primary])
    buttons.axis = .vertical
    buttons.spacing = 12
    buttons.translatesAutoresizingMaskIntoConstraints = false

    view.addSubview(reticle)
    view.addSubview(panel)
    view.addSubview(buttons)
    let guide = view.safeAreaLayoutGuide
    NSLayoutConstraint.activate([
      panel.topAnchor.constraint(equalTo: guide.topAnchor, constant: 12),
      panel.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 16),
      panel.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -16),
      topRow.topAnchor.constraint(equalTo: panel.topAnchor, constant: 12),
      topRow.bottomAnchor.constraint(equalTo: panel.bottomAnchor, constant: -12),
      topRow.leadingAnchor.constraint(equalTo: panel.leadingAnchor, constant: 12),
      topRow.trailingAnchor.constraint(equalTo: panel.trailingAnchor, constant: -12),
      ringView.widthAnchor.constraint(equalToConstant: 72),
      ringView.heightAnchor.constraint(equalToConstant: 72),
      reticle.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      reticle.centerYAnchor.constraint(equalTo: view.centerYAnchor),
      reticle.widthAnchor.constraint(equalToConstant: 64),
      reticle.heightAnchor.constraint(equalToConstant: 64),
      buttons.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 16),
      buttons.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -16),
      buttons.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -16),
      primary.heightAnchor.constraint(greaterThanOrEqualToConstant: 52),
      secondary.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
    ])
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
    countLabel.text = "\(images.count) photos, \(Int((coverage * 100).rounded()))% around"
    ringView.frontAzimuth = CGFloat(frontAzimuth)
    ringView.covered = coveredBuckets
    ringView.current = anchor == nil ? nil : currentBucket
    style(button: doneButton, title: "Done", filled: canFinish)
    doneButton.isEnabled = canFinish && !finishRequested
    finishAnywayButton.isHidden = !canFinishEarly || finishRequested
    reaimButton.isHidden = aiming || finishRequested || atCap
    reticle.isHidden = !aiming
  }

  // MARK: - Helpers

  static func trackingMessage(_ state: ARCamera.TrackingState) -> String? {
    switch state {
    case .normal:
      return nil
    case .notAvailable:
      return "Starting the camera. Move the phone slowly."
    case let .limited(reason):
      switch reason {
      case .excessiveMotion: return "Slow down. The camera lost its place."
      case .insufficientFeatures: return "Not enough detail in view. Add light, or include the floor."
      case .initializing: return "Starting up. Move the phone slowly side to side."
      case .relocalizing: return "Finding its place again. Point back at your leg."
      @unknown default: return "Tracking is limited. Move the phone slowly."
      }
    }
  }

  static func translation(_ m: simd_float4x4) -> SIMD3<Float> {
    SIMD3<Float>(m.columns.3.x, m.columns.3.y, m.columns.3.z)
  }

  static func deviceModel() -> String {
    var info = utsname()
    uname(&info)
    return withUnsafeBytes(of: &info.machine) { buffer in
      String(decoding: buffer.prefix { $0 != 0 }, as: UTF8.self)
    }
  }

  /// Same presentation root as CaptureSessionController (single-window app).
  static func topViewController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes
    let windowScene = scenes.first { $0.activationState == .foregroundActive } as? UIWindowScene
    let keyWindow = windowScene?.windows.first { $0.isKeyWindow }
    var top = keyWindow?.rootViewController
    while let presented = top?.presentedViewController {
      top = presented
    }
    return top
  }
}

/// Top-down map of the 36 azimuth buckets, rotated so the aim (front) bucket
/// sits at the bottom: the user stands at the bottom looking up at the leg.
/// UIKit angles grow clockwise with y down, matching azimuth with world x to
/// the right and z down, so the map is not mirrored.
private final class CoverageRingView: UIView {
  private let segmentLayers: [CAShapeLayer]

  var frontAzimuth: CGFloat = 0 {
    didSet { if frontAzimuth != oldValue { setNeedsLayout() } }
  }

  var covered = Set<Int>() {
    didSet { if covered != oldValue { updateColors() } }
  }

  var current: Int? {
    didSet { if current != oldValue { updateColors() } }
  }

  init(segments: Int) {
    segmentLayers = (0..<segments).map { _ in CAShapeLayer() }
    super.init(frame: .zero)
    isAccessibilityElement = true
    accessibilityLabel = "Coverage around the leg"
    for layer in segmentLayers {
      layer.fillColor = UIColor.clear.cgColor
      self.layer.addSublayer(layer)
    }
    updateColors()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not supported")
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let center = CGPoint(x: bounds.midX, y: bounds.midY)
    let radius = min(bounds.width, bounds.height) / 2 - 6
    let step = 2 * CGFloat.pi / CGFloat(segmentLayers.count)
    let gap = step * 0.15
    let offset = CGFloat.pi / 2 - frontAzimuth
    for (index, layer) in segmentLayers.enumerated() {
      let start = offset + CGFloat(index) * step + gap / 2
      layer.frame = bounds
      layer.path = UIBezierPath(
        arcCenter: center, radius: radius, startAngle: start, endAngle: start + step - gap, clockwise: true
      ).cgPath
    }
  }

  private func updateColors() {
    for (index, layer) in segmentLayers.enumerated() {
      let isCurrent = index == current
      layer.lineWidth = isCurrent ? 10 : 6
      if isCurrent {
        layer.strokeColor = UIColor.white.cgColor
      } else if covered.contains(index) {
        layer.strokeColor = UIColor.systemGreen.cgColor
      } else {
        layer.strokeColor = UIColor.white.withAlphaComponent(0.25).cgColor
      }
    }
    accessibilityValue = "\(Int((Double(covered.count) / Double(max(1, segmentLayers.count)) * 100).rounded())) percent"
  }
}
