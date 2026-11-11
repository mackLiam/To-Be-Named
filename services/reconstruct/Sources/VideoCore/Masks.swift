import Foundation

/// Bilinear resample (pixel-centre aligned, edge clamped) of a soft mask to
/// exactly dw x dh, thresholded to 0 or 255 (value >= threshold is 255).
public func upscaleThreshold(
    _ src: [Float], width sw: Int, height sh: Int, toWidth dw: Int, height dh: Int, threshold: Float = 0.5
) -> [UInt8] {
    precondition(src.count == sw * sh && sw > 0 && sh > 0 && dw > 0 && dh > 0)
    func axis(_ d: Int, _ s: Int) -> ([Int], [Int], [Float]) {
        var i0 = [Int](repeating: 0, count: d), i1 = i0
        var t = [Float](repeating: 0, count: d)
        let scale = Double(s) / Double(d)
        for i in 0..<d {
            let p = min(Double(s - 1), max(0, (Double(i) + 0.5) * scale - 0.5))
            let f = Int(p.rounded(.down))
            i0[i] = f
            i1[i] = min(s - 1, f + 1)
            t[i] = Float(p - Double(f))
        }
        return (i0, i1, t)
    }
    let (x0, x1, tx) = axis(dw, sw)
    let (y0, y1, ty) = axis(dh, sh)
    var out = [UInt8](repeating: 0, count: dw * dh)
    src.withUnsafeBufferPointer { s in
        for y in 0..<dh {
            let ra = y0[y] * sw, rb = y1[y] * sw, wy = ty[y]
            for x in 0..<dw {
                let top = s[ra + x0[x]] + (s[ra + x1[x]] - s[ra + x0[x]]) * tx[x]
                let bot = s[rb + x0[x]] + (s[rb + x1[x]] - s[rb + x0[x]]) * tx[x]
                out[y * dw + x] = top + (bot - top) * wy >= threshold ? 255 : 0
            }
        }
    }
    return out
}

/// Thresholds a mask that is already at frame size.
public func threshold(_ src: [Float], _ t: Float = 0.5) -> [UInt8] { src.map { $0 >= t ? 255 : 0 } }

public func areaFraction(_ mask: [UInt8]) -> Double {
    guard !mask.isEmpty else { return 0 }
    var n = 0
    for v in mask where v != 0 { n += 1 }
    return Double(n) / Double(mask.count)
}

/// Foreground instances to keep, given Vision's instance label map (0 is
/// background) and the person mask at any resolution (sampled nearest at label
/// pixel centres). Keeps the instance with the largest person overlap plus every
/// instance lying mostly (at least half its area) inside the person. With no person
/// mask, an empty one, or no overlap at all, keeps every instance.
public func chooseInstances(
    labels: [UInt8], width lw: Int, height lh: Int,
    person: [UInt8]?, personWidth pw: Int, personHeight ph: Int,
    all: [Int]
) -> [Int] {
    let all = all.sorted()
    guard let person, pw > 0, ph > 0, person.count == pw * ph, labels.count == lw * lh, !all.isEmpty else {
        return all
    }
    var area = [Int](repeating: 0, count: 256)
    var overlap = [Int](repeating: 0, count: 256)
    for y in 0..<lh {
        let py = min(ph - 1, Int((Double(y) + 0.5) * Double(ph) / Double(lh)))
        for x in 0..<lw {
            let l = Int(labels[y * lw + x])
            guard l != 0 else { continue }
            area[l] += 1
            let px = min(pw - 1, Int((Double(x) + 0.5) * Double(pw) / Double(lw)))
            if person[py * pw + px] != 0 { overlap[l] += 1 }
        }
    }
    let candidates = all.filter { $0 > 0 && $0 < 256 }
    guard let top = candidates.max(by: { (overlap[$0], -$0) < (overlap[$1], -$1) }), overlap[top] > 0 else {
        return all
    }
    return candidates.filter { $0 == top || (area[$0] > 0 && 2 * overlap[$0] >= area[$0]) }
}
