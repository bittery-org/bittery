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

        mukEscrowManager = MukEscrowManager(applicationContext)
        database = CredentialDatabase.getInstance(applicationContext)
        storageManager = CredentialStorageManager(applicationContext)
        datasetBuilder = AutofillDatasetBuilder(applicationContext, database, storageManager)

        usernameId = getParcelableExtraCompat(BitteryAutofillService.EXTRA_AUTOFILL_USERNAME_ID, AutofillId::class.java)
        passwordId = getParcelableExtraCompat(BitteryAutofillService.EXTRA_AUTOFILL_PASSWORD_ID, AutofillId::class.java)
        domain = intent.getStringExtra(BitteryAutofillService.EXTRA_AUTOFILL_DOMAIN)

        if (usernameId == null && passwordId == null) {
            finishWithError("No autofill field IDs")
            return
        }

        if (VaultStateManager.isUnlocked()) {
            buildAndFinish(VaultStateManager.getMasterUnlockKey())
            return
        }

        unlockAndContinue()
    }

    private fun unlockAndContinue() {
        if (mukEscrowManager.isMasterPasswordReentryRequired()) {
            finishWithError("Password required")
            return
        }

        if (!mukEscrowManager.canUseBiometricUnlock()) {
            finishWithError("Please open Bittery to unlock")
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
                        VaultStateManager.setMasterUnlockKey(muk)
                        buildAndFinish(muk)
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

    private fun buildAndFinish(muk: ByteArray?) {
        val fieldIds = AutofillDatasetBuilder.FieldIds(usernameId, passwordId)

        activityScope.launch {
            val datasets = withContext(Dispatchers.IO) {
                datasetBuilder.buildDatasets(
                    fieldIds = fieldIds,
                    domain = domain,
                    muk = muk,
                    inlineSpec = null,
                    attributionIntent = null
                )
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
