import Foundation

// forms.video-bundle v1, pinned in docs/VIDEO-HARNESS.md. Optional fields are
// encoded as explicit nulls (never omitted), so every encode below uses encode,
// not encodeIfPresent.

public struct Manifest: Encodable, Equatable {
    public var source: Source
    public var tool: Tool
    public var photogrammetry: Photogrammetry
    public var frames: [Frame]

    public init(source: Source, tool: Tool, photogrammetry: Photogrammetry, frames: [Frame]) {
        self.source = source
        self.tool = tool
        self.photogrammetry = photogrammetry
        self.frames = frames
    }

    enum K: String, CodingKey { case format, version, source, tool, photogrammetry, frames }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: K.self)
        try c.encode("forms.video-bundle", forKey: .format)
        try c.encode(1, forKey: .version)
        try c.encode(source, forKey: .source)
        try c.encode(tool, forKey: .tool)
        try c.encode(photogrammetry, forKey: .photogrammetry)
        try c.encode(frames, forKey: .frames)
    }
}

public struct Source: Encodable, Equatable {
    public var durationS: Double
    public var fps: Double
    public var width: Int
    public var height: Int
    public var framesDecoded: Int

    public init(durationS: Double, fps: Double, width: Int, height: Int, framesDecoded: Int) {
        self.durationS = durationS
        self.fps = fps
        self.width = width
        self.height = height
        self.framesDecoded = framesDecoded
    }

    enum K: String, CodingKey {
        case durationS = "duration_s", fps, width, height, framesDecoded = "frames_decoded"
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: K.self)
        try c.encode(roundTo(durationS, 3), forKey: .durationS)
        try c.encode(roundTo(fps, 3), forKey: .fps)
        try c.encode(width, forKey: .width)
        try c.encode(height, forKey: .height)
        try c.encode(framesDecoded, forKey: .framesDecoded)
    }
}

public struct Tool: Encodable, Equatable {
    public var seconds: Double
    public var maxFrames: Int

    public init(seconds: Double, maxFrames: Int) {
        self.seconds = seconds
        self.maxFrames = maxFrames
    }

    enum K: String, CodingKey { case name, seconds, maxFrames = "max_frames" }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: K.self)
        try c.encode("forms-video", forKey: .name)
        try c.encode(roundTo(seconds, 1), forKey: .seconds)
        try c.encode(maxFrames, forKey: .maxFrames)
    }
}

public enum PhotogrammetryStatus: String, Encodable, Equatable { case ok, failed, skipped }

/// The only error strings a bundle may carry; never paths or framework text.
public enum PhotogrammetryError: String, Encodable, Equatable {
    case noPoses = "no_poses", sessionInit = "session_init", process, timeout, unsupported
}

public struct Photogrammetry: Encodable, Equatable {
    public var status: PhotogrammetryStatus
    public var error: PhotogrammetryError?
    public var submitted: Int
    public var registered: Int
    public var points: Int
    public var model: Bool

    public init(
        status: PhotogrammetryStatus, error: PhotogrammetryError?, submitted: Int, registered: Int, points: Int,
        model: Bool
    ) {
        self.status = status
        self.error = error
        self.submitted = submitted
        self.registered = registered
        self.points = points
        self.model = model
    }

    public static let skipped = Photogrammetry(
        status: .skipped, error: nil, submitted: 0, registered: 0, points: 0, model: false)

    public static func failed(_ e: PhotogrammetryError, submitted: Int) -> Photogrammetry {
        Photogrammetry(status: .failed, error: e, submitted: submitted, registered: 0, points: 0, model: false)
    }

    enum K: String, CodingKey { case status, error, submitted, registered, points, model, convention }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: K.self)
        try c.encode(status, forKey: .status)
        try c.encode(error, forKey: .error)
        try c.encode(submitted, forKey: .submitted)
        try c.encode(registered, forKey: .registered)
        try c.encode(points, forKey: .points)
        try c.encode(model, forKey: .model)
        try c.encode("realitykit_pose", forKey: .convention)
    }
}

public struct MaskRef: Encodable, Equatable {
    public var file: String
    public var areaFraction: Double
    /// Foreground only: the instance count Vision returned.
    public var instances: Int?

    public init(file: String, areaFraction: Double, instances: Int? = nil) {
        self.file = file
        self.areaFraction = areaFraction
        self.instances = instances
    }

