package com.bittery.mobile.credentialprovider.activity

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.autofill.AutofillId
import android.view.autofill.AutofillManager
import android.view.inputmethod.InlineSuggestionsRequest
import androidx.annotation.RequiresApi
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.bittery.mobile.credentialprovider.crypto.MukEscrowManager
import com.bittery.mobile.credentialprovider.service.AutofillDatasetBuilder
import com.bittery.mobile.credentialprovider.service.BitteryAutofillService
import com.bittery.mobile.credentialprovider.service.InlineSuggestionLayout
import com.bittery.mobile.credentialprovider.state.VaultStateManager
import com.bittery.mobile.credentialprovider.storage.CredentialDatabase
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@RequiresApi(Build.VERSION_CODES.O)
class AutofillAuthActivity : FragmentActivity() {
    companion object {
        private const val TAG = "AutofillAuthActivity"
    }

    private val activityScope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    private lateinit var mukEscrowManager: MukEscrowManager
    private lateinit var database: CredentialDatabase
    private lateinit var datasetBuilder: AutofillDatasetBuilder

    private var usernameId: AutofillId? = null
    private var passwordId: AutofillId? = null
    private var domain: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        VaultStateManager.initialize(applicationContext)

        Log.d(TAG, "AutofillAuthActivity started")

        mukEscrowManager = MukEscrowManager(applicationContext)
        database = CredentialDatabase.getInstance(applicationContext)
		datasetBuilder = AutofillDatasetBuilder(applicationContext, database)

        usernameId = getParcelableExtraCompat(BitteryAutofillService.EXTRA_AUTOFILL_USERNAME_ID, AutofillId::class.java)
        passwordId = getParcelableExtraCompat(BitteryAutofillService.EXTRA_AUTOFILL_PASSWORD_ID, AutofillId::class.java)
        domain = intent.getStringExtra(BitteryAutofillService.EXTRA_AUTOFILL_DOMAIN)

        Log.d(TAG, "Fields: username=${usernameId != null}, password=${passwordId != null}, domain=$domain")

        if (usernameId == null && passwordId == null) {
            finishWithError("No autofill field IDs")
            return
        }

        val isUnlocked = VaultStateManager.isUnlocked()
        Log.d(TAG, "Vault unlocked: $isUnlocked")

        if (isUnlocked) {
            Log.d(TAG, "Vault already unlocked - building datasets")
            buildAndFinish(VaultStateManager.getUnlockedUserIds())
            return
        }

