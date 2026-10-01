require 'json'

# Podspec for the local FormsCapture Expo module.
#
# This file MUST live in ios/, not in the package root: expo-modules-autolinking
# only looks for podspecs one directory level down (listFilesInDirectories in
# expo-modules-autolinking), so a root-level podspec resolves to no pods, the
# module is dropped from the generated ExpoModulesProvider, and
# requireNativeModule('FormsCapture') returns null at runtime even though
# CocoaPods compiled the code.

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'FormsCapture'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = 'UNLICENSED'
  s.author         = 'FORMS'
  s.homepage       = 'https://zells.com'
  s.platforms      = { :ios => '17.0' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # ObjectCaptureSession / PhotogrammetrySession and ARView live in RealityKit;
  # MDLAsset (USDZ -> OBJ) in ModelIO; photo capture uses ARKit world tracking
  # CoreImage for JPEG encoding and Accelerate (vImage/vDSP) for the blur
  # check. All system frameworks, no extra pods.
  s.frameworks = 'RealityKit', 'ModelIO', 'ARKit', 'CoreImage', 'UIKit', 'Accelerate'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
  }

  s.source_files = '**/*.{h,m,mm,swift}'
end
