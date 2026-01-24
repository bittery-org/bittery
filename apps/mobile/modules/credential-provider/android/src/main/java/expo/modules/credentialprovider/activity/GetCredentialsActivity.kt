package expo.modules.credentialprovider.activity

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.credentials.CreatePasswordResponse
import androidx.credentials.GetCredentialResponse
import androidx.credentials.PasswordCredential
import androidx.credentials.provider.PendingIntentHandler
import androidx.credentials.provider.ProviderCreateCredentialRequest
import androidx.credentials.provider.ProviderGetCredentialRequest
import androidx.fragment.app.FragmentActivity
import expo.modules.credentialprovider.crypto.BiometricKeyManager
import expo.modules.credentialprovider.service.BitteryCredentialProviderService
import expo.modules.credentialprovider.storage.CredentialStorageManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Activity for credential selection and biometric authentication.
 * This is launched via PendingIntent from the CredentialProviderService.
 */
@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
class GetCredentialsActivity : FragmentActivity() {
    companion object {
        private const val TAG = "GetCredentialsActivity"
    }

    private val activityScope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private lateinit var storageManager: CredentialStorageManager
    private lateinit var biometricPrompt: BiometricPrompt
    private lateinit var promptInfo: BiometricPrompt.PromptInfo

    private var credentialId: String? = null
    private var requestType: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        storageManager = CredentialStorageManager(applicationContext)

        credentialId = intent.getStringExtra(BitteryCredentialProviderService.EXTRA_CREDENTIAL_ID)
        requestType = intent.getStringExtra(BitteryCredentialProviderService.EXTRA_REQUEST_TYPE)

        Log.d(TAG, "Activity started - requestType: $requestType, credentialId: $credentialId")

        setupBiometricPrompt()

