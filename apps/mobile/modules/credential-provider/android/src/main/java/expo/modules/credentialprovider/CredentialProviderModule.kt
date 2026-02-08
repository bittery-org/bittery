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
import expo.modules.credentialprovider.crypto.MukEscrowManager
import expo.modules.credentialprovider.state.VaultStateManager
import expo.modules.credentialprovider.storage.CredentialStorageManager
import expo.modules.credentialprovider.storage.CredentialDatabase
import expo.modules.credentialprovider.storage.CredentialEntity
import expo.modules.credentialprovider.storage.VaultKeyEntity
import expo.modules.credentialprovider.storage.ItemEntity
import expo.modules.credentialprovider.storage.ItemDomainEntity
import expo.modules.credentialprovider.storage.AuthDataEntity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.json.JSONArray

class CredentialProviderModule : Module() {
    companion object {
        private const val TAG = "CredentialProviderModule"
        private const val MIN_API_LEVEL = Build.VERSION_CODES.UPSIDE_DOWN_CAKE // API 34

        /**
         * Extract domain from URL for autofill matching.
         * Examples:
         *   - "https://www.example.com/login" -> "example.com"
         *   - "https://login.example.com" -> "login.example.com"
         *   - "example.com" -> "example.com"
         */
        private fun extractDomain(url: String): String? {
            if (url.isBlank()) return null
            return try {
                val host = if (url.startsWith("http://") || url.startsWith("https://")) {
                    java.net.URL(url).host
                } else {
                    // Assume it's already a domain
                    url
                }
                // Remove www. prefix
                host.removePrefix("www.")
            } catch (e: Exception) {
                Log.w(TAG, "Failed to extract domain from: $url", e)
                null
            }
        }
    }

    private val moduleScope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    private val context: Context
        get() = requireNotNull(appContext.reactContext)

    private val storageManager: CredentialStorageManager by lazy {
        CredentialStorageManager(context)
    }

    private val mukEscrowManager: MukEscrowManager by lazy {
        MukEscrowManager(context)
    }

    private val database: CredentialDatabase by lazy {
        CredentialDatabase.getInstance(context)
    }

    private val currentActivity: FragmentActivity?
        get() = appContext.currentActivity as? FragmentActivity

