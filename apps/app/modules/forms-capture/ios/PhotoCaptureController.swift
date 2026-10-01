import ARKit
import CoreImage
import ExpoModulesCore
import RealityKit
import UIKit

/*
 Guided photo capture for iPhones without ObjectCaptureSession (no LiDAR).
 Presents a full-screen ARKit camera, auto-keeps sharp frames spaced around an
 orbit of the leg, and writes a bundle the Mac reconstruction worker consumes:

   <Application Support>/photo-captures/<sessionId>/capture.json
   <Application Support>/photo-captures/<sessionId>/images/NNN.jpg

 capture.json is the frozen "forms.photo-capture" v1 contract (validated again
 in src/lib/upload.ts and on the server). Images are written in the camera
 sensor orientation (landscape, as ARKit delivers capturedImage), which is the
 orientation camera.transform and camera.intrinsics are defined in; rotating
 them for display would invalidate the poses.

 Sensitive data (CLAUDE.md gotcha 5): nothing here logs an image, a pose, or a
 path. Files stay in the app sandbox, excluded from iCloud backup, and the
 session folder is deleted on cancel or failure.

 Cannot be unit tested off-device: every input is a live ARFrame. Thresholds
 below are tuning knobs, unverified on real legs.
*/
@MainActor
final class PhotoCaptureController: UIViewController, ARSessionDelegate {
  // Contract caps (capture.json v1). The server re-validates all of these.
  static let minPhotosForDone = 40
  static let maxPhotos = 120
  nonisolated static let maxLongSidePx: CGFloat = 2048
  nonisolated static let maxJpegBytes = 2 * 1024 * 1024
  static let bucketCount = 36
  static let minCoverageForDone = 0.7

  // Frame selection tuning (unverified on device).
  private static let minOrbitStepRad: Float = 6 * .pi / 180
  private static let minTranslationM: Float = 0.04
  /// Sharpness proxy: frames are skipped while the camera turns faster than this.
  private static let maxAngularVelocityRadPerS: Float = 0.5
  /// Guess at the leg distance, used only until viewing rays give a real center.
  private static let fallbackCenterDistanceM: Float = 0.6

  private let sessionId = UUID().uuidString
  private let sessionDir: URL
  private let imagesDir: URL
  private var promise: Promise?

  private let arView = ARView(frame: .zero, cameraMode: .ar, automaticallyConfigureSession: false)
  private let ciContext = CIContext()
  private let encodeQueue = DispatchQueue(label: "forms.photo-capture.encode", qos: .userInitiated)

  private var images: [[String: Any]] = []
  /// Horizontal (x, z) position and forward direction of each kept frame.
  private var keptPositions: [SIMD2<Float>] = []
  private var keptForwards: [SIMD2<Float>] = []
  private var lastKeptPosition: SIMD3<Float>?
  private var lastFrameTransform: simd_float4x4?
  private var lastFrameTime: TimeInterval?
  private var coveredBuckets = Set<Int>()
  private var encoding = false
  private var finishRequested = false
  private var finished = false
  private var previousIdleTimerDisabled = false

  private let countLabel = UILabel()
  private let instructionLabel = UILabel()
  private let ringView = CoverageRingView(segments: PhotoCaptureController.bucketCount)
  private let cancelButton = UIButton(type: .system)
  private let doneButton = UIButton(type: .system)

  private static let baseInstruction = "Walk slowly around the leg. Keep ankle to knee in frame."

