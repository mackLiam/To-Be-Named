import type { ExpoConfig } from 'expo/config';

// Zells product app: Expo Router universal app (iOS + Android + web), custom
// dev client only. See docs/DESIGN.md section 5 for the platform strategy and
// CLAUDE.md gotcha 3 for why this cannot run in Expo Go: the Swift capture
// native module (ObjectCaptureSession / PhotogrammetrySession) has no Expo Go
// counterpart and only loads in a custom dev client / EAS build.
const config: ExpoConfig = {
  name: 'Zells',
  slug: 'zells',
  scheme: 'zells',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'light',
  // The New Architecture is the only architecture as of SDK 57 (RN 0.86);
  // there is no newArchEnabled toggle left in the config schema to set.
  primaryColor: '#0B1F3A',
  backgroundColor: '#FFFFFF',
  ios: {
    bundleIdentifier: 'com.zells.app',
    supportsTablet: false,
    // Capture (ObjectCaptureSession / PhotogrammetrySession) requires iOS 17+
    // and a LiDAR-equipped iPhone (12 Pro or later Pro models). See
    // docs/DESIGN.md section 5. Enforced below via expo-build-properties;
    // the capture flow itself does its own device/OS gating at runtime
    // (src/lib/capture.ts) since older iPhones can still use every other tab.
    infoPlist: {
      // Guided capture (modules/zells-capture) drives the camera. iOS rejects
      // the build / crashes at first camera use without a usage string.
      NSCameraUsageDescription:
        'Zells uses the camera to scan your leg and build a custom-fit shin guard. Scans stay on your device until you submit an order.',
      // UNVERIFIED: whether ObjectCaptureSession requires a motion-usage string.
      // Apple's guided capture leans on device motion for coaching; include it
      // pre-emptively. Remove if a dev-client build proves it unnecessary.
      NSMotionUsageDescription:
        'Zells uses motion to guide you around your leg for an accurate scan.',
    },
  },
  android: {
    package: 'com.zells.app',
  },
  web: {
    bundler: 'metro',
    output: 'static',
  },
  plugins: [
    'expo-router',
    'expo-font',
    'expo-splash-screen',
    'expo-dev-client',
    [
      'expo-build-properties',
      {
        ios: {
          deploymentTarget: '17.0',
        },
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
  },
};

export default config;
