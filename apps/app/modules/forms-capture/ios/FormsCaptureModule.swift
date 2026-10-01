import ARKit
import ExpoModulesCore
import RealityKit

/*
 FormsCapture native module.

 Wraps Apple's guided object capture (ObjectCaptureSession) and on-device
 photogrammetry (PhotogrammetrySession), both RealityKit APIs available on
 iOS 17+ LiDAR iPhones. See docs/DESIGN.md section 5 and CLAUDE.md gotcha 3/4.

 Responsibilities:
   - isSupported(): the app's authoritative LiDAR/OS check.
   - startCapture(): present the SwiftUI guided flow, collect images into the
     app sandbox, resolve with the session directory.
   - reconstruct(): PhotogrammetrySession -> USDZ, then ModelIO USDZ -> OBJ
     (the Python pipeline consumes OBJ, not USDZ). Keep both files.
   - isPhotoCaptureSupported() / startPhotoCapture(): guided ARKit photo
     capture for iPhones without ObjectCaptureSession; the bundle is
     reconstructed server-side (PhotoCaptureController).
   - startSilhouetteCapture(): solo still-photo capture at five stations with
     on-device Vision leg masks (SilhouetteCaptureController).
   - cancel(): tear down whichever session is in flight.
   - Emits 'onCaptureStateChange', 'onReconstructionProgress' and, during
     photo capture, 'onPhotoCaptureStats' (scalars only, once a second).

 This file is intentionally thin: the session lifecycles live in
 CaptureSessionController and ReconstructionController. Everything that touches
 UIKit/SwiftUI presentation must run on the main actor.

 Compiles against the iOS 26.5 SDK (checked 2026-09-02). Runtime behavior on a
 physical LiDAR iPhone is still unverified: no device build has run yet, and the
 Simulator cannot exercise capture (ObjectCaptureSession.isSupported is false
 there). Remaining runtime risks are flagged inline.
*/
public class FormsCaptureModule: Module {
  // Retained across the async call so cancel() can reach an in-flight session.
  private var captureController: CaptureSessionController?
  private var reconstructionController: ReconstructionController?
  private var photoController: PhotoCaptureController?
  private var silhouetteController: SilhouetteCaptureController?

  public func definition() -> ModuleDefinition {
    Name("FormsCapture")

    // Event names must match modules/forms-capture/src/types.ts CaptureEventsMap.
    Events("onCaptureStateChange", "onReconstructionProgress", "onPhotoCaptureStats", "onSilhouetteStats")

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

    // Any ARKit world-tracking device (no LiDAR needed). Read on the main actor
    // for the same reason as isSupported.
    AsyncFunction("isPhotoCaptureSupported") { () async -> Bool in
      await MainActor.run { ARWorldTrackingConfiguration.isSupported }
    }

    // Present guided photo capture; resolves with the bundle on Done.
    AsyncFunction("startPhotoCapture") { (options: PhotoCaptureOptions, promise: Promise) in
      // Unknown strings fall back to solo, the lower bar: never a dead end.
      let mode = PhotoCaptureMode(rawValue: options.mode) ?? .solo
      Task { @MainActor [weak self] in
        guard let self else { return }
        guard ARWorldTrackingConfiguration.isSupported else {
          promise.reject(CaptureUnsupportedException())
          return
        }
        let controller = PhotoCaptureController(
          mode: mode,
          onStats: { [weak self] stats in
            self?.sendEvent("onPhotoCaptureStats", stats)
          }
        )
        self.photoController = controller
        controller.start(promise: promise)
      }
    }

    // Present solo silhouette capture; resolves with the v2 bundle on Done.
    AsyncFunction("startSilhouetteCapture") { (options: SilhouetteCaptureOptions, promise: Promise) in
      guard let leg = SilhouetteLeg(rawValue: options.leg) else {
        promise.reject(CaptureUnknownException("leg must be L or R"))
        return
      }
      Task { @MainActor [weak self] in
        guard let self else { return }
        guard ARWorldTrackingConfiguration.isSupported else {
          promise.reject(CaptureUnsupportedException())
          return
        }
        let controller = SilhouetteCaptureController(
          leg: leg,
          onStats: { [weak self] stats in
            self?.sendEvent("onSilhouetteStats", stats)
          }
        )
        self.silhouetteController = controller
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
        self.photoController?.cancel()
        self.photoController = nil
        self.silhouetteController?.cancel()
        self.silhouetteController = nil
      }
    }
  }
}
