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
import expo.modules.credentialprovider.crypto.MukEscrowManager
import expo.modules.credentialprovider.crypto.VaultDecryptor
import expo.modules.credentialprovider.service.BitteryCredentialProviderService
import expo.modules.credentialprovider.state.VaultStateManager
import expo.modules.credentialprovider.storage.CredentialDatabase
import expo.modules.credentialprovider.storage.CredentialStorageManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray

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
    private lateinit var database: CredentialDatabase
    private lateinit var mukEscrowManager: MukEscrowManager
    private lateinit var biometricPrompt: BiometricPrompt
    private lateinit var promptInfo: BiometricPrompt.PromptInfo
    private val allowlistJson: String by lazy {
        loadAllowlistJson()
    }

    private var credentialId: String? = null  // Legacy storage
    private var itemId: String? = null        // Unified storage
    private var requestType: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        storageManager = CredentialStorageManager(applicationContext)
        database = CredentialDatabase.getInstance(applicationContext)
        mukEscrowManager = MukEscrowManager(applicationContext)

        credentialId = intent.getStringExtra(BitteryCredentialProviderService.EXTRA_CREDENTIAL_ID)
        itemId = intent.getStringExtra(BitteryCredentialProviderService.EXTRA_ITEM_ID)
        requestType = intent.getStringExtra(BitteryCredentialProviderService.EXTRA_REQUEST_TYPE)

        Log.d(TAG, "Activity started - requestType: $requestType, credentialId: $credentialId, itemId: $itemId")
        Log.d(TAG, "VaultStateManager.isUnlocked: ${VaultStateManager.isUnlocked()}")

        setupBiometricPrompt()

        when (requestType) {
            BitteryCredentialProviderService.REQUEST_TYPE_GET -> {
                // Check which storage type we're using
                if (itemId != null) {
                    handleGetItemCredential()
                } else {
                    handleGetCredential()
                }
            }
            BitteryCredentialProviderService.REQUEST_TYPE_CREATE -> handleCreateCredential()
            BitteryCredentialProviderService.REQUEST_TYPE_UNLOCK -> handleUnlock()
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

    /**
     * Handle legacy credential retrieval (uses BiometricKeyManager encryption).
     */
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

    /**
     * Handle unified storage credential retrieval (uses VaultStateManager MUK).
     * The item is decrypted using the MUK from VaultStateManager.
     */
    private fun handleGetItemCredential() {
        val iId = itemId
        if (iId == null) {
            finishWithError("No item ID provided")
            return
        }

        activityScope.launch {
            try {
                // Load item to determine user context
                val item = withContext(Dispatchers.IO) {
                    database.itemDao().getById(iId)
                }

                if (item == null) {
                    finishWithError("Item not found")
                    return@launch
                }

                val muk = VaultStateManager.getMasterUnlockKey(item.userId)
                if (muk == null) {
                    Log.w(TAG, "MUK not available for user ${item.userId}, need to unlock first")
                    val escrowUserId = mukEscrowManager.getEscrowUserId()
                    if (mukEscrowManager.hasValidEscrow() &&
                        (escrowUserId == null || escrowUserId == item.userId)
                    ) {
                        handleUnlockWithEscrow(iId, escrowUserId ?: item.userId)
                    } else {
                        Log.w(TAG, "No valid escrow for user, launching app for password unlock")
                        launchAppForPasswordUnlock(passwordRequired = false)
                    }
                    return@launch
                }

                completeGetItemCredential(item, muk)
            } catch (e: Exception) {
                Log.e(TAG, "Error preparing item credential retrieval", e)
                finishWithError("Failed to prepare authentication: ${e.message}")
            }
        }
    }

    /**
     * Try to unlock using escrowed MUK.
     */
    private fun handleUnlockWithEscrow(pendingItemId: String?, userId: String) {
        activityScope.launch {
            try {
                val cipher = mukEscrowManager.getDecryptCipher()

                withContext(Dispatchers.Main) {
                    val escrowPromptInfo = BiometricPrompt.PromptInfo.Builder()
                        .setTitle("Unlock Bittery")
                        .setSubtitle("Authenticate to access your passwords")
                        .setAllowedAuthenticators(
                            BiometricManager.Authenticators.BIOMETRIC_STRONG or
                            BiometricManager.Authenticators.DEVICE_CREDENTIAL
                        )
                        .build()

                    val escrowCallback = object : BiometricPrompt.AuthenticationCallback() {
                        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                            result.cryptoObject?.cipher?.let { authenticatedCipher ->
                                activityScope.launch {
                                    try {
                                        val muk = mukEscrowManager.retrieveEscrowedMuk(authenticatedCipher)
                                        VaultStateManager.setMasterUnlockKey(userId, muk)
                                        Log.d(TAG, "Successfully retrieved escrowed MUK")

                                        // If we have a pending item, complete the retrieval
                                        if (pendingItemId != null) {
                                            val item = withContext(Dispatchers.IO) {
                                                database.itemDao().getById(pendingItemId)
                                            }
                                            if (item != null) {
                                                completeGetItemCredential(item, muk)
                                            } else {
                                                finishWithError("Item not found")
                                            }
                                        } else {
                                            // Just unlock was requested
                                            setResult(Activity.RESULT_OK)
                                            finish()
                                        }
                                    } catch (e: Exception) {
                                        Log.e(TAG, "Failed to retrieve escrowed MUK", e)
                                        finishWithError("Failed to unlock: ${e.message}")
                                    }
                                }
                            } ?: finishWithError("No cipher after authentication")
                        }

                        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                            finishWithError("Authentication error: $errString")
                        }

                        override fun onAuthenticationFailed() {
                            // Let user retry
                        }
                    }

                    BiometricPrompt(this@GetCredentialsActivity, ContextCompat.getMainExecutor(this@GetCredentialsActivity), escrowCallback)
                        .authenticate(escrowPromptInfo, BiometricPrompt.CryptoObject(cipher))
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error preparing escrow unlock", e)
                finishWithError("Failed to prepare unlock: ${e.message}")
            }
        }
    }

    /**
     * Handle unlock request (no specific credential, just unlock the vault).
     */
    private fun handleUnlock() {
        // Check 30-day master password requirement
        if (mukEscrowManager.isMasterPasswordReentryRequired()) {
            Log.d(TAG, "30-day master password re-entry required")
            launchAppForPasswordUnlock(passwordRequired = true)
            return
        }

        // Check if we can use escrowed MUK
        if (mukEscrowManager.canUseBiometricUnlock()) {
            val escrowUserId = mukEscrowManager.getEscrowUserId() ?: "default"
            handleUnlockWithEscrow(null, escrowUserId)
        } else {
            // Need to launch main app for full unlock
            Log.w(TAG, "No valid escrow, need full password unlock")
            launchAppForPasswordUnlock(passwordRequired = false)
        }
    }

    /**
     * Complete item credential retrieval using the provided MUK.
     */
    private fun completeGetItemCredential(item: expo.modules.credentialprovider.storage.ItemEntity, muk: ByteArray) {
        activityScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    // Get the vault key for this item
                    val vaultKey = database.vaultKeyDao().getByVaultId(item.vaultId, item.userId)
                    if (vaultKey == null) {
                        withContext(Dispatchers.Main) {
                            finishWithError("Vault key not found")
                        }
                        return@withContext
                    }

                    // Decrypt the vault key using MUK
                    val decryptedVaultKey = VaultDecryptor.decryptVaultKeyWithMuk(vaultKey, muk)

                    // Decrypt the item to get the password
                    val decryptedItem = VaultDecryptor.decryptLoginItem(item, decryptedVaultKey)
                    val password = decryptedItem.password

                    if (password == null) {
                        withContext(Dispatchers.Main) {
                            finishWithError("No password found in item")
                        }
                        return@withContext
                    }

                    // Update last used timestamp
                    database.itemDao().updateLastUsed(item.id, System.currentTimeMillis())

                    Log.d(TAG, "Successfully decrypted item credential for ${decryptedItem.username}")

                    // Create the password credential response
                    val passwordCredential = PasswordCredential(
                        id = decryptedItem.username ?: item.username ?: "",
                        password = password
                    )

                    withContext(Dispatchers.Main) {
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
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error completing item credential retrieval", e)
                withContext(Dispatchers.Main) {
                    finishWithError("Failed to retrieve credential: ${e.message}")
                }
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
                val rawOrigin = try {
                    createRequest.callingAppInfo?.getOrigin(allowlistJson)
                } catch (e: Exception) {
                    null
                }
                val origin = resolveCallingOrigin(rawOrigin, createRequest.callingAppInfo?.packageName)

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

    private fun resolveCallingOrigin(originJsonOrString: String?, packageName: String?): String {
        val origins = extractOriginList(originJsonOrString)
        val origin = origins.firstOrNull()?.takeIf { it.isNotBlank() }
        return origin ?: packageName.orEmpty()
    }

    private fun extractOriginList(originJsonOrString: String?): List<String> {
        if (originJsonOrString.isNullOrBlank()) return emptyList()

        val trimmed = originJsonOrString.trim()
        if (trimmed.startsWith("[")) {
            try {
                val array = JSONArray(trimmed)
                val results = ArrayList<String>(array.length())
                for (index in 0 until array.length()) {
                    val value = array.optString(index, "")
                    if (value.isNotBlank()) {
                        results.add(value)
                    }
                }
                if (results.isNotEmpty()) {
                    return results
                }
            } catch (e: Exception) {
                Log.w(TAG, "Failed to parse origin JSON: $originJsonOrString", e)
            }
        }

        return listOf(originJsonOrString)
    }

    private fun loadAllowlistJson(): String {
        return try {
            val resources = applicationContext.resources
            val resId = resources.getIdentifier(
                "credential_provider_allowlist",
                "raw",
                applicationContext.packageName
            )
            if (resId == 0) {
                Log.w(TAG, "Allowlist resource not found")
                "[]"
            } else {
                resources.openRawResource(resId).bufferedReader().use { it.readText() }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to load allowlist JSON", e)
            "[]"
        }
    }

    /**
     * Launch the main Bittery app for password unlock.
     *
     * @param passwordRequired true if master password re-entry is required (30 days),
     *                         false for regular unlock
     */
    private fun launchAppForPasswordUnlock(passwordRequired: Boolean) {
        try {
            // Create intent to launch the main app
            val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
            if (launchIntent == null) {
                Log.e(TAG, "Could not get launch intent for app")
                finishWithError("Failed to open Bittery app")
                return
            }

            // Add flags to ensure we return to autofill after unlock
            launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)

            // Add extra to indicate this is an autofill unlock request
            launchIntent.putExtra("autofill_unlock", true)
            launchIntent.putExtra("password_required", passwordRequired)

            // Optional: Add deep link to specific unlock screen
            // The React Native app can handle this via linking configuration
            launchIntent.data = android.net.Uri.parse("bittery://autofill-unlock?passwordRequired=$passwordRequired")

            Log.d(TAG, "Launching app for password unlock (passwordRequired=$passwordRequired)")
            startActivity(launchIntent)

            // Finish this activity - user will come back through autofill flow after unlocking
            setResult(Activity.RESULT_CANCELED)
            finish()
        } catch (e: Exception) {
            Log.e(TAG, "Error launching app for password unlock", e)
            finishWithError("Failed to open Bittery app: ${e.message}")
        }
    }

    private fun finishWithError(message: String) {
        Log.e(TAG, "Finishing with error: $message")
        setResult(Activity.RESULT_CANCELED)
        finish()
    }
}
