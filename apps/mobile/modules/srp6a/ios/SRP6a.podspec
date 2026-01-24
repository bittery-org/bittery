Pod::Spec.new do |s|
  s.name           = 'SRP6a'
  s.version        = '1.0.0'
  s.summary        = 'Native SRP-6a implementation for React Native'
  s.description    = 'High-performance SRP-6a authentication protocol using native BigInteger and crypto operations'
  s.author         = 'Bittery'
  s.homepage       = 'https://bittery.io'
  s.platforms      = {
    :ios => '15.1'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_OPTIMIZATION_LEVEL' => '-O'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
