package com.bittery.mobile.credentialprovider

import androidx.biometric.BiometricPrompt
import org.junit.Assert.assertEquals
import org.junit.Test

class BiometricErrorCodesTest {
	@Test
	fun userCancelIncludesCancelForJsClassifier() {
		assertEquals(
			"userCancel",
			BiometricErrorCodes.fromPrompt(BiometricPrompt.ERROR_USER_CANCELED),
		)
		assertEquals(
			"userCancel",
			BiometricErrorCodes.fromPrompt(BiometricPrompt.ERROR_NEGATIVE_BUTTON),
		)
	}

	@Test
	fun lockoutIncludesLockoutForJsClassifier() {
		assertEquals(
			"biometryLockout",
			BiometricErrorCodes.fromPrompt(BiometricPrompt.ERROR_LOCKOUT),
		)
		assertEquals(
			"biometryLockout",
			BiometricErrorCodes.fromPrompt(BiometricPrompt.ERROR_LOCKOUT_PERMANENT),
		)
	}

	@Test
	fun missingEnrolmentIncludesNotenrolledForJsClassifier() {
		assertEquals(
			"biometryNotEnrolled",
			BiometricErrorCodes.fromPrompt(BiometricPrompt.ERROR_NO_BIOMETRICS),
		)
	}

	@Test
	fun anythingElseIsAPlainFailure() {
		assertEquals(
			"authenticationFailed",
			BiometricErrorCodes.fromPrompt(BiometricPrompt.ERROR_HW_UNAVAILABLE),
		)
	}
}
