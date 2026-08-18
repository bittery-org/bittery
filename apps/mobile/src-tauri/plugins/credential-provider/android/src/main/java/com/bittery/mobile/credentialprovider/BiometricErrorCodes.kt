package com.bittery.mobile.credentialprovider

import androidx.biometric.BiometricPrompt

/**
 * English codes the JS adapter's `classifyBiometricFailure` already matches
 * (`cancel`, `lockout`, `notenrolled`). The OS `errString` is often German.
 */
internal object BiometricErrorCodes {
	fun fromPrompt(errorCode: Int): String =
		when (errorCode) {
			BiometricPrompt.ERROR_NEGATIVE_BUTTON,
			BiometricPrompt.ERROR_USER_CANCELED,
			-> "userCancel"
			BiometricPrompt.ERROR_LOCKOUT,
			BiometricPrompt.ERROR_LOCKOUT_PERMANENT,
			-> "biometryLockout"
			BiometricPrompt.ERROR_NO_BIOMETRICS,
			-> "biometryNotEnrolled"
			else -> "authenticationFailed"
		}
}
