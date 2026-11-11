import Foundation

public struct Options: Equatable {
    public var video: String
    public var out: String
    public var maxFrames = 60
    public var maxSide = 1920
    public var model = true
    public var photogrammetry = true
    public var timeoutS = 1800.0

    public init(video: String, out: String) {
        self.video = video
        self.out = out
    }
}

/// Bounds mirror the Python bundle caps (docs/VIDEO-HARNESS.md): at most 200
/// frames, frame side at most 4096 px. The floor on max-side keeps Vision and
/// photogrammetry inputs above the size where either is meaningful.
public enum Limits {
    public static let maxFramesCap = 200
    public static let maxSideCap = 4096
    public static let maxSideFloor = 256
    public static let minKeptFrames = 10
    public static let maxPoints = 2_000_000
    public static let maxManifestBytes = 4 * 1024 * 1024
    /// Untrusted-input caps on the source video, checked before decoding.
    public static let maxDurationS = 600.0
    public static let maxSourceSide = 8192
}

/// Error reasons are fixed strings: user-supplied values (which may be paths)
/// are never echoed back.
public func parseOptions(_ argv: [String]) -> Result<Options, ArgError> {
    var video: String?
    var out: String?
    var maxFrames = 60
    var maxSide = 1920
    var model = true
    var photogrammetry = true
    var timeoutS = 1800.0

    var it = argv.makeIterator()
    while let flag = it.next() {
        switch flag {
        case "--no-model": model = false
        case "--no-photogrammetry": photogrammetry = false
        case "--video", "--out", "--max-frames", "--max-side", "--timeout-s":
            guard let value = it.next() else { return .failure(ArgError("missing value for a flag")) }
            switch flag {
            case "--video": video = value
            case "--out": out = value
            case "--max-frames":
                guard let n = Int(value), n >= Limits.minKeptFrames, n <= Limits.maxFramesCap else {
                    return .failure(ArgError("max-frames must be an integer in 10...200"))
                }
                maxFrames = n
            case "--max-side":
                guard let n = Int(value), n >= Limits.maxSideFloor, n <= Limits.maxSideCap else {
                    return .failure(ArgError("max-side must be an integer in 256...4096"))
                }
                maxSide = n
            default:
                guard let t = Double(value), t.isFinite, t > 0 else {
                    return .failure(ArgError("timeout-s must be a positive number"))
                }
                timeoutS = t
            }
        default: return .failure(ArgError("unknown flag"))
        }
    }
    guard let video, !video.isEmpty, let out, !out.isEmpty else {
        return .failure(ArgError("--video and --out are required"))
    }
    var o = Options(video: video, out: out)
    o.maxFrames = maxFrames
    o.maxSide = maxSide
    o.model = model
    o.photogrammetry = photogrammetry
    o.timeoutS = timeoutS
    return .success(o)
}

public struct ArgError: Error, Equatable {
    public let reason: String
    public init(_ reason: String) { self.reason = reason }
}
