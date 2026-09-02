import ExpoModulesCore
import ModelIO
import RealityKit

/*
 Owns one PhotogrammetrySession run: feed it the captured images, request a
 .modelFile at the chosen detail level (produces USDZ), then convert that USDZ
 to OBJ with ModelIO so the Python measurement pipeline can consume it
 (CLAUDE.md gotcha 4: OBJ/PLY/GLB, not USDZ). Both files are kept in the
 sandbox and their absolute paths returned to JS.

 Progress is streamed to JS via the onProgress callback as a 0..1 fraction.
*/
@available(iOS 17.0, *)
final class ReconstructionController {
  private let onProgress: ([String: Any]) -> Void
  private var session: PhotogrammetrySession?
  private var task: Task<Void, Never>?

  init(onProgress: @escaping ([String: Any]) -> Void) {
    self.onProgress = onProgress
  }

  func run(options: ReconstructOptions, promise: Promise) {
    let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]

    // Resolve the images directory: explicit sessionDir/images, else the most
    // recently modified session under captures/.
    let imagesDir: URL
    if !options.sessionDir.isEmpty {
      imagesDir = URL(fileURLWithPath: options.sessionDir).appendingPathComponent("images", isDirectory: true)
    } else if let latest = Self.mostRecentSession(under: documents.appendingPathComponent("captures", isDirectory: true)) {
      imagesDir = latest.appendingPathComponent("images", isDirectory: true)
    } else {
      promise.reject(CaptureNoImagesException())
      return
    }

    let sessionRoot = imagesDir.deletingLastPathComponent()
    let sessionId = sessionRoot.lastPathComponent
    let usdzURL = sessionRoot.appendingPathComponent("model.usdz")
    let objURL = sessionRoot.appendingPathComponent("model.obj")

    // iOS ships exactly one detail level: PhotogrammetrySession.Request.Detail
    // has only `.reduced` (RealityFoundation.swiftinterface, iOS 26.5 SDK);
    // medium/full/raw are macOS-only. That is why TS DetailLevel is 'reduced'
    // alone and options.detail is not consulted here.
    let detail = PhotogrammetrySession.Request.Detail.reduced
    let detailName = "reduced"

    do {
      // UNVERIFIED: PhotogrammetrySession initializer. On iOS the input is a
      // directory of images. Confirm whether a Configuration (sample ordering,
      // feature sensitivity, checkpointDirectory to resume from the capture's
      // checkpoint) is needed here.
      let session = try PhotogrammetrySession(input: imagesDir)
      self.session = session

      // Count inputs so we can report imageCount and fail early if empty.
      let imageCount = (try? FileManager.default.contentsOfDirectory(atPath: imagesDir.path).count) ?? 0
      guard imageCount > 0 else {
        promise.reject(CaptureNoImagesException())
        return
      }

      // Drive outputs and process concurrently. PhotogrammetrySession exposes
      // an async `outputs` sequence and a `process(requests:)` method.
      task = Task { [weak self] in
        guard let self else { return }
        do {
          try session.process(requests: [.modelFile(url: usdzURL, detail: detail)])
        } catch {
          promise.reject(ReconstructionFailedException(error.localizedDescription))
          return
        }

        // PhotogrammetrySession.Outputs is a throwing AsyncSequence, so a
        // stream failure has to be caught here rather than ending the loop
        // silently and leaving the JS promise pending forever.
        do {
          for try await output in session.outputs {
            switch output {
            case .requestProgress(_, let fraction):
              self.onProgress(["fraction": fraction, "stage": "processing"])
            case .processingComplete:
              self.onProgress(["fraction": 1.0, "stage": "complete"])
              do {
                try self.convertUSDZToOBJ(usdz: usdzURL, obj: objURL)
              } catch {
                promise.reject(ExportFailedException(error.localizedDescription))
                return
              }
              promise.resolve([
                "sessionId": sessionId,
                "usdzPath": usdzURL.path,
                "objPath": objURL.path,
                // The level actually used, not the one requested: iOS exposes
                // only .reduced (see detailLevel).
                "detail": detailName,
                "imageCount": imageCount,
              ])
              return
            case .requestError(_, let error):
              promise.reject(ReconstructionFailedException(error.localizedDescription))
              return
            case .processingCancelled:
              promise.reject(CaptureCancelledException())
              return
            default:
              break
            }
          }
          // The stream ended without a terminal output: nothing else will
          // settle the promise, so fail rather than hang.
          promise.reject(ReconstructionFailedException("reconstruction ended without producing a model"))
        } catch {
          promise.reject(ReconstructionFailedException(error.localizedDescription))
        }
      }
    } catch {
      promise.reject(ReconstructionFailedException(error.localizedDescription))
    }
  }

  func cancel() {
    session?.cancel()
    task?.cancel()
  }

  /// Convert a USDZ to OBJ using ModelIO.
  ///
  /// UNVERIFIED: MDLAsset can load USDZ and export OBJ on-device. OBJ is a
  /// supported MDLAsset export type via canExportFileExtension("obj"). Confirm
  /// on-device; some USD features may not round-trip. If OBJ export is
  /// unreliable, PLY is the fallback (the pipeline accepts OBJ/PLY/GLB).
  private func convertUSDZToOBJ(usdz: URL, obj: URL) throws {
    guard MDLAsset.canExportFileExtension("obj") else {
      throw ExportFailedException("ModelIO cannot export OBJ on this OS")
    }
    let asset = MDLAsset(url: usdz)
    try asset.export(to: obj)
  }

  /// Most recently modified subdirectory of `captures/`.
  private static func mostRecentSession(under root: URL) -> URL? {
    let fm = FileManager.default
    guard
      let entries = try? fm.contentsOfDirectory(
        at: root,
        includingPropertiesForKeys: [.contentModificationDateKey],
        options: [.skipsHiddenFiles]
      )
    else { return nil }

    return entries
      .filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true }
      .max { lhs, rhs in
        let lDate = (try? lhs.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
        let rDate = (try? rhs.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
        return lDate < rDate
      }
  }
}
