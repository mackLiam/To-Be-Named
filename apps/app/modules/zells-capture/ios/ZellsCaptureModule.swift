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

 UNVERIFIED (whole file): Swift cannot be compiled in this scaffold environment
 (no EAS build yet). Treat every API call as best-effort until it is built and
 run on a physical LiDAR iPhone. Individual risk points are flagged inline.
*/
public class ZellsCaptureModule: Module {
  // Retained across the async call so cancel() can reach an in-flight session.
  private var captureController: CaptureSessionController?
  private var reconstructionController: ReconstructionController?

  public func definition() -> ModuleDefinition {
    Name("ZellsCapture")

    // Event names must match modules/zells-capture/src/types.ts CaptureEventsMap.
    Events("onCaptureStateChange", "onReconstructionProgress")

    // Synchronous check. JS treats this as the LiDAR truth source.
    Function("isSupported") { () -> Bool in
      if #available(iOS 17.0, *) {
        return ObjectCaptureSession.isSupported
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
      guard #available(iOS 17.0, *), ObjectCaptureSession.isSupported else {
        promise.reject(CaptureUnsupportedException())
        return
      }

      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
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

    // Cancel whichever session is active.
    AsyncFunction("cancel") { () in
      self.captureController?.cancel()
      self.reconstructionController?.cancel()
      self.captureController = nil
      self.reconstructionController = nil
    }
  }
}