    enum K: String, CodingKey { case file, areaFraction = "area_fraction", instances }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: K.self)
        try c.encode(file, forKey: .file)
        try c.encode(roundTo(areaFraction, 4), forKey: .areaFraction)
        if let instances { try c.encode(instances, forKey: .instances) }
    }
}

public struct Pose: Encodable, Equatable {
    /// 4x4 column-major, 16 values.
    public var transform: [Double]
    /// 3x3 column-major, 9 values, or nil when the OS does not provide it.
    public var intrinsics: [Double]?

    /// Nil unless the shapes are right and every value is finite.
    public init?(transform: [Double], intrinsics: [Double]?) {
        guard transform.count == 16, transform.allSatisfy(\.isFinite) else { return nil }
        self.transform = transform
        if let intrinsics, intrinsics.count == 9, intrinsics.allSatisfy(\.isFinite) {
            self.intrinsics = intrinsics
        } else {
            self.intrinsics = nil
        }
    }

    enum K: String, CodingKey { case transform, intrinsics }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: K.self)
        try c.encode(transform, forKey: .transform)
        try c.encode(intrinsics, forKey: .intrinsics)
    }
}

public struct Frame: Encodable, Equatable {
    public var id: Int
    public var timeS: Double
    public var width: Int
    public var height: Int
    public var sharpness: Double
    public var motionPx: Double?
    public var person: MaskRef?
    public var foreground: MaskRef?
    public var joints: [String: [Double]]
    public var pose: Pose?

    public init(
        id: Int, timeS: Double, width: Int, height: Int, sharpness: Double, motionPx: Double?,
        person: MaskRef?, foreground: MaskRef?, joints: [String: [Double]], pose: Pose?
    ) {
        self.id = id
        self.timeS = timeS
        self.width = width
        self.height = height
        self.sharpness = sharpness
        self.motionPx = motionPx
        self.person = person
        self.foreground = foreground
        self.joints = joints
        self.pose = pose
    }

    enum K: String, CodingKey {
        case id, file, timeS = "time_s", width, height, sharpness, motionPx = "motion_px", masks, joints, pose
    }

    enum M: String, CodingKey { case person, foreground }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: K.self)
        try c.encode(id, forKey: .id)
        try c.encode(frameFile(id), forKey: .file)
        try c.encode(roundTo(timeS, 3), forKey: .timeS)
        try c.encode(width, forKey: .width)
        try c.encode(height, forKey: .height)
        try c.encode(roundTo(sharpness, 2), forKey: .sharpness)
        try c.encode(motionPx.map { roundTo($0, 2) }, forKey: .motionPx)
        var m = c.nestedContainer(keyedBy: M.self, forKey: .masks)
        try m.encode(person, forKey: .person)
        try m.encode(foreground, forKey: .foreground)
        try c.encode(joints, forKey: .joints)
        try c.encode(pose, forKey: .pose)
    }
}

public func frameFile(_ id: Int) -> String { String(format: "frames/%03d.jpg", id) }
public func maskFile(_ kind: String, _ id: Int) -> String { String(format: "masks/%@/%03d.png", kind, id) }

/// Sorted keys and unescaped slashes, so output is deterministic and file
/// fields read as plain relative paths.
public func encodeManifest(_ m: Manifest) throws -> Data {
    let e = JSONEncoder()
    e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return try e.encode(m)
}

/// Column-major flattening of simd-style column arrays, as RealityKit holds them.
public func flattenColumns(_ columns: [[Float]]) -> [Double] { columns.flatMap { $0.map(Double.init) } }

/// Float32 little-endian x, y, z triples (points.f32). Clouds above the cap are
/// thinned with a uniform stride so the bundle stays within the Python cap.
public func encodePoints(_ xyz: [SIMD3<Float>], cap: Int = Limits.maxPoints) -> (data: Data, count: Int) {
    let stride = max(1, (xyz.count + cap - 1) / max(1, cap))
    var data = Data()
    data.reserveCapacity((xyz.count / stride + 1) * 12)
    var n = 0
    var i = 0
    while i < xyz.count {
        let p = xyz[i]
        if p.x.isFinite && p.y.isFinite && p.z.isFinite {
            for v in [p.x, p.y, p.z] {
                var le = v.bitPattern.littleEndian
                withUnsafeBytes(of: &le) { data.append(contentsOf: $0) }
            }
            n += 1
        }
        i += stride
    }
    return (data, n)
}
