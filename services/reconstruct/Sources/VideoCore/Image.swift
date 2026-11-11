import Foundation

/// Size after scaling so the long side is at most maxSide; never upscales.
public func scaledSize(width: Int, height: Int, maxSide: Int) -> (width: Int, height: Int) {
    let long = max(width, height)
    guard long > maxSide, long > 0 else { return (width, height) }
    let s = Double(maxSide) / Double(long)
    return (max(1, Int((Double(width) * s).rounded())), max(1, Int((Double(height) * s).rounded())))
}

/// EXIF orientation (CGImagePropertyOrientation raw value, 1...8) that makes the
/// stored frame upright, from a track preferredTransform's linear part. AVFoundation
/// transforms are in top-left, y-down coordinates: (x, y) -> (a x + c y, b x + d y).
/// Returns nil for anything that is not a right-angle rotation or flip.
public func orientationForTransform(a: Double, b: Double, c: Double, d: Double) -> UInt32? {
    func r(_ v: Double) -> Int? {
        let n = v.rounded()
        guard abs(v - n) < 1e-3, abs(n) <= 1 else { return nil }
        return Int(n)
    }
    guard let a = r(a), let b = r(b), let c = r(c), let d = r(d) else { return nil }
    switch (a, b, c, d) {
    case (1, 0, 0, 1): return 1
    case (-1, 0, 0, 1): return 2
    case (-1, 0, 0, -1): return 3
    case (1, 0, 0, -1): return 4
    case (0, 1, 1, 0): return 5
    case (0, 1, -1, 0): return 6
    case (0, -1, -1, 0): return 7
    case (0, -1, 1, 0): return 8
    default: return nil
    }
}

/// Orientations 5...8 swap width and height.
public func orientationSwapsAxes(_ exif: UInt32) -> Bool { exif >= 5 && exif <= 8 }

public struct GrayImage: Equatable {
    public let width: Int
    public let height: Int
    public var pixels: [Float]

    public init(width: Int, height: Int, pixels: [Float]) {
        precondition(pixels.count == width * height)
        self.width = width
        self.height = height
        self.pixels = pixels
    }
}

/// Box-averaged Rec. 601 luma from a BGRA buffer, long side at most maxSide.
/// Values are 0...255. Orientation is ignored: sharpness and motion magnitude
/// are invariant to the right-angle rotations and flips a track can carry.
public func grayDownsample(
    bgra: UnsafeRawPointer, width: Int, height: Int, bytesPerRow: Int, maxSide: Int
) -> GrayImage {
    let (dw, dh) = scaledSize(width: width, height: height, maxSide: maxSide)
    var acc = [Float](repeating: 0, count: dw * dh)
    var cnt = [Float](repeating: 0, count: dw * dh)
    let xmap = (0..<width).map { $0 * dw / width }
    let base = bgra.assumingMemoryBound(to: UInt8.self)
    for y in 0..<height {
        let row = base + y * bytesPerRow
        let drow = (y * dh / height) * dw
        for x in 0..<width {
            let p = row + 4 * x
            let lum = 0.114 * Float(p[0]) + 0.587 * Float(p[1]) + 0.299 * Float(p[2])
            acc[drow + xmap[x]] += lum
            cnt[drow + xmap[x]] += 1
        }
    }
    for i in 0..<acc.count where cnt[i] > 0 { acc[i] /= cnt[i] }
    return GrayImage(width: dw, height: dh, pixels: acc)
}

/// Population variance of the 4-neighbour 3x3 Laplacian over interior pixels.
public func laplacianVariance(_ g: GrayImage) -> Double {
    let w = g.width, h = g.height
    guard w >= 3, h >= 3 else { return 0 }
    var sum = 0.0, sumSq = 0.0
    g.pixels.withUnsafeBufferPointer { p in
        for y in 1..<(h - 1) {
            let r = y * w
            for x in 1..<(w - 1) {
                let i = r + x
                let l = Double(p[i - 1] + p[i + 1] + p[i - w] + p[i + w] - 4 * p[i])
                sum += l
                sumSq += l * l
            }
        }
    }
    let n = Double((w - 2) * (h - 2))
    let mean = sum / n
    return max(0, sumSq / n - mean * mean)
}

