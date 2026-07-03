import ExpoModulesCore

/*
 Typed exceptions for the capture module.

 These map to the CaptureErrorCode union on the JS side (see
 modules/zells-capture/src/errors.ts). expo-modules-core surfaces a thrown
 `Exception` to JS as a rejected promise carrying `.code` and `.message`; the JS
 `mapNativeError` reads `.code` and expects one of the stable ERR_* strings
 below.

 UNVERIFIED: that overriding `code` on an Expo `Exception` actually sets the
 `.code` string received in JS. Some Expo versions derive the code from the
 class name instead. If the codes do not come through, mapNativeError has a
 keyword fallback (it inspects both code and message), so classification still
 works. Confirm the exact JS-visible `.code` for one thrown error on-device and
 delete this note.
*/

internal final class CaptureUnsupportedException: Exception {
  override var code: String { "ERR_CAPTURE_UNSUPPORTED_DEVICE" }
  override var reason: String {
    "This device does not support ObjectCaptureSession (requires a LiDAR iPhone on iOS 17+)."
  }
}

internal final class CaptureCancelledException: Exception {
  override var code: String { "ERR_CAPTURE_CANCELLED" }
  override var reason: String { "The capture session was cancelled." }
}

internal final class CaptureNoImagesException: Exception {
  override var code: String { "ERR_CAPTURE_NO_IMAGES" }
  override var reason: String { "Capture produced too few usable images to reconstruct." }
}

internal final class ReconstructionFailedException: GenericException<String> {
  override var code: String { "ERR_RECONSTRUCTION_FAILED" }
  override var reason: String { "Reconstruction failed: \(param)" }
}

internal final class ExportFailedException: GenericException<String> {
  override var code: String { "ERR_EXPORT_FAILED" }
  override var reason: String { "USDZ to OBJ export failed: \(param)" }
}

internal final class CaptureUnknownException: GenericException<String> {
  override var code: String { "ERR_CAPTURE_UNKNOWN" }
  override var reason: String { "Capture failed: \(param)" }
}
