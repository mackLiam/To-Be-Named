import ExpoModulesCore

/*
 Argument/return records shared across the module.

 Expo `Record` types marshal to/from the JS objects defined in
 modules/zells-capture/src/types.ts. Field names must match the TS interfaces.
*/

/// Mirrors the TS `ReconstructOptions`.
internal struct ReconstructOptions: Record {
  init() {}

  /// 'reduced' | 'medium' | 'full' | 'raw'. Defaults to 'reduced': the
  /// measurement pipeline does not need hero-quality geometry, and lower
  /// detail is faster on-device and produces smaller files.
  @Field var detail: String = "reduced"

  /// Absolute path to a specific capture session directory. Empty => use the
  /// most recent session created by startCapture.
  @Field var sessionDir: String = ""
}
