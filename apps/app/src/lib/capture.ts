/**
 * Capture platform gating. Pure function, no React Native imports, so it is
 * unit-testable without a device or simulator.
 *
 * Capture (ObjectCaptureSession / PhotogrammetrySession) is iOS-only and
 * requires a LiDAR sensor. See docs/DESIGN.md section 5 ("Platform Strategy")
 * and CLAUDE.md gotcha 3. Until the Swift capture native module ships
 * (TODO, see app/(tabs)/index.tsx and app/capture-info.tsx), `hasLiDAR` is
 * unknown at call sites, so it defaults to "assume capable" on iOS and only
 * blocks when a caller can positively rule the device out.
 */
export function isCaptureSupported(platform: string, hasLiDAR?: boolean): boolean {
  if (platform !== 'ios') {
    return false;
  }
  if (hasLiDAR === false) {
    return false;
  }
  return true;
}
