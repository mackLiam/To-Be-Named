import ExpoModulesCore
import RealityKit
import SwiftUI

/*
 Owns one guided ObjectCaptureSession lifecycle: create the session, point it
 at a fresh session directory inside the app sandbox, present the SwiftUI
 ObjectCaptureView, and resolve the JS promise with the collected images once
 the user finishes (or reject if they cancel).

 Sandbox rule (CLAUDE.md gotcha 5): all files live under the app's Documents
 directory. Nothing is written to shared/App Group/temporary-public locations.
*/
@available(iOS 17.0, *)
final class CaptureSessionController: NSObject {
  private let onStateChange: ([String: Any]) -> Void
  private var session: ObjectCaptureSession?
  private var hostingController: UIViewController?
  private var promise: Promise?
  private let sessionId: String
  private let sessionDir: URL
  private let imagesDir: URL

  init(onStateChange: @escaping ([String: Any]) -> Void) {
    self.onStateChange = onStateChange
    self.sessionId = UUID().uuidString
    // Per-session folder under Documents. UNVERIFIED: confirm Documents is the
    // right sandbox root vs. Application Support; Documents is user-visible in
    // Files if UIFileSharingEnabled is set (it is not, so this is fine), but
    // Application Support is the more conventional home for app-managed data.
    let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    self.sessionDir = documents.appendingPathComponent("captures/\(sessionId)", isDirectory: true)
    self.imagesDir = sessionDir.appendingPathComponent("images", isDirectory: true)
    super.init()
  }

  /// Create the session and present the guided capture UI.
  @MainActor
  func start(promise: Promise) {
    self.promise = promise

    do {
      try FileManager.default.createDirectory(at: imagesDir, withIntermediateDirectories: true)
    } catch {
      promise.reject(CaptureUnknownException("could not create session directory: \(error.localizedDescription)"))
      return
    }

    let session = ObjectCaptureSession()
    self.session = session
    emit(state: "initializing")

    // UNVERIFIED: ObjectCaptureSession.Configuration options (checkpoint
    // directory, bounding box, over-capture). We start with defaults and only
    // set the images output. Confirm whether a checkpointDirectory is required
    // for PhotogrammetrySession to resume, and whether we want it.
    var configuration = ObjectCaptureSession.Configuration()
    configuration.checkpointDirectory = sessionDir.appendingPathComponent("checkpoint", isDirectory: true)
    session.start(imagesDirectory: imagesDir, configuration: configuration)

    // UNVERIFIED: observing session state. ObjectCaptureSession exposes an
    // async `stateUpdates` sequence (and `userCompletedScanPassUpdates`, etc.).
    // Wire a Task that maps Apple's CaptureState cases onto our string states
    // and detects completion/cancellation to resolve/reject the promise. The
    // mapping below is a sketch; verify the exact enum cases on-device.
    observeState(session)

    presentCaptureView(for: session)
  }

  @available(iOS 17.0, *)
  private func observeState(_ session: ObjectCaptureSession) {
    Task { [weak self] in
      guard let self else { return }
      for await state in session.stateUpdates {
        // UNVERIFIED: exact CaptureState case names. Adjust to the SDK.
        switch state {
        case .initializing:
          self.emit(state: "initializing")
        case .ready:
          self.emit(state: "ready")
        case .detecting:
          self.emit(state: "detecting")
        case .capturing:
          self.emit(state: "capturing")
        case .finishing:
          self.emit(state: "finishing")
        case .completed:
          self.emit(state: "completed")
          await self.finish(success: true)
        case .failed:
          self.emit(state: "failed")
          await self.finish(success: false)
        @unknown default:
          break
        }
      }
    }
  }

  @MainActor
  private func presentCaptureView(for session: ObjectCaptureSession) {
    // UNVERIFIED: hosting a SwiftUI ObjectCaptureView from RN. We wrap it in a
    // UIHostingController and present it modally over the key window's root VC.
    // Confirm this presents correctly above the React Native view hierarchy and
    // that we add our own "Done"/"Cancel" affordances (ObjectCaptureView does
    // not ship navigation chrome).
    let captureView = ObjectCaptureView(session: session)
    let hosting = UIHostingController(rootView: captureView)
    hosting.modalPresentationStyle = .fullScreen
    self.hostingController = hosting

    guard let root = Self.topViewController() else {
      promise?.reject(CaptureUnknownException("no view controller available to present capture UI"))
      return
    }
    root.present(hosting, animated: true)
  }

  /// Resolve or reject the JS promise and tear down the UI.
  @MainActor
  private func finish(success: Bool) async {
    await dismiss()

    guard let promise else { return }
    self.promise = nil

    if !success {
      promise.reject(CaptureUnknownException("capture session entered a failed state"))
      return
    }

    let imageCount = (try? FileManager.default.contentsOfDirectory(atPath: imagesDir.path).count) ?? 0
    // A handful of images is not enough for a usable reconstruction. The exact
    // floor is a tuning value; PhotogrammetrySession itself wants dozens.
    // UNVERIFIED: pick a real minimum with the reconstruction step.
    if imageCount < 10 {
      promise.reject(CaptureNoImagesException())
      return
    }

    promise.resolve([
      "sessionId": sessionId,
      "imageDir": imagesDir.path,
      "imageCount": imageCount,
    ])
  }

  func cancel() {
    session?.cancel()
    Task { @MainActor [weak self] in
      guard let self else { return }
      await self.dismiss()
      self.promise?.reject(CaptureCancelledException())
      self.promise = nil
    }
  }

  @MainActor
  private func dismiss() async {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      guard let hosting = hostingController else {
        continuation.resume()
        return
      }
      hosting.dismiss(animated: true) {
        continuation.resume()
      }
    }
    hostingController = nil
  }

  private func emit(state: String) {
    onStateChange(["state": state])
  }

  /// Walk from the key window's root to the top-most presented controller.
  /// UNVERIFIED: multi-scene handling. Fine for a single-window app; revisit if
  /// the app ever supports multiple UIWindowScenes.
  @MainActor
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
