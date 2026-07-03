require 'json'

# Podspec for the local ZellsCapture Expo module. Expo autolinking discovers
# this via expo-module.config.json and includes it in the generated Podfile when
# the iOS project is prebuilt (expo prebuild / EAS build). It is never built in
# this scaffold environment; it compiles first inside an EAS dev-client build.

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ZellsCapture'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = 'UNLICENSED'
  s.author         = 'Zells'
  s.homepage       = 'https://zells.com'
  s.platforms      = { :ios => '17.0' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # ObjectCaptureSession / PhotogrammetrySession live in RealityKit; MDLAsset
  # (USDZ -> OBJ) in ModelIO. Both are system frameworks, no extra pods.
  s.frameworks = 'RealityKit', 'ModelIO'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
  }

  s.source_files = 'ios/**/*.{h,m,mm,swift}'
end
