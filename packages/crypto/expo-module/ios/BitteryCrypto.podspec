require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'BitteryCrypto'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.author         = package['author']
  s.license        = package['license']
  s.homepage       = 'https://github.com/bittery-org/bittery'
  s.platforms      = { :ios => '13.4', :tvos => '13.4' }
  s.swift_version  = '5.4'
  s.source         = { :git => 'https://github.com/bittery-org/bittery.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift source files
  s.source_files = '*.swift'

  # Link the Rust static library via xcframework
  s.vendored_frameworks = 'BitteryCrypto.xcframework'

  # Ensure the static library is linked
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'OTHER_LDFLAGS' => '-lbittery_crypto_ffi',
    'LIBRARY_SEARCH_PATHS' => '"$(PODS_TARGET_SRCROOT)/BitteryCrypto.xcframework/ios-arm64"'
  }
end
