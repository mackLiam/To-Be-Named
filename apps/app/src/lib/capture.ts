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

/**
 * Which capture flow a capable iOS device runs. 'object' is Apple's guided
 * ObjectCaptureSession with on-device reconstruction (LiDAR iPhones); 'photos'
 * is guided ARKit photo capture reconstructed server-side (any ARKit iPhone).
 * ObjectCapture wins when both are available: it produces a metric mesh on the
 * phone with no server reconstruction step.
 */
export type CaptureMode = 'object' | 'photos';

export function resolveCaptureMode(
  objectCaptureSupported: boolean,
  photoCaptureSupported: boolean,
): CaptureMode | null {
  if (objectCaptureSupported) {
    return 'object';
  }
  if (photoCaptureSupported) {
    return 'photos';
  }
  return null;
}