        when (requestType) {
            BitteryCredentialProviderService.REQUEST_TYPE_GET -> handleGetCredential()
            BitteryCredentialProviderService.REQUEST_TYPE_CREATE -> handleCreateCredential()
            else -> {
                Log.e(TAG, "Unknown request type: $requestType")
                finishWithError("Unknown request type")
            }
        }
    }

    private fun setupBiometricPrompt() {
        val executor = ContextCompat.getMainExecutor(this)

        biometricPrompt = BiometricPrompt(this, executor, object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                Log.d(TAG, "Biometric authentication succeeded")
                result.cryptoObject?.cipher?.let { cipher ->
                    when (requestType) {
                        BitteryCredentialProviderService.REQUEST_TYPE_GET -> {
                            completeGetCredential(cipher)
                        }
                        BitteryCredentialProviderService.REQUEST_TYPE_CREATE -> {
                            completeCreateCredential(cipher)
                        }
                    }
                } ?: run {
                    Log.e(TAG, "Cipher not available after authentication")
                    finishWithError("Authentication failed - no cipher")
                }
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                Log.e(TAG, "Biometric authentication error: $errorCode - $errString")
                finishWithError("Authentication error: $errString")
            }

            override fun onAuthenticationFailed() {
                Log.w(TAG, "Biometric authentication failed")
                // Don't finish - let user retry
            }
        })

        promptInfo = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Bittery Authentication")
            .setSubtitle("Authenticate to access your passwords")
            .setAllowedAuthenticators(
                BiometricManager.Authenticators.BIOMETRIC_STRONG or
                BiometricManager.Authenticators.DEVICE_CREDENTIAL
            )
            .build()
    }

    private fun handleGetCredential() {
        val credId = credentialId
        if (credId == null) {
            finishWithError("No credential ID provided")
            return
        }

        activityScope.launch {
            try {
                // Get the IV for this credential to initialize the decrypt cipher
                val iv = storageManager.getCredentialIv(credId)
                if (iv == null) {
                    finishWithError("Credential not found")
                    return@launch
                }

                // Get decrypt cipher initialized with the credential's IV
                val cipher = storageManager.biometricKeyManager.getDecryptCipher(iv)

                // Start biometric authentication with the cipher
                withContext(Dispatchers.Main) {
                    biometricPrompt.authenticate(
                        promptInfo,
                        BiometricPrompt.CryptoObject(cipher)
                    )
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error preparing credential retrieval", e)
                finishWithError("Failed to prepare authentication: ${e.message}")
            }
        }
    }

    private fun completeGetCredential(cipher: javax.crypto.Cipher) {
        val credId = credentialId ?: return

        activityScope.launch {
            try {
                // Get credential and decrypt password
                val credential = storageManager.getCredentialById(credId)
                if (credential == null) {
                    finishWithError("Credential not found")
                    return@launch
                }

                val password = storageManager.getDecryptedPassword(cipher, credId)
                if (password == null) {
                    finishWithError("Failed to decrypt password")
                    return@launch
                }

                Log.d(TAG, "Successfully decrypted credential for ${credential.username}")

                // Create the password credential response
                val passwordCredential = PasswordCredential(
                    id = credential.username,
                    password = password
                )

                // Get the original request to build proper response
                val getRequest = PendingIntentHandler.retrieveProviderGetCredentialRequest(intent)
                if (getRequest != null) {
                    val response = GetCredentialResponse(passwordCredential)
                    val resultIntent = Intent()
                    PendingIntentHandler.setGetCredentialResponse(resultIntent, response)
                    setResult(Activity.RESULT_OK, resultIntent)
                } else {
                    Log.w(TAG, "No provider request found, using legacy response")
                    setResult(Activity.RESULT_OK)
                }

                finish()
            } catch (e: Exception) {
                Log.e(TAG, "Error completing credential retrieval", e)
                finishWithError("Failed to retrieve credential: ${e.message}")
            }
        }
    }

    private fun handleCreateCredential() {
        // For create requests, we need to get an encrypt cipher
        activityScope.launch {
            try {
                val cipher = storageManager.biometricKeyManager.getEncryptCipher()

                withContext(Dispatchers.Main) {
                    biometricPrompt.authenticate(
                        promptInfo,
                        BiometricPrompt.CryptoObject(cipher)
                    )
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error preparing credential creation", e)
                finishWithError("Failed to prepare authentication: ${e.message}")
            }
        }
    }

    private fun completeCreateCredential(cipher: javax.crypto.Cipher) {
        activityScope.launch {
            try {
                // Get the create request from the intent
                val createRequest = PendingIntentHandler.retrieveProviderCreateCredentialRequest(intent)
                if (createRequest == null) {
                    finishWithError("No create request found")
                    return@launch
                }

                // Extract username and password from the request
                val callingRequest = createRequest.callingRequest
                if (callingRequest !is androidx.credentials.CreatePasswordRequest) {
                    finishWithError("Not a password credential request")
                    return@launch
                }

                val username = callingRequest.id
                val password = callingRequest.password
                val origin = try {
                    createRequest.callingAppInfo?.getOrigin("[]")
                } catch (e: Exception) {
                    null
                } ?: createRequest.callingAppInfo?.packageName ?: ""

                val domain = extractDomain(origin)

                Log.d(TAG, "Creating credential for $username at $domain")

                // Save the credential
                val credentialId = storageManager.saveCredential(
                    cipher = cipher,
                    vaultId = "external", // External credentials not linked to vault
                    itemId = "external_${System.currentTimeMillis()}",
                    domain = domain,
                    username = username,
                    password = password,
                    displayName = "$username @ $domain"
                )

                Log.d(TAG, "Created credential with ID: $credentialId")

                // Return success
                val response = CreatePasswordResponse()
                val resultIntent = Intent()
                PendingIntentHandler.setCreateCredentialResponse(resultIntent, response)
                setResult(Activity.RESULT_OK, resultIntent)
                finish()
            } catch (e: Exception) {
                Log.e(TAG, "Error creating credential", e)
                finishWithError("Failed to save credential: ${e.message}")
            }
        }
    }

    private fun extractDomain(origin: String): String {
        return try {
            if (origin.startsWith("http")) {
                java.net.URL(origin).host
            } else {
                origin.removePrefix("www.")
            }
        } catch (e: Exception) {
            origin
        }
    }

    private fun finishWithError(message: String) {
        Log.e(TAG, "Finishing with error: $message")
        setResult(Activity.RESULT_CANCELED)
        finish()
    }
}
