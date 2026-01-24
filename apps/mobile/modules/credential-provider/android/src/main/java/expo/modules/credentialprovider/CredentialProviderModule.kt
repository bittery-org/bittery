package expo.modules.credentialprovider

import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.credentialprovider.crypto.BiometricKeyManager
import expo.modules.credentialprovider.storage.CredentialStorageManager
import expo.modules.credentialprovider.storage.CredentialEntity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class CredentialProviderModule : Module() {
    companion object {
        private const val TAG = "CredentialProviderModule"
        private const val MIN_API_LEVEL = Build.VERSION_CODES.UPSIDE_DOWN_CAKE // API 34
    }

    private val moduleScope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    private val context: Context
        get() = requireNotNull(appContext.reactContext)

    private val storageManager: CredentialStorageManager by lazy {
        CredentialStorageManager(context)
    }

    private val currentActivity: FragmentActivity?
        get() = appContext.currentActivity as? FragmentActivity

    override fun definition() = ModuleDefinition {
        Name("CredentialProvider")

        Events("onCredentialSaved", "onCredentialDeleted", "onSyncComplete")

        /**
         * Check if the Credential Manager API is available on this device.
         * Requires Android 14 (API 34) or higher.
         */
        Function("isAvailable") {
            val available = Build.VERSION.SDK_INT >= MIN_API_LEVEL
            Log.d(TAG, "isAvailable: $available (SDK ${Build.VERSION.SDK_INT}, min required: $MIN_API_LEVEL)")
            available
        }

        /**
         * Check if biometric authentication is available.
         */
        Function("isBiometricAvailable") {
            val biometricManager = BiometricManager.from(context)
            val canAuthenticate = biometricManager.canAuthenticate(
                BiometricManager.Authenticators.BIOMETRIC_STRONG or
                BiometricManager.Authenticators.DEVICE_CREDENTIAL
            )
            val available = canAuthenticate == BiometricManager.BIOMETRIC_SUCCESS
            Log.d(TAG, "isBiometricAvailable: $available (canAuthenticate result: $canAuthenticate)")
            available
        }

        /**
         * Open Android system settings for credential providers.
         */
        Function("openCredentialProviderSettings") {
            try {
                if (Build.VERSION.SDK_INT >= MIN_API_LEVEL) {
                    val intent = Intent(Settings.ACTION_CREDENTIAL_PROVIDER)
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    context.startActivity(intent)
                    true
                } else {
                    // Fallback to security settings on older Android versions
                    val intent = Intent(Settings.ACTION_SECURITY_SETTINGS)
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    context.startActivity(intent)
                    false
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to open settings", e)
                false
            }
        }

        /**
         * Save a single credential to the credential provider storage.
         * Uses time-bound authentication - if user authenticated recently, no prompt needed.
         */
        AsyncFunction("saveCredential") { params: Map<String, Any>, promise: Promise ->
            if (Build.VERSION.SDK_INT < MIN_API_LEVEL) {
                promise.reject("UNSUPPORTED", "Credential Manager requires Android 14 or higher", null)
                return@AsyncFunction
            }

            val activity = currentActivity
            if (activity == null) {
                promise.reject("NO_ACTIVITY", "No activity available", null)
                return@AsyncFunction
            }

            val vaultId = params["vaultId"] as? String ?: ""
            val itemId = params["itemId"] as? String ?: ""
            val domain = params["domain"] as? String ?: ""
            val username = params["username"] as? String ?: ""
            val password = params["password"] as? String ?: ""
            val displayName = params["displayName"] as? String ?: "$username @ $domain"
            val iconUrl = params["iconUrl"] as? String

            if (domain.isEmpty() || username.isEmpty() || password.isEmpty()) {
                promise.reject("INVALID_PARAMS", "domain, username, and password are required", null)
                return@AsyncFunction
            }

            // Ensure key exists
            storageManager.biometricKeyManager.generateKey()

            // Function to perform the actual save
            fun performSave() {
                moduleScope.launch {
                    try {
                        val cipher = storageManager.biometricKeyManager.getEncryptCipher()
                        val id = storageManager.saveCredential(
                            cipher = cipher,
                            vaultId = vaultId,
                            itemId = itemId,
                            domain = domain,
                            username = username,
                            password = password,
                            displayName = displayName,
                            iconUrl = iconUrl
                        )
                        sendEvent("onCredentialSaved", mapOf("id" to id))
                        promise.resolve(id)
                    } catch (e: Exception) {
                        Log.e(TAG, "Failed to save credential", e)
                        promise.reject("SAVE_FAILED", "Failed to save credential: ${e.message}", e)
                    }
                }
            }

            // Check if we need authentication
            val needsAuth = storageManager.biometricKeyManager.requiresAuthentication()

            if (!needsAuth) {
                // User authenticated recently, can save directly
                performSave()
                return@AsyncFunction
            }

            // Need to authenticate first
            activity.runOnUiThread {
                try {
                    val executor = ContextCompat.getMainExecutor(context)

                    val biometricPrompt = BiometricPrompt(activity, executor, object : BiometricPrompt.AuthenticationCallback() {
                        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                            performSave()
                        }

                        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                            promise.reject("AUTH_ERROR", errString.toString(), null)
                        }

                        override fun onAuthenticationFailed() {
                            // Let user retry
                        }
                    })

                    val promptInfo = BiometricPrompt.PromptInfo.Builder()
                        .setTitle("Save Password")
                        .setSubtitle("Authenticate to save password to Bittery")
                        .setAllowedAuthenticators(
                            BiometricManager.Authenticators.BIOMETRIC_STRONG or
                            BiometricManager.Authenticators.DEVICE_CREDENTIAL
                        )
                        .build()

                    biometricPrompt.authenticate(promptInfo)
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to show biometric prompt", e)
                    promise.reject("PROMPT_FAILED", "Failed to show authentication prompt: ${e.message}", e)
                }
            }
        }

        /**
         * Sync multiple credentials from the main vault.
         * This is more efficient than saving credentials one by one.
         * Uses time-bound authentication - after one biometric auth, can encrypt for 30 seconds.
         */
        AsyncFunction("syncCredentials") { credentials: List<Map<String, Any>>, promise: Promise ->
            Log.d(TAG, "syncCredentials called with ${credentials.size} credentials")

            if (Build.VERSION.SDK_INT < MIN_API_LEVEL) {
                Log.e(TAG, "syncCredentials: SDK version ${Build.VERSION.SDK_INT} < $MIN_API_LEVEL")
                promise.reject("UNSUPPORTED", "Credential Manager requires Android 14 or higher", null)
                return@AsyncFunction
            }

            val activity = currentActivity
            if (activity == null) {
                Log.e(TAG, "syncCredentials: No activity available")
                promise.reject("NO_ACTIVITY", "No activity available", null)
                return@AsyncFunction
            }

            if (credentials.isEmpty()) {
                Log.d(TAG, "syncCredentials: No credentials to sync")
                promise.resolve(mapOf("synced" to 0, "deleted" to 0))
                return@AsyncFunction
            }

            // Ensure key exists
            Log.d(TAG, "syncCredentials: Ensuring biometric key exists...")
            storageManager.biometricKeyManager.generateKey()
            Log.d(TAG, "syncCredentials: Key exists = ${storageManager.biometricKeyManager.keyExists()}")

            // Function to perform the actual sync (called after auth succeeds)
            fun performSync() {
                Log.d(TAG, "performSync: Starting sync operation...")
                moduleScope.launch {
                    try {
                        var syncedCount = 0
                        val incomingItemIds = mutableSetOf<String>()

                        // Save/update each credential
                        for (params in credentials) {
                            val vaultId = params["vaultId"] as? String ?: continue
                            val itemId = params["itemId"] as? String ?: continue
                            val domain = params["domain"] as? String ?: continue
                            val username = params["username"] as? String ?: continue
                            val password = params["password"] as? String ?: continue
                            val displayName = params["displayName"] as? String ?: "$username @ $domain"
                            val iconUrl = params["iconUrl"] as? String

                            Log.d(TAG, "performSync: Saving credential for domain=$domain, username=$username")
                            incomingItemIds.add(itemId)

                            // Get cipher - will work for 30s after authentication
                            val cipher = storageManager.biometricKeyManager.getEncryptCipher()

                            storageManager.saveCredential(
                                cipher = cipher,
                                vaultId = vaultId,
                                itemId = itemId,
                                domain = domain,
                                username = username,
                                password = password,
                                displayName = displayName,
                                iconUrl = iconUrl
                            )
                            syncedCount++
                            Log.d(TAG, "performSync: Saved credential $syncedCount")
                        }

                        // Remove credentials that are no longer in the vault
                        val existingItemIds = storageManager.getAllItemIds()
                        val toDelete = existingItemIds - incomingItemIds
                        var deletedCount = 0
                        Log.d(TAG, "performSync: Checking for deletions. Existing: ${existingItemIds.size}, Incoming: ${incomingItemIds.size}, ToDelete: ${toDelete.size}")

                        for (itemId in toDelete) {
                            // Only delete if it's a vault item (not external)
                            val credential = storageManager.getAllCredentials()
                                .find { it.itemId == itemId && it.vaultId != "external" }
                            if (credential != null) {
                                storageManager.deleteCredential(credential.id)
                                deletedCount++
                            }
                        }

                        Log.d(TAG, "performSync: Complete! Synced=$syncedCount, Deleted=$deletedCount")

                        // Log current credential count
                        val totalCount = storageManager.getCredentialCount()
                        Log.d(TAG, "performSync: Total credentials in database: $totalCount")

                        sendEvent("onSyncComplete", mapOf(
                            "synced" to syncedCount,
                            "deleted" to deletedCount
                        ))

                        promise.resolve(mapOf(
                            "synced" to syncedCount,
                            "deleted" to deletedCount
                        ))
                    } catch (e: Exception) {
                        Log.e(TAG, "performSync: Failed to sync credentials", e)
                        promise.reject("SYNC_FAILED", "Failed to sync credentials: ${e.message}", e)
                    }
                }
            }

            // Check if we need authentication by trying to use the key
            val needsAuth = storageManager.biometricKeyManager.requiresAuthentication()

            if (!needsAuth) {
                // User authenticated recently (within 30s), can sync directly
                performSync()
                return@AsyncFunction
            }

            // Need to authenticate first - show BiometricPrompt without CryptoObject
            // (time-bound auth doesn't need crypto-bound authentication)
            activity.runOnUiThread {
                try {
                    val executor = ContextCompat.getMainExecutor(context)

                    val biometricPrompt = BiometricPrompt(activity, executor, object : BiometricPrompt.AuthenticationCallback() {
                        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                            // Auth succeeded - key is now usable for 30 seconds
                            performSync()
                        }

                        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                            promise.reject("AUTH_ERROR", errString.toString(), null)
                        }

                        override fun onAuthenticationFailed() {
                            // Let user retry
                        }
                    })

                    val promptInfo = BiometricPrompt.PromptInfo.Builder()
                        .setTitle("Sync Passwords")
                        .setSubtitle("Authenticate to sync passwords for autofill")
                        .setAllowedAuthenticators(
                            BiometricManager.Authenticators.BIOMETRIC_STRONG or
                            BiometricManager.Authenticators.DEVICE_CREDENTIAL
                        )
                        .build()

                    // Authenticate without CryptoObject for time-bound auth
                    biometricPrompt.authenticate(promptInfo)
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to show biometric prompt", e)
                    promise.reject("PROMPT_FAILED", "Failed to show authentication prompt: ${e.message}", e)
                }
            }
        }

        /**
         * Get all stored credentials (metadata only, no passwords).
         */
        AsyncFunction("getAllCredentials") { promise: Promise ->
            moduleScope.launch {
                try {
                    val credentials = withContext(Dispatchers.IO) {
                        storageManager.getAllCredentials()
                    }

                    val result = credentials.map { credential ->
                        mapOf(
                            "id" to credential.id,
                            "vaultId" to credential.vaultId,
                            "itemId" to credential.itemId,
                            "domain" to credential.domain,
                            "username" to credential.username,
                            "displayName" to credential.displayName,
                            "iconUrl" to (credential.iconUrl ?: ""),
                            "lastUsedAt" to credential.lastUsedAt,
                            "syncedAt" to credential.syncedAt
                        )
                    }

                    promise.resolve(result)
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to get credentials", e)
                    promise.reject("GET_FAILED", "Failed to get credentials: ${e.message}", e)
                }
            }
        }

        /**
         * Get the count of stored credentials.
         */
        AsyncFunction("getCredentialCount") { promise: Promise ->
            moduleScope.launch {
                try {
                    val count = withContext(Dispatchers.IO) {
                        storageManager.getCredentialCount()
                    }
                    promise.resolve(count)
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to get credential count", e)
                    promise.reject("COUNT_FAILED", "Failed to get credential count: ${e.message}", e)
                }
            }
        }

        /**
         * Delete a credential by ID.
         */
        AsyncFunction("deleteCredential") { id: String, promise: Promise ->
            moduleScope.launch {
                try {
                    withContext(Dispatchers.IO) {
                        storageManager.deleteCredential(id)
                    }
                    sendEvent("onCredentialDeleted", mapOf("id" to id))
                    promise.resolve(true)
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to delete credential", e)
                    promise.reject("DELETE_FAILED", "Failed to delete credential: ${e.message}", e)
                }
            }
        }

        /**
         * Clear all stored credentials and delete the encryption key.
         */
        AsyncFunction("clearAllCredentials") { promise: Promise ->
            moduleScope.launch {
                try {
                    withContext(Dispatchers.IO) {
                        storageManager.clearAll()
                    }
                    promise.resolve(true)
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to clear credentials", e)
                    promise.reject("CLEAR_FAILED", "Failed to clear credentials: ${e.message}", e)
                }
            }
        }

        /**
         * Check if the biometric key exists and is valid.
         */
        Function("isKeyAvailable") {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
                Log.d(TAG, "isKeyAvailable: false (SDK < M)")
                false
            } else {
                val exists = storageManager.biometricKeyManager.keyExists()
                Log.d(TAG, "isKeyAvailable: $exists")
                exists
            }
        }

        /**
         * Initialize the biometric key if it doesn't exist.
         */
        AsyncFunction("initializeKey") { promise: Promise ->
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
                promise.reject("UNSUPPORTED", "Biometric key requires Android 6.0 or higher", null)
                return@AsyncFunction
            }

            moduleScope.launch {
                try {
                    withContext(Dispatchers.IO) {
                        storageManager.biometricKeyManager.generateKey()
                    }
                    promise.resolve(true)
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to initialize key", e)
                    promise.reject("INIT_FAILED", "Failed to initialize key: ${e.message}", e)
                }
            }
        }

        /**
         * Get debug info about the credential provider state.
         */
        AsyncFunction("getDebugInfo") { promise: Promise ->
            moduleScope.launch {
                try {
                    val credentials = withContext(Dispatchers.IO) {
                        storageManager.getAllCredentials()
                    }

                    val biometricManager = BiometricManager.from(context)
                    val canAuthenticate = biometricManager.canAuthenticate(
                        BiometricManager.Authenticators.BIOMETRIC_STRONG or
                        BiometricManager.Authenticators.DEVICE_CREDENTIAL
                    )

                    val debugInfo = mapOf(
                        "sdkVersion" to Build.VERSION.SDK_INT,
                        "minRequiredSdk" to MIN_API_LEVEL,
                        "isApiAvailable" to (Build.VERSION.SDK_INT >= MIN_API_LEVEL),
                        "keyExists" to storageManager.biometricKeyManager.keyExists(),
                        "biometricCanAuthenticate" to canAuthenticate,
                        "biometricSuccess" to (canAuthenticate == BiometricManager.BIOMETRIC_SUCCESS),
                        "credentialCount" to credentials.size,
                        "credentials" to credentials.map { cred ->
                            mapOf(
                                "id" to cred.id,
                                "domain" to cred.domain,
                                "username" to cred.username,
                                "displayName" to cred.displayName,
                                "vaultId" to cred.vaultId,
                                "itemId" to cred.itemId,
                                "lastUsedAt" to cred.lastUsedAt,
                                "syncedAt" to cred.syncedAt
                            )
                        }
                    )

                    Log.d(TAG, "Debug info: $debugInfo")
                    promise.resolve(debugInfo)
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to get debug info", e)
                    promise.reject("DEBUG_FAILED", "Failed to get debug info: ${e.message}", e)
                }
            }
        }
    }
}
