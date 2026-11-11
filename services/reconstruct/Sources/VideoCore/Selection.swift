import Foundation

public struct FrameScore: Equatable {
    public let time: Double
    public let sharpness: Double
    public let motion: Double?

    public init(time: Double, sharpness: Double, motion: Double?) {
        self.time = time
        self.sharpness = sharpness
        self.motion = motion
    }
}

/// Window count N = min(maxFrames, decoded / 3) (docs/VIDEO-HARNESS.md).
public func windowCount(decoded: Int, maxFrames: Int) -> Int { max(0, min(maxFrames, decoded / 3)) }

/// Indices (into scores, ascending, so time order for a decode-order list) of the
/// sharpest frame in each of N equal time windows over [0, duration). Ties go to
/// lower motion; unknown motion (the first decoded frame) loses every tie; then
/// the earlier frame. A window with no frame (variable frame rate) yields none,
/// so the result can be shorter than N.
public func selectFrames(_ scores: [FrameScore], duration: Double, maxFrames: Int) -> [Int] {
    let n = windowCount(decoded: scores.count, maxFrames: maxFrames)
    guard n > 0 else { return [] }
    let span = duration > 0 ? duration : (scores.map(\.time).max() ?? 0) + 1e-6
    var best = [Int?](repeating: nil, count: n)
    for (i, s) in scores.enumerated() {
        let raw = (s.time / span * Double(n)).rounded(.down)
        let k = raw.isFinite ? min(n - 1, max(0, Int(raw))) : 0
        guard let j = best[k] else {
            best[k] = i
            continue
        }
        if better(s, than: scores[j]) { best[k] = i }
    }
    return best.compactMap { $0 }.sorted()
}

func better(_ a: FrameScore, than b: FrameScore) -> Bool {
    if a.sharpness != b.sharpness { return a.sharpness > b.sharpness }
    let ma = a.motion ?? .infinity, mb = b.motion ?? .infinity
    if ma != mb { return ma < mb }
    return a.time < b.time
}
