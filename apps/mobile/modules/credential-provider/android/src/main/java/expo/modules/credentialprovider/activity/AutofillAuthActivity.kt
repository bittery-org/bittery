package expo.modules.credentialprovider.activity

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.autofill.AutofillId
import android.view.autofill.AutofillManager
import androidx.annotation.RequiresApi
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import expo.modules.credentialprovider.crypto.MukEscrowManager
import expo.modules.credentialprovider.service.AutofillDatasetBuilder
import expo.modules.credentialprovider.service.BitteryAutofillService
import expo.modules.credentialprovider.state.VaultStateManager
import expo.modules.credentialprovider.storage.CredentialDatabase
import expo.modules.credentialprovider.storage.CredentialStorageManager
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
    private lateinit var storageManager: CredentialStorageManager
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
        storageManager = CredentialStorageManager(applicationContext)
        datasetBuilder = AutofillDatasetBuilder(applicationContext, database, storageManager)

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

    private fun buildAndFinish(unlockedUserIds: List<String>) {
        val fieldIds = AutofillDatasetBuilder.FieldIds(usernameId, passwordId)

        activityScope.launch {
            val datasets = withContext(Dispatchers.IO) {
                val results = mutableListOf<android.service.autofill.Dataset>()
                for (userId in unlockedUserIds) {
                    val muk = VaultStateManager.getMasterUnlockKey(userId) ?: continue
                    val userDatasets = datasetBuilder.buildDatasets(
                        fieldIds = fieldIds,
                        domain = domain,
                        muk = muk,
                        inlineSpec = null,
                        attributionIntent = null,
                        userId = userId
                    )
                    results.addAll(userDatasets)
                    if (results.size >= BitteryAutofillService.MAX_DATASETS) break
                }
                results
            }

            if (datasets.isEmpty()) {
                finishWithError("No credentials")
                return@launch
            }

            val responseBuilder = android.service.autofill.FillResponse.Builder()
            datasets.forEach { responseBuilder.addDataset(it) }

            val resultIntent = Intent()
            resultIntent.putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, responseBuilder.build())
            setResult(Activity.RESULT_OK, resultIntent)
            finish()
        }
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
