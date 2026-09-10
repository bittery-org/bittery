package com.bittery.mobile.credentialprovider.vault

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import javax.crypto.Cipher
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext

/**
 * The user's "yes" on a biometric prompt, as a value.
 *
 * The vault needs an authenticated cipher and nothing else. Keeping the prompt
 * behind this port means the decision the vault makes around it — no escrow, a
 * record that needs re-enrolment, an unwrap that fails — is testable without an
 * activity.
 */
internal interface BiometricGate {
    suspend fun authenticate(
        activity: FragmentActivity,
        subtitle: String,
        cipher: Cipher,
    ): CipherAuthentication
}

internal sealed interface CipherAuthentication {
    data class Authenticated(val cipher: Cipher) : CipherAuthentication

    /** The user cancelled, or the sensor refused. */
    data class Rejected(val message: String) : CipherAuthentication

    /** No activity could host the prompt. Asking again elsewhere may work. */
    data class NoHost(val message: String) : CipherAuthentication

    /** The prompt itself would not start. */
    data class Failed(val message: String) : CipherAuthentication
}

/**
 * `BiometricPrompt`, made awaitable.
 *
 * Two guards matter. The activity has to be able to host a fragment: the prompt
 * opens with `if (isStateSaved()) return`, which logs and never calls back, and a
 * caller waiting on that callback waits forever. And the callback fires once —
 * `onAuthenticationFailed` is a retry, not an answer, so it is ignored.
 */
internal class AndroidBiometricGate : BiometricGate {

    override suspend fun authenticate(
        activity: FragmentActivity,
        subtitle: String,
        cipher: Cipher,
    ): CipherAuthentication = withContext(Dispatchers.Main) {
        // The prompt attaches a fragment, so it has to start on the main thread.
        suspendCancellableCoroutine { continuation ->
            if (!canHostPrompt(activity)) {
                continuation.resume(
                    CipherAuthentication.NoHost(
                        "No activity able to show the biometric prompt",
                    ),
                )
                return@suspendCancellableCoroutine
            }

            try {
                val callback = object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(
                        result: BiometricPrompt.AuthenticationResult,
                    ) {
                        if (!continuation.isActive) return
                        val authenticated = result.cryptoObject?.cipher
                        continuation.resume(
                            if (authenticated == null) {
                                CipherAuthentication.Rejected("No cipher after authentication")
                            } else {
                                CipherAuthentication.Authenticated(authenticated)
                            },
                        )
                    }

                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        if (!continuation.isActive) return
                        continuation.resume(CipherAuthentication.Rejected(errString.toString()))
                    }

                    override fun onAuthenticationFailed() {
                        // One bad read. Let the user try again on the same prompt.
                    }
                }

                val promptInfo = BiometricPrompt.PromptInfo.Builder()
                    .setTitle("Unlock Bittery")
                    .setSubtitle(subtitle)
                    .setAllowedAuthenticators(
                        BiometricManager.Authenticators.BIOMETRIC_STRONG or
                            BiometricManager.Authenticators.DEVICE_CREDENTIAL,
                    )
                    .build()

                BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), callback)
                    .authenticate(promptInfo, BiometricPrompt.CryptoObject(cipher))
            } catch (e: Exception) {
                if (continuation.isActive) {
                    continuation.resume(
                        CipherAuthentication.Failed(
                            "Failed to show authentication prompt: ${e.message}",
                        ),
                    )
                }
            }
        }
    }

    private fun canHostPrompt(activity: FragmentActivity): Boolean =
        !activity.isDestroyed &&
            !activity.isFinishing &&
            !activity.supportFragmentManager.isStateSaved
}