func halve(_ g: GrayImage) -> GrayImage {
    let w = g.width / 2, h = g.height / 2
    var out = [Float](repeating: 0, count: w * h)
    for y in 0..<h {
        for x in 0..<w {
            let i = 2 * y * g.width + 2 * x
            out[y * w + x] = 0.25 * (g.pixels[i] + g.pixels[i + 1] + g.pixels[i + g.width] + g.pixels[i + g.width + 1])
        }
    }
    return GrayImage(width: w, height: h, pixels: out)
}

/// Mean absolute difference between cur(x, y) and prev(x - ox, y - oy) over the overlap.
func meanAbsDiff(_ prev: GrayImage, _ cur: GrayImage, _ ox: Int, _ oy: Int) -> Double {
    let w = cur.width, h = cur.height
    let x0 = max(0, ox), x1 = min(w, w + ox)
    let y0 = max(0, oy), y1 = min(h, h + oy)
    guard x1 > x0, y1 > y0 else { return .infinity }
    var s: Float = 0
    prev.pixels.withUnsafeBufferPointer { pp in
        cur.pixels.withUnsafeBufferPointer { cp in
            for y in y0..<y1 {
                let cr = y * w, pr = (y - oy) * w - ox
                var rs: Float = 0
                for x in x0..<x1 { rs += abs(cp[cr + x] - pp[pr + x]) }
                s += rs
            }
        }
    }
    return Double(s) / Double((x1 - x0) * (y1 - y0))
}

/// Global translation (dx, dy) in cur's pixels such that cur(x, y) ~ prev(x - dx, y - dy).
/// Coarse-to-fine block matching over a 2x pyramid; the coarsest level is searched
/// exhaustively within a quarter of its short side (so the overlap never drops
/// below half), finer levels refine by 2 px, and the finest gets a parabolic
/// sub-pixel fit. Both images must have the same size.
public func estimateTranslation(_ prev: GrayImage, _ cur: GrayImage) -> (dx: Double, dy: Double) {
    precondition(prev.width == cur.width && prev.height == cur.height)
    var levels = [(prev, cur)]
    while levels.count < 3, min(levels.last!.0.width, levels.last!.0.height) >= 64 {
        levels.append((halve(levels.last!.0), halve(levels.last!.1)))
    }
    var bx = 0, by = 0
    for (li, (p, c)) in levels.enumerated().reversed() {
        let coarsest = li == levels.count - 1
        let limit = max(1, min(p.width, p.height) / 4)
        let radius = coarsest ? min(limit, 12) : 2
        let cx = coarsest ? 0 : 2 * bx, cy = coarsest ? 0 : 2 * by
        var best = Double.infinity
        for oy in (cy - radius)...(cy + radius) where abs(oy) <= limit {
            for ox in (cx - radius)...(cx + radius) where abs(ox) <= limit {
                let e = meanAbsDiff(p, c, ox, oy)
                // Ties prefer the smaller shift so a flat image reports zero motion.
                if e < best || (e == best && ox * ox + oy * oy < bx * bx + by * by) {
                    best = e
                    bx = ox
                    by = oy
                }
            }
        }
    }
    let (p, c) = levels[0]
    func refine(_ em: Double, _ e0: Double, _ ep: Double) -> Double {
        let den = em - 2 * e0 + ep
        guard den > 0, em.isFinite, ep.isFinite else { return 0 }
        return max(-0.5, min(0.5, 0.5 * (em - ep) / den))
    }
    let e0 = meanAbsDiff(p, c, bx, by)
    let fx = refine(meanAbsDiff(p, c, bx - 1, by), e0, meanAbsDiff(p, c, bx + 1, by))
    let fy = refine(meanAbsDiff(p, c, bx, by - 1), e0, meanAbsDiff(p, c, bx, by + 1))
    return (Double(bx) + fx, Double(by) + fy)
}
