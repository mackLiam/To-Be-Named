import ExpoModulesCore

/*
 Argument/return records shared across the module.

 Expo `Record` types marshal to/from the JS objects defined in
 modules/zells-capture/src/types.ts. Field names must match the TS interfaces.
*/

/// Mirrors the TS `ReconstructOptions`.
internal struct ReconstructOptions: Record {
  init() {}

  /// Always 'reduced': iOS exposes only PhotogrammetrySession.Request.Detail
  /// .reduced (see ReconstructionController). Kept as a field so widening the
  /// TS DetailLevel union later does not change the record shape.
  @Field var detail: String = "reduced"

  /// Absolute path to a specific capture session directory. Empty => use the
  /// most recent session created by startCapture.
  @Field var sessionDir: String = ""
}