    override fun definition() = ModuleDefinition {
        Name("CredentialProvider")

        Events("onCredentialSaved", "onCredentialDeleted", "onSyncComplete", "onVaultLocked", "onVaultUnlocked")

        // ============================================
        // Vault State Management (VaultStateManager)
        // ============================================

        /**
         * Set the Master Unlock Key from React Native after successful login/unlock.
         * This makes the MUK available to the CredentialProviderService for decryption.
         *
         * @param mukBase64 Base64-encoded Master Unlock Key (32 bytes = 44 chars)
         */
        Function("setMasterUnlockKey") { mukBase64: String, userId: String? ->
            try {
                val resolvedUserId = userId?.takeIf { it.isNotBlank() } ?: "default"
                VaultStateManager.setMasterUnlockKeyFromBase64(mukBase64, resolvedUserId)
                Log.d(TAG, "setMasterUnlockKey: MUK set successfully")
                sendEvent("onVaultUnlocked", mapOf("success" to true))
                true
            } catch (e: Exception) {
                Log.e(TAG, "setMasterUnlockKey: Failed to set MUK", e)
                false
            }
        }

        /**
         * Clear the Master Unlock Key (on logout or auto-lock).
         */
        Function("clearMasterUnlockKey") { userId: String? ->
            if (userId.isNullOrBlank()) {
                VaultStateManager.clearAllMasterUnlockKeys()
            } else {
                VaultStateManager.clearMasterUnlockKey(userId)
            }
            Log.d(TAG, "clearMasterUnlockKey: MUK cleared")
            sendEvent("onVaultLocked", mapOf("success" to true))
            true
        }

        Function("clearAllMasterUnlockKeys") {
            VaultStateManager.clearAllMasterUnlockKeys()
            Log.d(TAG, "clearAllMasterUnlockKeys: MUKs cleared")
            sendEvent("onVaultLocked", mapOf("success" to true))
            true
        }

        /**
         * Check if the vault is currently unlocked (MUK available).
         */
        Function("isVaultUnlocked") { userId: String? ->
            val unlocked = if (userId.isNullOrBlank()) {
                VaultStateManager.isUnlocked()
            } else {
                VaultStateManager.isUnlocked(userId)
            }
            Log.d(TAG, "isVaultUnlocked: $unlocked")
            unlocked
        }

        /**
         * Get the MUK as Base64 string (for debugging/verification only).
         * WARNING: Only use in development builds.
         */
        Function("getMasterUnlockKeyBase64") { userId: String? ->
            if (userId.isNullOrBlank()) {
                VaultStateManager.getMasterUnlockKeyBase64()
            } else {
                VaultStateManager.getMasterUnlockKeyBase64(userId)
            }
        }

        // ============================================
        // MUK Escrow Management (MukEscrowManager)
        // ============================================

        /**
         * Escrow the MUK with biometric protection after password unlock.
         * This enables future biometric-only unlocks without re-entering password.
         *
         * @param email The account email this escrow is for
         * @param timeoutMs Optional escrow timeout in milliseconds (default 10 min)
         */
        AsyncFunction("escrowMukWithBiometric") { params: Map<String, Any>, promise: Promise ->
            val activity = currentActivity
            if (activity == null) {
                promise.reject("NO_ACTIVITY", "No activity available", null)
                return@AsyncFunction
            }

            val email = params["email"] as? String ?: ""
            val userId = params["userId"] as? String
            val timeoutMs = (params["timeoutMs"] as? Number)?.toLong()
                ?: MukEscrowManager.DEFAULT_ESCROW_TIMEOUT_MS

            if (email.isEmpty()) {
                promise.reject("INVALID_PARAMS", "email is required", null)
                return@AsyncFunction
            }

            val muk = if (userId.isNullOrBlank()) {
                VaultStateManager.getMasterUnlockKey()
            } else {
                VaultStateManager.getMasterUnlockKey(userId)
            }
            if (muk == null) {
                promise.reject("VAULT_LOCKED", "Vault is not unlocked", null)
                return@AsyncFunction
            }

            // Generate escrow key if needed
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                mukEscrowManager.generateKey()
            }

            // Function to perform escrow after auth
            fun performEscrow(cipher: javax.crypto.Cipher) {
                moduleScope.launch {
                    try {
                        mukEscrowManager.escrowMuk(muk, cipher, email, timeoutMs, userId)
                        Log.d(TAG, "escrowMukWithBiometric: MUK escrowed successfully for $email")
                        promise.resolve(true)
                    } catch (e: Exception) {
                        Log.e(TAG, "escrowMukWithBiometric: Failed to escrow MUK", e)
                        promise.reject("ESCROW_FAILED", "Failed to escrow MUK: ${e.message}", e)
                    }
                }
            }

            activity.runOnUiThread {
                try {
                    val cipher = mukEscrowManager.getEncryptCipher()
                    val executor = ContextCompat.getMainExecutor(context)

                    val biometricPrompt = BiometricPrompt(activity, executor, object : BiometricPrompt.AuthenticationCallback() {
                        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                            result.cryptoObject?.cipher?.let { performEscrow(it) }
                                ?: promise.reject("AUTH_ERROR", "No cipher after authentication", null)
                        }

                        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                            promise.reject("AUTH_ERROR", errString.toString(), null)
                        }

                        override fun onAuthenticationFailed() {
                            // Let user retry
                        }
                    })

                    val promptInfo = BiometricPrompt.PromptInfo.Builder()
                        .setTitle("Enable Quick Unlock")
                        .setSubtitle("Authenticate to enable biometric unlock")
                        .setAllowedAuthenticators(
                            BiometricManager.Authenticators.BIOMETRIC_STRONG or
                            BiometricManager.Authenticators.DEVICE_CREDENTIAL
                        )
                        .build()

                    biometricPrompt.authenticate(
                        promptInfo,
                        BiometricPrompt.CryptoObject(cipher)
                    )
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to show biometric prompt for escrow", e)
                    promise.reject("PROMPT_FAILED", "Failed to show authentication prompt: ${e.message}", e)
                }
            }
        }

        /**
         * Retrieve the escrowed MUK using biometric authentication.
         * This unlocks the vault without requiring password entry.
         */
        AsyncFunction("retrieveEscrowedMuk") { promise: Promise ->
            val activity = currentActivity
            if (activity == null) {
                promise.reject("NO_ACTIVITY", "No activity available", null)
                return@AsyncFunction
            }

            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
                promise.reject("UNSUPPORTED", "MUK escrow requires Android 6.0 or higher", null)
                return@AsyncFunction
            }

            if (!mukEscrowManager.hasValidEscrow()) {
                promise.reject("NO_ESCROW", "No valid MUK escrow available", null)
                return@AsyncFunction
            }

            // Function to perform retrieval after auth
            fun performRetrieval(cipher: javax.crypto.Cipher) {
                moduleScope.launch {
                    try {
                        val muk = mukEscrowManager.retrieveEscrowedMuk(cipher)
                        val escrowUserId = mukEscrowManager.getEscrowUserId()
                        if (escrowUserId.isNullOrBlank()) {
                            VaultStateManager.setMasterUnlockKey(muk)
                        } else {
                            VaultStateManager.setMasterUnlockKey(escrowUserId, muk)
                        }
                        Log.d(TAG, "retrieveEscrowedMuk: MUK retrieved and set successfully")
                        sendEvent("onVaultUnlocked", mapOf("success" to true))
                        promise.resolve(true)
                    } catch (e: Exception) {
                        Log.e(TAG, "retrieveEscrowedMuk: Failed to retrieve MUK", e)
                        promise.reject("RETRIEVE_FAILED", "Failed to retrieve MUK: ${e.message}", e)
                    }
                }
            }

            activity.runOnUiThread {
                try {
                    val cipher = mukEscrowManager.getDecryptCipher()
                    val executor = ContextCompat.getMainExecutor(context)

                    val biometricPrompt = BiometricPrompt(activity, executor, object : BiometricPrompt.AuthenticationCallback() {
                        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                            result.cryptoObject?.cipher?.let { performRetrieval(it) }
                                ?: promise.reject("AUTH_ERROR", "No cipher after authentication", null)
                        }

                        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                            promise.reject("AUTH_ERROR", errString.toString(), null)
                        }

                        override fun onAuthenticationFailed() {
                            // Let user retry
                        }
                    })

                    val promptInfo = BiometricPrompt.PromptInfo.Builder()
                        .setTitle("Unlock Bittery")
                        .setSubtitle("Authenticate to access your passwords")
                        .setAllowedAuthenticators(
                            BiometricManager.Authenticators.BIOMETRIC_STRONG or
                            BiometricManager.Authenticators.DEVICE_CREDENTIAL
                        )
                        .build()

                    biometricPrompt.authenticate(
                        promptInfo,
                        BiometricPrompt.CryptoObject(cipher)
                    )
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to show biometric prompt for retrieval", e)
                    promise.reject("PROMPT_FAILED", "Failed to show authentication prompt: ${e.message}", e)
                }
            }
        }

        /**
         * Check if there is a valid (non-expired) MUK escrow.
         */
        Function("hasValidEscrow") {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
                false
            } else {
                val hasEscrow = mukEscrowManager.hasValidEscrow()
                Log.d(TAG, "hasValidEscrow: $hasEscrow")
                hasEscrow
            }
        }

        /**
         * Check if there is a valid escrow for a specific email.
         */
        Function("hasValidEscrowForEmail") { email: String ->
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
                false
            } else {
                mukEscrowManager.hasValidEscrowForEmail(email)
            }
        }

        // ============================================
        // 30-Day Master Password Re-entry
        // ============================================

        /**
         * Check if master password re-entry is required (> 30 days since last entry).
         */
        Function("isMasterPasswordReentryRequired") {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
                true  // Always require password on old devices
            } else {
                mukEscrowManager.isMasterPasswordReentryRequired()
            }
        }

        /**
         * Check if biometric unlock can be used (combines escrow validity and 30-day check).
         */
        Function("canUseBiometricUnlock") {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
                false
            } else {
                mukEscrowManager.canUseBiometricUnlock()
            }
        }

        /**
         * Update the last master password entry timestamp.
         * Call this after successful password-based unlock.
         */
        Function("updateLastMasterPasswordEntry") {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                mukEscrowManager.updateLastMasterPasswordEntry()
                Log.d(TAG, "updateLastMasterPasswordEntry: timestamp updated")
            }
            true
        }

        /**
         * Get the timestamp of the last master password entry.
         */
        Function("getLastMasterPasswordEntry") {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
                0L
            } else {
                mukEscrowManager.getLastMasterPasswordEntry()
            }
        }

        /**
         * Get remaining escrow time in milliseconds.
         */
        Function("getEscrowRemainingTime") {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
                0L
            } else {
                mukEscrowManager.getEscrowRemainingTime()
            }
        }

        /**
         * Clear the MUK escrow (on logout or when password required).
         */
        Function("clearEscrow") {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                mukEscrowManager.clearEscrow()
            }
            Log.d(TAG, "clearEscrow: Escrow cleared")
            true
        }

        // ============================================
        // Credential Provider API Availability
        // ============================================

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
         * Sync vault keys and items for the new vault-based autofill system.
         * This syncs encrypted vault data directly from the server without requiring
         * biometric authentication. Decryption happens on-demand using MUK.
         *
         * @param dataJson JSON string containing:
         *   - userId: String
         *   - vaultKeys: List of vault key objects
         *   - items: List of item objects (login items only)
         */
        AsyncFunction("syncVaultData") { dataJson: String, promise: Promise ->
            Log.d(TAG, "syncVaultData called")

            moduleScope.launch {
                try {
                    // Parse JSON string
                    val jsonObject = JSONObject(dataJson)
                    val userId = jsonObject.optString("userId", "")

                    if (userId.isBlank()) {
                        promise.reject("INVALID_PARAMS", "userId is required", null)
                        return@launch
                    }

                    val vaultKeysJson = jsonObject.optJSONArray("vaultKeys") ?: JSONArray()
                    val itemsJson = jsonObject.optJSONArray("items") ?: JSONArray()

                    // Convert JSONArray to List<Map<String, Any>>
                    val vaultKeysData = (0 until vaultKeysJson.length()).map { i ->
                        val obj = vaultKeysJson.getJSONObject(i)
                        obj.keys().asSequence().associateWith { key -> obj.get(key) }
                    }

                    val itemsData = (0 until itemsJson.length()).map { i ->
                        val obj = itemsJson.getJSONObject(i)
                        obj.keys().asSequence().associateWith { key -> obj.get(key) }
                    }

                    Log.d(TAG, "syncVaultData: Syncing ${vaultKeysData.size} vault keys and ${itemsData.size} items for user $userId")

                    withContext(Dispatchers.IO) {
                        // Ensure AuthDataEntity exists for this user
                        // If it doesn't exist, create a minimal one
                        val existingAuthData = database.authDataDao().getByUserId(userId)
                        if (existingAuthData == null) {
                            Log.d(TAG, "Creating minimal AuthDataEntity for user $userId")
                            val authData = AuthDataEntity(
                                email = "", // Will be updated when we have the email
                                userId = userId,
                                secretKey = "", // Placeholder
                                srpSalt = "",
                                publicKey = "",
                                encryptedPrivateKey = "",
                                encryptedPrivateKeyIv = ""
                            )
                            database.authDataDao().insert(authData)
                        }

                        // Parse and insert vault keys
                        val vaultKeys = vaultKeysData.mapNotNull { keyData ->
                            try {
                                VaultKeyEntity(
                                    vaultId = keyData["vaultId"] as? String ?: return@mapNotNull null,
                                    userId = userId,
                                    vaultName = keyData["vaultName"] as? String ?: "",
                                    vaultType = keyData["vaultType"] as? String ?: "personal",
                                    encryptedKey = keyData["encryptedKey"] as? String ?: return@mapNotNull null,
                                    encryptionIv = keyData["encryptionIv"] as? String ?: return@mapNotNull null,
                                    encryptionAlgorithm = keyData["encryptionAlgorithm"] as? String ?: "AES-GCM",
                                    role = keyData["role"] as? String ?: "member",
                                    syncedAt = System.currentTimeMillis()
                                )
                            } catch (e: Exception) {
                                Log.w(TAG, "Failed to parse vault key: ${keyData["vaultId"]}", e)
                                null
                            }
                        }

                        if (vaultKeys.isNotEmpty()) {
                            database.vaultKeyDao().insertAll(vaultKeys)
                            Log.d(TAG, "Inserted ${vaultKeys.size} vault keys")
                        }

                        // Parse and insert items
                        val items = itemsData.mapNotNull { itemData ->
                            try {
                                val itemId = itemData["id"] as? String ?: return@mapNotNull null
                                val vaultId = itemData["vaultId"] as? String ?: return@mapNotNull null
                                val category = itemData["category"] as? String ?: return@mapNotNull null

                                // Only sync login items
                                if (category != "login") return@mapNotNull null

                                @Suppress("UNCHECKED_CAST")
                                val urls = itemData["urls"] as? List<String> ?: emptyList()
                                val primaryDomain = urls.firstOrNull()?.let { extractDomain(it) }

                                ItemEntity(
                                    id = itemId,
                                    vaultId = vaultId,
                                    userId = userId,
                                    category = category,
                                    displayTitle = itemData["displayTitle"] as? String ?: "",
                                    encryptedData = itemData["encryptedData"] as? String ?: return@mapNotNull null,
                                    encryptionIv = itemData["encryptionIv"] as? String ?: return@mapNotNull null,
                                    encryptionAlgorithm = itemData["encryptionAlgorithm"] as? String ?: "AES-GCM",
                                    primaryDomain = primaryDomain,
                                    username = itemData["username"] as? String,
                                    iconUrl = itemData["iconUrl"] as? String,
                                    lastUsedAt = (itemData["lastUsedAt"] as? Number)?.toLong() ?: 0L,
                                    syncedAt = System.currentTimeMillis(),
                                    createdAt = (itemData["createdAt"] as? Number)?.toLong() ?: System.currentTimeMillis(),
                                    updatedAt = (itemData["updatedAt"] as? Number)?.toLong() ?: System.currentTimeMillis(),
                                    isFavorite = itemData["isFavorite"] as? Boolean ?: false
                                )
                            } catch (e: Exception) {
                                Log.w(TAG, "Failed to parse item: ${itemData["id"]}", e)
                                null
                            }
                        }

                        if (items.isNotEmpty()) {
                            database.itemDao().insertAll(items)
                            Log.d(TAG, "Inserted ${items.size} items")
                        }

                        // Insert domain mappings for each item
                        var totalDomains = 0
                        for (i in 0 until itemsJson.length()) {
                            try {
                                val item = itemsJson.getJSONObject(i)
                                val itemId = item.optString("id", "")
                                if (itemId.isEmpty()) continue

                                val category = item.optString("category", "")
                                if (category != "login") continue

                                // Parse URLs array from JSON
                                val urlsJson = item.optJSONArray("urls") ?: JSONArray()
                                val urls = (0 until urlsJson.length()).map { i ->
                                    urlsJson.getString(i)
                                }

                                if (urls.isEmpty()) {
                                    Log.d(TAG, "Item $itemId has no URLs, skipping domain mapping")
                                    continue
                                }

                                val domains = urls.mapIndexedNotNull { urlIndex, url ->
                                    val domain = extractDomain(url) ?: return@mapIndexedNotNull null
                                    ItemDomainEntity(
                                        itemId = itemId,
                                        domain = domain,
                                        isPrimary = urlIndex == 0,
                                        fullUrl = url
                                    )
                                }

                                if (domains.isNotEmpty()) {
                                    database.itemDomainDao().replaceDomainsForItem(itemId, domains)
                                    totalDomains += domains.size
                                    Log.d(TAG, "Inserted ${domains.size} domains for item $itemId: ${domains.map { it.domain }}")
                                }
                            } catch (e: Exception) {
                                Log.w(TAG, "Failed to process domains for item at index $i", e)
                            }
                        }

                        Log.d(TAG, "Inserted $totalDomains domain mappings")

                        // Clean up vault keys that are no longer present
                        val incomingVaultIds = vaultKeys.map { it.vaultId }.toSet()
                        val existingVaultIds = database.vaultKeyDao().getVaultIdsByUserId(userId)
                        val vaultKeysToDelete = existingVaultIds - incomingVaultIds

                        var deletedVaultKeys = 0
                        for (vaultId in vaultKeysToDelete) {
                            database.vaultKeyDao().delete(vaultId, userId)
                            deletedVaultKeys++
                        }

                        // Clean up items that are no longer present
                        val incomingItemIds = items.map { it.id }.toSet()
                        val existingItemIds = database.itemDao().getItemIdsByUserId(userId)
                        val itemsToDelete = existingItemIds - incomingItemIds

                        var deletedItems = 0
                        for (itemId in itemsToDelete) {
                            database.itemDao().deleteById(itemId)
                            deletedItems++
                        }

                        Log.d(TAG, "Cleanup: Deleted $deletedVaultKeys vault keys, $deletedItems items")

                        val result = mapOf(
                            "vaultKeys" to vaultKeys.size,
                            "items" to items.size,
                            "domains" to totalDomains,
                            "deletedVaultKeys" to deletedVaultKeys,
                            "deletedItems" to deletedItems
                        )

                        Log.d(TAG, "syncVaultData complete: $result")
                        promise.resolve(result)
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "syncVaultData failed", e)
                    promise.reject("SYNC_FAILED", "Failed to sync vault data: ${e.message}", e)
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
         * Get count of vault-based items stored in the database.
         */
        AsyncFunction("getVaultItemCount") { promise: Promise ->
            moduleScope.launch {
                try {
                    val count = withContext(Dispatchers.IO) {
                        database.itemDao().getCount()
                    }
                    promise.resolve(count)
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to get vault item count", e)
                    promise.reject("COUNT_FAILED", "Failed to get vault item count: ${e.message}", e)
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
