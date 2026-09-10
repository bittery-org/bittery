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
import androidx.fragment.app.FragmentActivity
import com.bittery.mobile.credentialprovider.service.AutofillDatasetBuilder
import com.bittery.mobile.credentialprovider.service.BitteryAutofillService
import com.bittery.mobile.credentialprovider.service.InlineSuggestionLayout
import com.bittery.mobile.credentialprovider.vault.NativeCredentialVault
import com.bittery.mobile.credentialprovider.vault.NativeCredentialVaults
import com.bittery.mobile.credentialprovider.vault.UnlockResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

@RequiresApi(Build.VERSION_CODES.O)
class AutofillAuthActivity : FragmentActivity() {
    companion object {
        private const val TAG = "AutofillAuthActivity"
    }

    private val activityScope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    private lateinit var vault: NativeCredentialVault
    private lateinit var datasetBuilder: AutofillDatasetBuilder

    private var usernameId: AutofillId? = null
    private var passwordId: AutofillId? = null
    private var domain: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        Log.d(TAG, "AutofillAuthActivity started")

        vault = NativeCredentialVaults.of(applicationContext)
        datasetBuilder = AutofillDatasetBuilder(applicationContext, vault)

        usernameId = getParcelableExtraCompat(BitteryAutofillService.EXTRA_AUTOFILL_USERNAME_ID, AutofillId::class.java)
        passwordId = getParcelableExtraCompat(BitteryAutofillService.EXTRA_AUTOFILL_PASSWORD_ID, AutofillId::class.java)
        domain = intent.getStringExtra(BitteryAutofillService.EXTRA_AUTOFILL_DOMAIN)

        Log.d(TAG, "Fields: username=${usernameId != null}, password=${passwordId != null}, domain=$domain")

        if (usernameId == null && passwordId == null) {
            finishWithError("No autofill field IDs")
            return
        }

        val unlockedAccounts = vault.unlockedAccountIds().size
        Log.d(TAG, "Unlocked accounts: $unlockedAccounts")

        if (unlockedAccounts > 0) {
            Log.d(TAG, "Vault already unlocked - building datasets")
            buildAndFinish()
            return
        }

        Log.d(TAG, "Vault locked - attempting unlock")
        unlockAndContinue()
    }

    /**
     * Unlock here if that is possible, and hand the user to the app if it is not.
     *
     * The vault owns both halves: whether the escrow may be used at all, and the
     * prompt that unwraps it. This activity only decides what a "no" means for
     * the autofill session.
     */
    private fun unlockAndContinue() {
        val state = vault.biometricUnlockState()
        Log.d(
            TAG,
            "Unlock check: passwordRequired=${state.masterPasswordRequired}, " +
                "canUseBiometric=${state.canUnlock}",
        )

        if (state.masterPasswordRequired || !state.canUnlock) {
            Log.d(TAG, "Cannot unlock here - launching main app")
            launchAppForUnlock(state.masterPasswordRequired)
            return
        }

        activityScope.launch {
            when (
                val result = vault.unlockWithBiometric(
                    this@AutofillAuthActivity,
                    "Authenticate to autofill",
                )
            ) {
                is UnlockResult.Unlocked -> buildAndFinish()

                // A pre-rekey record. Re-enrolment needs the master password.
                UnlockResult.NeedsReenrolment -> {
                    Log.w(TAG, "Escrow record names no account - re-enrolment needed")
                    launchAppForUnlock(passwordRequired = true)
                }

                UnlockResult.NoEscrow -> launchAppForUnlock(state.masterPasswordRequired)

                is UnlockResult.Rejected -> finishWithError(result.message)

                is UnlockResult.PromptUnavailable -> finishWithError(result.message)

                is UnlockResult.PromptFailed -> finishWithError(result.message)

                is UnlockResult.Failed -> finishWithError("Failed to unlock")
            }
        }
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
    private fun buildAndFinish() {
        val fieldIds = AutofillDatasetBuilder.FieldIds(usernameId, passwordId)
        Log.d(TAG, "Building response for ${vault.unlockedAccountIds().size} unlocked account(s)")

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
            // The vault moves its own storage work off the main thread.
            val response = datasetBuilder.buildUnlockedResponse(
                fieldIds = fieldIds,
                domain = domain,
                inlineSpec = inlineSpec,
                pinnedSpec = pinnedSpec,
                maxSuggestionCount = maxSuggestionCount,
                attributionIntent = datasetBuilder.appLaunchIntent(),
            )

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