  init() {
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
    buildOverlay()
    NSLayoutConstraint.activate([
      arView.topAnchor.constraint(equalTo: view.topAnchor),
      arView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      arView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      arView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
    ])
    refreshOverlay()
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    guard !finished else { return }
    previousIdleTimerDisabled = UIApplication.shared.isIdleTimerDisabled
    UIApplication.shared.isIdleTimerDisabled = true
    let configuration = ARWorldTrackingConfiguration()
    configuration.worldAlignment = .gravity
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

  // MARK: - Frame selection

  private func handle(_ frame: ARFrame) {
    guard !finished, !finishRequested, images.count < Self.maxPhotos else { return }
    let camera = frame.camera
    let transform = camera.transform
    let previousTransform = lastFrameTransform
    let previousTime = lastFrameTime
    lastFrameTransform = transform
    lastFrameTime = frame.timestamp

    guard case .normal = camera.trackingState else {
      setInstruction("Finding your place. Move the phone slowly.")
      return
    }
    setInstruction(Self.baseInstruction)

    guard let previousTransform, let previousTime, frame.timestamp > previousTime else { return }
    let angularVelocity =
      Self.rotationAngle(previousTransform, transform) / Float(frame.timestamp - previousTime)
    guard angularVelocity <= Self.maxAngularVelocityRadPerS, !encoding else { return }

    let position = SIMD3<Float>(transform.columns.3.x, transform.columns.3.y, transform.columns.3.z)
    let forward = -SIMD3<Float>(transform.columns.2.x, transform.columns.2.y, transform.columns.2.z)
    let flatPosition = SIMD2<Float>(position.x, position.z)
    let flatForward = SIMD2<Float>(forward.x, forward.z)

    if let lastKeptPosition, let lastFlat = keptPositions.last {
      let moved = simd_distance(position, lastKeptPosition)
      let center = orbitCenter()
      let step = abs(Self.wrapAngle(Self.orbitAngle(flatPosition, center) - Self.orbitAngle(lastFlat, center)))
      guard step >= Self.minOrbitStepRad || moved >= Self.minTranslationM else { return }
    }

    keep(frame: frame, position: position, flatPosition: flatPosition, flatForward: flatForward)
  }

  private func keep(frame: ARFrame, position: SIMD3<Float>, flatPosition: SIMD2<Float>, flatForward: SIMD2<Float>) {
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
            self.lastKeptPosition = position
            self.keptPositions.append(flatPosition)
            self.keptForwards.append(flatForward)
            self.recomputeCoverage()
            self.refreshOverlay()
          }
          if self.finishRequested {
            self.finish()
          }
        }
      }
    }
  }

  private enum EncodeOutcome {
    case written(width: Int, height: Int, scaleX: Float, scaleY: Float)
    case skipped
    case writeFailed
  }

  /// Downscale so the long side is at most maxLongSidePx, encode JPEG, write.
  private nonisolated static func encodeAndWrite(pixelBuffer: CVPixelBuffer, to url: URL, context: CIContext) -> EncodeOutcome {
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

  // MARK: - Orbit geometry

  /// Least-squares intersection of the kept frames' horizontal viewing rays:
  /// the camera always looks at the leg, so the rays meet near it. Falls back
  /// to a point ahead of the first frame until the rays spread enough to solve.
  private func orbitCenter() -> SIMD2<Float> {
    var a11: Float = 0, a12: Float = 0, a22: Float = 0, b1: Float = 0, b2: Float = 0
    var count: Float = 0
    for (p, rawD) in zip(keptPositions, keptForwards) {
      let length = simd_length(rawD)
      guard length > 1e-3 else { continue }
      let d = rawD / length
      let m11 = 1 - d.x * d.x, m12 = -d.x * d.y, m22 = 1 - d.y * d.y
      a11 += m11; a12 += m12; a22 += m22
      b1 += m11 * p.x + m12 * p.y
      b2 += m12 * p.x + m22 * p.y
      count += 1
    }
    let det = a11 * a22 - a12 * a12
    if count >= 2, det / (count * count) > 0.01 {
      let center = SIMD2<Float>((a22 * b1 - a12 * b2) / det, (a11 * b2 - a12 * b1) / det)
      if let first = keptPositions.first, simd_distance(center, first) < 3 {
        return center
      }
    }
    guard let first = keptPositions.first, let forward = keptForwards.first, simd_length(forward) > 1e-3 else {
      return keptPositions.first ?? .zero
    }
    return first + simd_normalize(forward) * Self.fallbackCenterDistanceM
  }

  private func recomputeCoverage() {
    let center = orbitCenter()
    let bucketWidth = 2 * Float.pi / Float(Self.bucketCount)
    let startAngle = keptPositions.first.map { Self.orbitAngle($0, center) } ?? 0
    coveredBuckets = Set(keptPositions.map { position in
      var relative = Self.orbitAngle(position, center) - startAngle
      relative = relative.truncatingRemainder(dividingBy: 2 * .pi)
      if relative < 0 { relative += 2 * .pi }
      return min(Self.bucketCount - 1, Int(relative / bucketWidth))
    })
  }

  private var coverage: Double {
    Double(coveredBuckets.count) / Double(Self.bucketCount)
  }

  private static func orbitAngle(_ position: SIMD2<Float>, _ center: SIMD2<Float>) -> Float {
    atan2(position.y - center.y, position.x - center.x)
  }

  private static func wrapAngle(_ angle: Float) -> Float {
    var a = angle.truncatingRemainder(dividingBy: 2 * .pi)
    if a > .pi { a -= 2 * .pi }
    if a < -.pi { a += 2 * .pi }
    return a
  }

  /// Angle of the relative rotation between two camera poses.
  private static func rotationAngle(_ a: simd_float4x4, _ b: simd_float4x4) -> Float {
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

  // MARK: - Finish

  @objc private func doneTapped() {
    guard canFinish, !finishRequested else { return }
    finishRequested = true
    refreshOverlay()
    if !encoding {
      finish()
    }
  }

  @objc private func cancelTapped() {
    cancel()
  }

  private var canFinish: Bool {
    images.count >= Self.minPhotosForDone && coverage >= Self.minCoverageForDone
  }

  private func finish() {
    guard !finished else { return }
    let manifest: [String: Any] = [
      "format": "forms.photo-capture",
      "version": 1,
      "device": ["model": Self.deviceModel(), "os": UIDevice.current.systemVersion],
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
      "sessionId": sessionId,
      "bundleDir": sessionDir.path,
      "manifestPath": manifestURL.path,
      "imageCount": images.count,
      "coverage": coverage,
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

    countLabel.font = .monospacedDigitSystemFont(ofSize: 22, weight: .semibold)
    countLabel.textColor = .white
    countLabel.adjustsFontForContentSizeCategory = true
    instructionLabel.font = .preferredFont(forTextStyle: .body)
    instructionLabel.textColor = .white
    instructionLabel.numberOfLines = 0
    instructionLabel.adjustsFontForContentSizeCategory = true
    instructionLabel.text = Self.baseInstruction

    let textStack = UIStackView(arrangedSubviews: [countLabel, instructionLabel])
    textStack.axis = .vertical
    textStack.spacing = 4
    ringView.translatesAutoresizingMaskIntoConstraints = false
    let topRow = UIStackView(arrangedSubviews: [ringView, textStack])
    topRow.axis = .horizontal
    topRow.alignment = .center
    topRow.spacing = 16
    topRow.translatesAutoresizingMaskIntoConstraints = false
    panel.addSubview(topRow)

    configure(button: cancelButton, title: "Cancel", filled: false, action: #selector(cancelTapped))
    configure(button: doneButton, title: "Done", filled: true, action: #selector(doneTapped))
    let buttons = UIStackView(arrangedSubviews: [cancelButton, doneButton])
    buttons.axis = .horizontal
    buttons.distribution = .fillEqually
    buttons.spacing = 12
    buttons.translatesAutoresizingMaskIntoConstraints = false

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
      ringView.widthAnchor.constraint(equalToConstant: 64),
      ringView.heightAnchor.constraint(equalToConstant: 64),
      buttons.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 16),
      buttons.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -16),
      buttons.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -16),
      buttons.heightAnchor.constraint(greaterThanOrEqualToConstant: 52),
    ])
  }

  private func configure(button: UIButton, title: String, filled: Bool, action: Selector) {
    var config: UIButton.Configuration = filled ? .filled() : .gray()
    config.title = title
    config.cornerStyle = .medium
    config.baseBackgroundColor = filled ? .white : UIColor.black.withAlphaComponent(0.55)
    config.baseForegroundColor = filled ? .black : .white
    button.configuration = config
    button.addTarget(self, action: action, for: .touchUpInside)
  }

  private func refreshOverlay() {
    countLabel.text = "\(images.count) of \(Self.minPhotosForDone)+ photos, \(Int((coverage * 100).rounded()))% around"
    ringView.covered = coveredBuckets
    doneButton.isEnabled = canFinish && !finishRequested
    if images.count >= Self.maxPhotos {
      instructionLabel.text = canFinish
        ? "Photo limit reached. Tap Done."
        : "Photo limit reached without a full circle. Cancel and scan again."
    }
  }

  private func setInstruction(_ text: String) {
    guard images.count < Self.maxPhotos, instructionLabel.text != text else { return }
    instructionLabel.text = text
  }

  // MARK: - Helpers

  private static func deviceModel() -> String {
    var info = utsname()
    uname(&info)
    return withUnsafeBytes(of: &info.machine) { buffer in
      String(decoding: buffer.prefix { $0 != 0 }, as: UTF8.self)
    }
  }

  /// Same presentation root as CaptureSessionController (single-window app).
  private static func topViewController() -> UIViewController? {
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

/// Ring of equal arcs; covered segments drawn solid, the rest faint.
private final class CoverageRingView: UIView {
  private let segmentLayers: [CAShapeLayer]

  var covered = Set<Int>() {
    didSet { updateColors() }
  }

  init(segments: Int) {
    segmentLayers = (0..<segments).map { _ in CAShapeLayer() }
    super.init(frame: .zero)
    isAccessibilityElement = true
    accessibilityLabel = "Coverage around the leg"
    for layer in segmentLayers {
      layer.fillColor = UIColor.clear.cgColor
      layer.lineWidth = 6
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
    let radius = min(bounds.width, bounds.height) / 2 - 4
    let step = 2 * CGFloat.pi / CGFloat(segmentLayers.count)
    let gap = step * 0.15
    for (index, layer) in segmentLayers.enumerated() {
      let start = -CGFloat.pi / 2 + CGFloat(index) * step + gap / 2
      layer.frame = bounds
      layer.path = UIBezierPath(
        arcCenter: center, radius: radius, startAngle: start, endAngle: start + step - gap, clockwise: true
      ).cgPath
    }
  }

  private func updateColors() {
    for (index, layer) in segmentLayers.enumerated() {
      layer.strokeColor = covered.contains(index)
        ? UIColor.white.cgColor
        : UIColor.white.withAlphaComponent(0.25).cgColor
    }
    accessibilityValue = "\(Int((Double(covered.count) / Double(max(1, segmentLayers.count)) * 100).rounded())) percent"
  }
}