        Log.d(TAG, "Vault locked - attempting unlock")
        unlockAndContinue()
    }

    private fun unlockAndContinue() {
        // Check if master password re-entry is required
        val passwordRequired = mukEscrowManager.isMasterPasswordReentryRequired()
        val canUseBiometric = mukEscrowManager.canUseBiometricUnlock()

        Log.d(TAG, "Unlock check: passwordRequired=$passwordRequired, canUseBiometric=$canUseBiometric")

        // If password is required OR biometric isn't available, launch the main app
        if (passwordRequired || !canUseBiometric) {
            Log.d(TAG, "Cannot unlock here - launching main app")
            launchAppForUnlock(passwordRequired)
            return
        }

        val executor = ContextCompat.getMainExecutor(this)
        val biometricPrompt = BiometricPrompt(this, executor, object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                val cipher = result.cryptoObject?.cipher
                if (cipher == null) {
                    finishWithError("Authentication failed")
                    return
                }

                activityScope.launch {
                    try {
                        val muk = mukEscrowManager.retrieveEscrowedMuk(cipher)
                        val escrowUserId = mukEscrowManager.getEscrowUserId()
                        if (escrowUserId.isNullOrBlank()) {
                            VaultStateManager.setMasterUnlockKey(muk)
                        } else {
                            VaultStateManager.setMasterUnlockKey(escrowUserId, muk)
                        }
                        buildAndFinish(VaultStateManager.getUnlockedUserIds())
                    } catch (e: Exception) {
                        Log.e(TAG, "Failed to retrieve MUK", e)
                        finishWithError("Failed to unlock")
                    }
                }
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                finishWithError(errString.toString())
            }

            override fun onAuthenticationFailed() {
                // Let user retry
            }
        })

        val promptInfo = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Unlock Bittery")
            .setSubtitle("Authenticate to autofill")
            .setAllowedAuthenticators(
                BiometricManager.Authenticators.BIOMETRIC_STRONG or
                    BiometricManager.Authenticators.DEVICE_CREDENTIAL
            )
            .build()

        val cipher = mukEscrowManager.getDecryptCipher()
        biometricPrompt.authenticate(promptInfo, BiometricPrompt.CryptoObject(cipher))
    }

    /**
     * Hand the unlocked vault back to the framework.
     *
     * The service authenticates at *response* level, so what goes into
     * [AutofillManager.EXTRA_AUTHENTICATION_RESULT] must be a FillResponse —
     * anything else and the framework drops the session without a word.
     *
     * The inline specs matter just as much. The IME's request is forwarded to
     * this activity in the launch intent; without it the returned datasets have
     * no inline presentation and the keyboard strip stays empty after a
     * successful unlock, even though the fill itself worked.
     */
    private fun buildAndFinish(unlockedUserIds: List<String>) {
        val fieldIds = AutofillDatasetBuilder.FieldIds(usernameId, passwordId)
        Log.d(TAG, "Building response for ${unlockedUserIds.size} unlocked user(s)")

        val inlineRequest = inlineSuggestionsRequest()
        val inlineSpecs = inlineRequest?.inlinePresentationSpecs.orEmpty()
        val inlineSpec = InlineSuggestionLayout.scrollableSpec(inlineSpecs)
        val pinnedSpec = InlineSuggestionLayout.pinnedSpec(inlineSpecs)
        val maxSuggestionCount = if (inlineRequest != null && inlineSpec != null) {
            inlineRequest.maxSuggestionCount.coerceAtLeast(0)
        } else {
            null
        }
        Log.d(TAG, "Inline specs from IME: ${inlineSpecs.size}, max=$maxSuggestionCount")

        activityScope.launch {
            val response = withContext(Dispatchers.IO) {
                datasetBuilder.buildUnlockedResponse(
                    fieldIds = fieldIds,
                    domain = domain,
                    inlineSpec = inlineSpec,
                    pinnedSpec = pinnedSpec,
                    maxSuggestionCount = maxSuggestionCount,
                    attributionIntent = datasetBuilder.appLaunchIntent(),
                )
            }

            if (response == null) {
                finishWithError("No credentials")
                return@launch
            }

            val resultIntent = Intent()
            resultIntent.putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, response)
            setResult(Activity.RESULT_OK, resultIntent)
            finish()
        }
    }

    private fun inlineSuggestionsRequest(): InlineSuggestionsRequest? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        return getParcelableExtraCompat(
            AutofillManager.EXTRA_INLINE_SUGGESTIONS_REQUEST,
            InlineSuggestionsRequest::class.java,
        )
    }

    private fun launchAppForUnlock(passwordRequired: Boolean) {
        Log.d(TAG, "Launching main app for unlock (passwordRequired=$passwordRequired)")

        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        launchIntent?.apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            putExtra("autofill_unlock", true)
            putExtra("password_required", passwordRequired)
            data = android.net.Uri.parse("bittery://autofill-unlock?passwordRequired=$passwordRequired")
        }

        try {
            startActivity(launchIntent)
            Log.d(TAG, "Successfully launched main app")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to launch main app", e)
        }

        setResult(Activity.RESULT_CANCELED)
        finish()
    }

    private fun finishWithError(message: String) {
        Log.e(TAG, "Finishing with error: $message")
        setResult(Activity.RESULT_CANCELED)
        finish()
    }

    @Suppress("DEPRECATION")
    private fun <T> getParcelableExtraCompat(key: String, clazz: Class<T>): T? {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(key, clazz)
        } else {
            intent.getParcelableExtra(key)
        }
    }
}
