import ExpoModulesCore
import RealityKit

/*
 ZellsCapture native module.

 Wraps Apple's guided object capture (ObjectCaptureSession) and on-device
 photogrammetry (PhotogrammetrySession), both RealityKit APIs available on
 iOS 17+ LiDAR iPhones. See docs/DESIGN.md section 5 and CLAUDE.md gotcha 3/4.

 Responsibilities:
   - isSupported(): the app's authoritative LiDAR/OS check.
   - startCapture(): present the SwiftUI guided flow, collect images into the
     app sandbox, resolve with the session directory.
   - reconstruct(): PhotogrammetrySession -> USDZ, then ModelIO USDZ -> OBJ
     (the Python pipeline consumes OBJ, not USDZ). Keep both files.
   - cancel(): tear down whichever session is in flight.
   - Emits 'onCaptureStateChange' and 'onReconstructionProgress' events.

 This file is intentionally thin: the session lifecycles live in
 CaptureSessionController and ReconstructionController. Everything that touches
 UIKit/SwiftUI presentation must run on the main actor.

 Compiles against the iOS 26.5 SDK (checked 2026-09-02). Runtime behavior on a
 physical LiDAR iPhone is still unverified: no device build has run yet, and the
 Simulator cannot exercise capture (ObjectCaptureSession.isSupported is false
 there). Remaining runtime risks are flagged inline.
*/
public class ZellsCaptureModule: Module {
  // Retained across the async call so cancel() can reach an in-flight session.
  private var captureController: CaptureSessionController?
  private var reconstructionController: ReconstructionController?

  public func definition() -> ModuleDefinition {
    Name("ZellsCapture")

    // Event names must match modules/zells-capture/src/types.ts CaptureEventsMap.
    Events("onCaptureStateChange", "onReconstructionProgress")

    // ObjectCaptureSession.isSupported is main-actor isolated (RealityKit
    // _RealityKit_SwiftUI.swiftinterface), so this cannot be a synchronous
    // Function: Expo runs those on the JS thread. The JS wrapper awaits it.
    AsyncFunction("isSupported") { () async -> Bool in
      if #available(iOS 17.0, *) {
        return await MainActor.run { ObjectCaptureSession.isSupported }
      }
      return false
    }

    // Present the guided capture flow and collect images.
    //
    // UNVERIFIED: presenting a SwiftUI ObjectCaptureView from an Expo module.
    // We reach the key window's root view controller and present a hosting
    // controller. Confirm this is the right controller to present from inside
    // an Expo Router / React Native screen, and that dismissal is handled.
    AsyncFunction("startCapture") { (promise: Promise) in
      guard #available(iOS 17.0, *) else {
        promise.reject(CaptureUnsupportedException())
        return
      }

      // The session, its state stream, and the presentation all live on the
      // main actor, so the whole setup runs there rather than hopping per call.
      Task { @MainActor [weak self] in
        guard let self else { return }
        guard ObjectCaptureSession.isSupported else {
          promise.reject(CaptureUnsupportedException())
          return
        }
        let controller = CaptureSessionController(
          onStateChange: { [weak self] event in
            self?.sendEvent("onCaptureStateChange", event)
          }
        )
        self.captureController = controller
        controller.start(promise: promise)
      }
    }

    // Run photogrammetry and export OBJ.
    AsyncFunction("reconstruct") { (options: ReconstructOptions, promise: Promise) in
      guard #available(iOS 17.0, *) else {
        promise.reject(CaptureUnsupportedException())
        return
      }

      let controller = ReconstructionController(
        onProgress: { [weak self] event in
          self?.sendEvent("onReconstructionProgress", event)
        }
      )
      self.reconstructionController = controller
      controller.run(options: options, promise: promise)
    }

    // Cancel whichever session is active. The capture controller is main-actor
    // isolated (it owns UI); the reconstruction controller is not.
    AsyncFunction("cancel") { () in
      self.reconstructionController?.cancel()
      self.reconstructionController = nil
      Task { @MainActor [weak self] in
        guard let self else { return }
        self.captureController?.cancel()
        self.captureController = nil
      }
    }
  }
}
