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
import expo.modules.credentialprovider.crypto.MukEscrowManager
import expo.modules.credentialprovider.crypto.VaultDecryptor
import expo.modules.credentialprovider.domain.DomainMatch
import expo.modules.credentialprovider.state.VaultStateManager
import expo.modules.credentialprovider.storage.CredentialDatabase
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
    }

    private val moduleScope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    private val context: Context
        get() = requireNotNull(appContext.reactContext)

    private val mukEscrowManager: MukEscrowManager by lazy {
        MukEscrowManager(context)
    }

    private val database: CredentialDatabase by lazy {
        CredentialDatabase.getInstance(context)
    }

    private val currentActivity: FragmentActivity?
        get() = appContext.currentActivity as? FragmentActivity

    private fun ensureVaultStateManagerInitialized() {
        try {
            VaultStateManager.initialize(context)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to initialize VaultStateManager", e)
        }
    }

    private fun collectCandidateDomainsFromItemJson(itemDataJson: JSONObject): List<String> {
        val domains = LinkedHashSet<String>()

        domains.addAll(DomainMatch.lookupKeys(itemDataJson.optString("url")))

        val urlsJson = itemDataJson.optJSONArray("urls")
        if (urlsJson != null) {
            for (index in 0 until urlsJson.length()) {
                domains.addAll(DomainMatch.lookupKeys(urlsJson.optString(index, "")))
            }
        }

        val passkeysJson = itemDataJson.optJSONArray("passkeys")
        if (passkeysJson != null) {
            for (index in 0 until passkeysJson.length()) {
                val passkey = passkeysJson.optJSONObject(index) ?: continue
                domains.addAll(DomainMatch.lookupKeys(passkey.optString("rpId", "")))
            }
        }

        return domains.toList()
    }

    private suspend fun recoverDomainsFromEncryptedItem(
        itemEntity: ItemEntity,
        muk: ByteArray
    ): List<String> {
        return try {
            val vaultKey = database.vaultKeyDao().getByVaultId(itemEntity.vaultId, itemEntity.userId)
                ?: return emptyList()
            val decryptedVaultKey = VaultDecryptor.decryptVaultKeyWithMuk(vaultKey, muk)
            val itemDataJson = VaultDecryptor.decryptItemJson(itemEntity, decryptedVaultKey)
            collectCandidateDomainsFromItemJson(itemDataJson)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to recover domains from encrypted item ${itemEntity.id}", e)
            emptyList()
        }
    }

    override fun definition() = ModuleDefinition {
        Name("CredentialProvider")

		Events("onVaultLocked", "onVaultUnlocked")

        // ============================================
        // Vault State Management (VaultStateManager)
        // ============================================

        /**
         * Set the Master Unlock Key from React Native after successful login/unlock.
         * This makes the MUK available to the CredentialProviderService for decryption.
         *
         * @param mukBase64 Base64-encoded Master Unlock Key (32 bytes = 44 chars)
         */
        Function("setMasterUnlockKey") { mukBase64: String, userId: String?, autoLockTimeoutMs: Double? ->
            try {
                ensureVaultStateManagerInitialized()
                val resolvedUserId = userId?.takeIf { it.isNotBlank() } ?: "default"
                val resolvedTimeoutMs = autoLockTimeoutMs?.toLong()
                Log.d(TAG, "setMasterUnlockKey: CALLED from RN bridge (userId='$resolvedUserId', mukBase64Length=${mukBase64.length}, timeoutMs=$resolvedTimeoutMs, pid=${android.os.Process.myPid()})")
                VaultStateManager.setMasterUnlockKeyFromBase64(mukBase64, resolvedUserId, resolvedTimeoutMs)
                Log.d(TAG, "setMasterUnlockKey: MUK set successfully, verifying...")
                val verifyUnlocked = VaultStateManager.isUnlocked(resolvedUserId)
                Log.d(TAG, "setMasterUnlockKey: Verification isUnlocked($resolvedUserId)=$verifyUnlocked")
                sendEvent("onVaultUnlocked", mapOf("success" to true))
                true
            } catch (e: Exception) {
                Log.e(TAG, "setMasterUnlockKey: Failed to set MUK", e)
                false
            }
        }

        Function("setMukAutoLockTimeout") { timeoutMs: Double, userId: String? ->
            try {
                ensureVaultStateManagerInitialized()
                val resolvedUserId = userId?.takeIf { it.isNotBlank() } ?: "default"
                val resolvedTimeoutMs = timeoutMs.toLong()
                Log.d(TAG, "setMukAutoLockTimeout: userId='$resolvedUserId', timeoutMs=$resolvedTimeoutMs")
                VaultStateManager.setMukAutoLockTimeout(resolvedUserId, resolvedTimeoutMs)
                true
            } catch (e: Exception) {
                Log.e(TAG, "setMukAutoLockTimeout: failed", e)
                false
            }
        }

        /**
         * Clear the Master Unlock Key (on logout or auto-lock).
         */
        Function("clearMasterUnlockKey") { userId: String? ->
            ensureVaultStateManagerInitialized()
            Log.w(TAG, "clearMasterUnlockKey: CALLED from RN bridge (userId='$userId', pid=${android.os.Process.myPid()})")
            VaultStateManager.dumpDebugState("BEFORE clearMasterUnlockKey")
            if (userId.isNullOrBlank()) {
                VaultStateManager.clearAllMasterUnlockKeys()
            } else {
                VaultStateManager.clearMasterUnlockKey(userId)
            }
            VaultStateManager.dumpDebugState("AFTER clearMasterUnlockKey")
            sendEvent("onVaultLocked", mapOf("success" to true))
            true
        }

        Function("clearAllMasterUnlockKeys") {
            ensureVaultStateManagerInitialized()
            Log.w(TAG, "clearAllMasterUnlockKeys: CALLED from RN bridge (pid=${android.os.Process.myPid()})")
            VaultStateManager.dumpDebugState("BEFORE clearAllMasterUnlockKeys")
            VaultStateManager.clearAllMasterUnlockKeys()
            VaultStateManager.dumpDebugState("AFTER clearAllMasterUnlockKeys")
            sendEvent("onVaultLocked", mapOf("success" to true))
            true
        }

        /**
         * Check if the vault is currently unlocked (MUK available).
         */
        Function("isVaultUnlocked") { userId: String? ->
            ensureVaultStateManagerInitialized()
            Log.d(TAG, "isVaultUnlocked: CALLED from RN bridge (userId='$userId', pid=${android.os.Process.myPid()})")
            val unlocked = if (userId.isNullOrBlank()) {
                VaultStateManager.isUnlocked()
            } else {
                VaultStateManager.isUnlocked(userId)
            }
            if (!unlocked) {
                VaultStateManager.dumpDebugState("isVaultUnlocked=FALSE")
            }
            unlocked
        }

        /**
         * Get the MUK as Base64 string (for debugging/verification only).
         * WARNING: Only use in development builds.
         */
        Function("getMasterUnlockKeyBase64") { userId: String? ->
            ensureVaultStateManagerInitialized()
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
            ensureVaultStateManagerInitialized()
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
            ensureVaultStateManagerInitialized()
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
         * Sync vault keys and items for the new vault-based autofill system.
         * This syncs encrypted vault data directly from the server without requiring
         * biometric authentication. Decryption happens on-demand using MUK.
         *
         * @param dataJson JSON string containing:
         *   - userId: String
         *   - email: String
         *   - secretKey: String
         *   - kdfProfile: { schemaVersion, algorithm, iterations }
         *   - vaultKeys: List of vault key objects
         *   - items: List of item objects (login items only)
         */
        AsyncFunction("syncVaultData") { dataJson: String, promise: Promise ->
            ensureVaultStateManagerInitialized()
            Log.d(TAG, "syncVaultData called")

            moduleScope.launch {
                try {
                    // Parse JSON string
                    val jsonObject = JSONObject(dataJson)
                    val userId = jsonObject.optString("userId", "")
                    val email = jsonObject.optString("email", "")
                    val secretKey = jsonObject.optString("secretKey", "")
                    val kdfProfile = jsonObject.optJSONObject("kdfProfile")

                    if (userId.isBlank() || email.isBlank() || secretKey.isBlank() || kdfProfile == null) {
                        promise.reject("INVALID_PARAMS", "Complete account and KDF profile data is required", null)
                        return@launch
                    }

                    val kdfSchemaVersion = kdfProfile.optInt("schemaVersion", -1)
                    val kdfAlgorithm = kdfProfile.optString("algorithm", "")
                    val kdfIterations = kdfProfile.optInt("iterations", -1)
                    if (kdfSchemaVersion != 1 || kdfAlgorithm != "pbkdf2-sha256" || kdfIterations !in 600_000..1_200_000) {
                        promise.reject("INVALID_PARAMS", "Invalid KDF profile", null)
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
                        // Real account synchronization always replaces nullable
                        // placeholder profile metadata with a complete profile.
                        val existingAuthData = database.authDataDao().getByUserId(userId)
                        val authData = if (existingAuthData == null) {
                            AuthDataEntity(
                                email = email,
                                userId = userId,
                                secretKey = secretKey,
                                srpSalt = "",
                                publicKey = "",
                                encryptedPrivateKey = "",
                                encryptedPrivateKeyIv = "",
                                kdfSchemaVersion = kdfSchemaVersion,
                                kdfAlgorithm = kdfAlgorithm,
                                kdfIterations = kdfIterations
                            )
                        } else {
                            existingAuthData.copy(
                                email = email,
                                secretKey = secretKey,
                                kdfSchemaVersion = kdfSchemaVersion,
                                kdfAlgorithm = kdfAlgorithm,
                                kdfIterations = kdfIterations
                            )
                        }
                        database.authDataDao().insert(authData)

                        // Parse and insert vault keys
                        val vaultKeys = vaultKeysData.mapNotNull { keyData ->
                            try {
                                VaultKeyEntity(
                                    vaultId = keyData["vaultId"] as? String ?: return@mapNotNull null,
                                    userId = userId,
									vaultName = keyData["vaultName"] as? String ?: return@mapNotNull null,
									vaultType = keyData["vaultType"] as? String ?: return@mapNotNull null,
                                    encryptedKey = keyData["encryptedKey"] as? String ?: return@mapNotNull null,
                                    encryptionIv = keyData["encryptionIv"] as? String ?: return@mapNotNull null,
									encryptionAlgorithm = keyData["encryptionAlgorithm"] as? String ?: return@mapNotNull null,
									role = keyData["role"] as? String ?: return@mapNotNull null,
                                    syncedAt = System.currentTimeMillis(),
									keyVersion = (keyData["keyVersion"] as? Number)?.toLong() ?: return@mapNotNull null
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
                                val primaryDomain = urls.firstOrNull()
                                    ?.let { DomainMatch.normalizeHost(it) }
                                    ?.takeIf { it.isNotEmpty() }

                                ItemEntity(
                                    id = itemId,
                                    vaultId = vaultId,
                                    userId = userId,
                                    category = category,
                                    displayTitle = itemData["displayTitle"] as? String ?: "",
                                    encryptedData = itemData["encryptedData"] as? String ?: return@mapNotNull null,
                                    encryptionIv = itemData["encryptionIv"] as? String ?: return@mapNotNull null,
									encryptionAlgorithm = itemData["encryptionAlgorithm"] as? String ?: return@mapNotNull null,
                                    primaryDomain = primaryDomain,
                                    username = itemData["username"] as? String,
                                    iconUrl = itemData["iconUrl"] as? String,
                                    lastUsedAt = (itemData["lastUsedAt"] as? Number)?.toLong() ?: 0L,
                                    syncedAt = System.currentTimeMillis(),
                                    createdAt = (itemData["createdAt"] as? Number)?.toLong() ?: System.currentTimeMillis(),
                                    updatedAt = (itemData["updatedAt"] as? Number)?.toLong() ?: System.currentTimeMillis(),
                                    isFavorite = itemData["isFavorite"] as? Boolean ?: false,
									version = (itemData["version"] as? Number)?.toLong() ?: return@mapNotNull null,
                                    lastModifiedBy = itemData["lastModifiedBy"] as? String,
									encryptionVersion = (itemData["encryptionVersion"] as? Number)?.toLong() ?: return@mapNotNull null,
									encryptedByUserId = itemData["encryptedByUserId"] as? String ?: return@mapNotNull null
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

	                        val itemById = items.associateBy { it.id }
	                        val mukForDomainRepair = VaultStateManager.getMasterUnlockKey(userId)

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

	                                val domainsByValue = LinkedHashMap<String, ItemDomainEntity>()
	                                // Both the host and its registrable domain are indexed, and a
	                                // lookup queries both, so the SQL match is exactly
	                                // DomainMatch.matches - see the lookupKeys vectors.
	                                for (url in urls) {
	                                    for (domain in DomainMatch.lookupKeys(url)) {
	                                        if (!domainsByValue.containsKey(domain)) {
	                                            domainsByValue[domain] = ItemDomainEntity(
	                                                itemId = itemId,
	                                                domain = domain,
	                                                isPrimary = domainsByValue.isEmpty(),
	                                                fullUrl = url
	                                            )
	                                        }
	                                    }
	                                }

	                                if (domainsByValue.isEmpty()) {
	                                    val localItem = itemById[itemId]
	                                    if (mukForDomainRepair != null && localItem != null) {
	                                        val recoveredDomains = recoverDomainsFromEncryptedItem(localItem, mukForDomainRepair)
	                                        for (domain in recoveredDomains) {
	                                            if (!domainsByValue.containsKey(domain)) {
	                                                domainsByValue[domain] = ItemDomainEntity(
	                                                    itemId = itemId,
	                                                    domain = domain,
	                                                    isPrimary = domainsByValue.isEmpty(),
	                                                    fullUrl = "https://$domain"
	                                                )
	                                            }
	                                        }
	                                    }
	                                }

	                                val domains = domainsByValue.values.toList()

	                                if (domains.isNotEmpty()) {
	                                    database.itemDomainDao().replaceDomainsForItem(itemId, domains)
	                                    totalDomains += domains.size
	                                    Log.d(TAG, "Inserted ${domains.size} domains for item $itemId: ${domains.map { it.domain }}")
	                                }
	                                else {
	                                    Log.d(TAG, "Item $itemId still has no domains after repair, skipping domain mapping")
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
         * Get pending passkey mutations queued by the Android credential provider flows.
         */
        AsyncFunction("getPendingPasskeyMutations") { userId: String?, promise: Promise ->
            moduleScope.launch {
                try {
                    val entities = withContext(Dispatchers.IO) {
                        if (userId.isNullOrBlank()) {
                            database.pendingPasskeyMutationDao().getAll()
                        } else {
                            database.pendingPasskeyMutationDao().getByUserId(userId)
                        }
                    }

                    val result = entities.map { entity ->
                        mapOf(
                            "id" to entity.id,
                            "userId" to entity.userId,
                            "vaultId" to entity.vaultId,
                            "itemId" to entity.itemId,
                            "operation" to entity.operation,
                            "encryptedData" to entity.encryptedData,
                            "encryptionIv" to entity.encryptionIv,
                            "encryptionAlgorithm" to entity.encryptionAlgorithm,
                            "baseVersion" to entity.baseVersion,
                            "encryptionVersion" to entity.encryptionVersion,
                            "encryptedByUserId" to entity.encryptedByUserId,
                            "createdAt" to entity.createdAt,
                            "attemptCount" to entity.attemptCount,
                            "lastError" to entity.lastError
                        )
                    }

                    promise.resolve(result)
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to fetch pending passkey mutations", e)
                    promise.reject(
                        "GET_PENDING_PASSKEY_MUTATIONS_FAILED",
                        "Failed to fetch pending passkey mutations: ${e.message}",
                        e
                    )
                }
            }
        }

        /**
         * Mark queued passkey mutations as applied and remove them from local queue.
         */
        AsyncFunction("markPendingPasskeyMutationsApplied") { ids: List<String>, promise: Promise ->
            moduleScope.launch {
                try {
                    if (ids.isNotEmpty()) {
                        withContext(Dispatchers.IO) {
                            database.pendingPasskeyMutationDao().deleteByIds(ids)
                        }
                    }
                    promise.resolve(true)
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to mark pending passkey mutations as applied", e)
                    promise.reject(
                        "MARK_PENDING_PASSKEY_MUTATIONS_APPLIED_FAILED",
                        "Failed to mark pending passkey mutations as applied: ${e.message}",
                        e
                    )
                }
            }
        }

        /**
         * Mark queued passkey mutations as failed (increments retry attempts and stores error).
         */
        AsyncFunction("markPendingPasskeyMutationsFailed") { ids: List<String>, error: String, promise: Promise ->
            moduleScope.launch {
                try {
                    if (ids.isNotEmpty()) {
                        withContext(Dispatchers.IO) {
                            database.pendingPasskeyMutationDao().markFailed(ids, error)
                        }
                    }
                    promise.resolve(true)
                } catch (e: Exception) {
                    Log.e(TAG, "Failed to mark pending passkey mutations as failed", e)
                    promise.reject(
                        "MARK_PENDING_PASSKEY_MUTATIONS_FAILED",
                        "Failed to mark pending passkey mutations as failed: ${e.message}",
                        e
                    )
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


    }
}
