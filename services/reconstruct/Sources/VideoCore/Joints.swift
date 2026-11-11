import Foundation

public let jointKeys = ["left_knee", "right_knee", "left_ankle", "right_ankle", "left_hip", "right_hip"]
public let minJointConfidence = 0.1

/// One Vision joint in Vision's normalized image space (origin bottom-left).
public struct RawJoint: Equatable {
    public let key: String
    public let x: Double
    public let y: Double
    public let confidence: Double

    public init(key: String, x: Double, y: Double, confidence: Double) {
        self.key = key
        self.x = x
        self.y = y
        self.confidence = confidence
    }
}

/// Joints of the body observation with the highest summed confidence over the
/// contract keys, as key -> [u, v, confidence] in written pixels (u = x W,
/// v = (1 - y) H). Only contract keys above minJointConfidence are kept.
public func pickJoints(_ observations: [[RawJoint]], width: Int, height: Int) -> [String: [Double]] {
    let filtered = observations.map { obs in
        obs.filter { jointKeys.contains($0.key) && $0.confidence > minJointConfidence && $0.x.isFinite && $0.y.isFinite }
    }
    var bestScore = 0.0
    var best: [RawJoint] = []
    for obs in filtered {
        let s = obs.reduce(0) { $0 + $1.confidence }
        if s > bestScore {
            bestScore = s
            best = obs
        }
    }
    var out: [String: [Double]] = [:]
    for j in best {
        out[j.key] = [
            roundTo(j.x * Double(width), 1),
            roundTo((1 - j.y) * Double(height), 1),
            roundTo(min(1, j.confidence), 3),
        ]
    }
    return out
}

public func roundTo(_ v: Double, _ places: Int) -> Double {
    let m = pow(10.0, Double(places))
    return (v * m).rounded() / m
}
