package expo.modules.credentialprovider.service

import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.os.CancellationSignal
import android.os.OutcomeReceiver
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.credentials.exceptions.ClearCredentialException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.CreateCredentialUnknownException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.GetCredentialUnknownException
import androidx.credentials.provider.BeginCreateCredentialRequest
import androidx.credentials.provider.BeginCreateCredentialResponse
import androidx.credentials.provider.BeginCreatePasswordCredentialRequest
import androidx.credentials.provider.BeginCreatePublicKeyCredentialRequest
import androidx.credentials.provider.AuthenticationAction
import androidx.credentials.provider.BeginGetCredentialRequest
import androidx.credentials.provider.BeginGetCredentialResponse
import androidx.credentials.provider.BeginGetPasswordOption
import androidx.credentials.provider.BeginGetPublicKeyCredentialOption
import androidx.credentials.provider.CreateEntry
import androidx.credentials.provider.CredentialEntry
import androidx.credentials.provider.CredentialProviderService
import androidx.credentials.provider.PasswordCredentialEntry
import androidx.credentials.provider.PublicKeyCredentialEntry
import androidx.credentials.provider.ProviderClearCredentialStateRequest
import expo.modules.credentialprovider.activity.GetCredentialsActivity
import expo.modules.credentialprovider.crypto.VaultDecryptor
import expo.modules.credentialprovider.passkey.PasskeyUtils
import expo.modules.credentialprovider.passkey.StoredPasskey
import expo.modules.credentialprovider.state.VaultStateManager
import expo.modules.credentialprovider.storage.CredentialDatabase
import expo.modules.credentialprovider.storage.CredentialEntity
import expo.modules.credentialprovider.storage.ItemEntity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONArray
import java.time.Instant

/**
 * Android Credential Provider Service for Bittery password manager.
 * Handles autofill requests from other apps.
 */
@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
class BitteryCredentialProviderService : CredentialProviderService() {
    companion object {
        private const val TAG = "BitteryCredProvider"
        const val EXTRA_CREDENTIAL_ID = "credential_id"
        const val EXTRA_ITEM_ID = "item_id"
        const val EXTRA_REQUEST_TYPE = "request_type"
        const val REQUEST_TYPE_GET = "get"
        const val REQUEST_TYPE_CREATE = "create"
        const val REQUEST_TYPE_GET_PASSKEY = "get_passkey"
        const val REQUEST_TYPE_CREATE_PASSKEY = "create_passkey"
        const val REQUEST_TYPE_UNLOCK = "unlock"
        const val EXTRA_ORIGIN = "origin"
        const val EXTRA_USERNAME = "username"
        const val EXTRA_PASSWORD = "password"
        const val EXTRA_PASSKEY_CREDENTIAL_ID = "passkey_credential_id"
    }

    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    private val database: CredentialDatabase by lazy {
        CredentialDatabase.getInstance(applicationContext)
    }

    private val allowlistJson: String by lazy {
        loadAllowlistJson()
    }

    /**
     * Handle password autofill requests.
     * Called when an app requests credentials.
     *
     * Flow:
     * 1. Check if vault is unlocked (MUK available in VaultStateManager)
     * 2. If locked: return AuthenticationAction to trigger unlock flow
     * 3. If unlocked: query credentials and return them
     */
    override fun onBeginGetCredentialRequest(
        request: BeginGetCredentialRequest,
        cancellationSignal: CancellationSignal,
        callback: OutcomeReceiver<BeginGetCredentialResponse, GetCredentialException>
    ) {
        Log.d(TAG, "========================================")
        Log.d(TAG, "onBeginGetCredentialRequest called!")
        Log.d(TAG, "CallingAppInfo: ${request.callingAppInfo}")
        val rawOrigin = try {
            request.callingAppInfo?.getOrigin(allowlistJson)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to get origin", e)
            null
        }
        val callingOrigin = resolveCallingOrigin(rawOrigin, request.callingAppInfo?.packageName)
        Log.d(TAG, "CallingAppInfo.origin(raw): $rawOrigin")
        Log.d(TAG, "CallingAppInfo.origin(resolved): $callingOrigin")
        Log.d(TAG, "CallingAppInfo.packageName: ${request.callingAppInfo?.packageName}")
        Log.d(TAG, "Options count: ${request.beginGetCredentialOptions.size}")
        Log.d(TAG, "VaultStateManager.isUnlocked: ${VaultStateManager.isUnlocked()}")
        Log.d(TAG, "========================================")

        serviceScope.launch {
            try {
                val unlockedUserIds = VaultStateManager.getUnlockedUserIds()
                val isVaultUnlocked = unlockedUserIds.isNotEmpty()
                val credentialEntries = mutableListOf<CredentialEntry>()
                val authenticationActions = mutableListOf<AuthenticationAction>()

                // If vault is locked, add an authentication action
                if (!isVaultUnlocked) {
                    Log.d(TAG, "Vault is locked, adding authentication action")
                    val unlockAction = AuthenticationAction(
                        "Unlock Bittery",
                        createUnlockPendingIntent()
                    )
                    authenticationActions.add(unlockAction)
                }

                for (option in request.beginGetCredentialOptions) {
                    Log.d(TAG, "Processing option: ${option::class.simpleName}")
                    if (option is BeginGetPasswordOption) {
                        val origin = resolveCallingOrigin(rawOrigin, request.callingAppInfo?.packageName)

                        Log.d(TAG, "Password request for origin: $origin")

                        // Query credentials matching the origin/domain
                        val domain = extractDomain(origin)
                        val parentDomain = extractParentDomain(domain)
                        Log.d(TAG, "Extracted domain: $domain, parent: $parentDomain")

                        // Only return credentials if vault is unlocked
                        // Decryption happens in GetCredentialsActivity using MUK
                        if (isVaultUnlocked) {
                            val items = mutableListOf<ItemEntity>()
                            for (userId in unlockedUserIds) {
                                val userItems = if (domain.isNotEmpty() && parentDomain.isNotEmpty()) {
                                    database.itemDao().getLoginItemsByDomainWithFallback(domain, parentDomain, userId)
                                } else if (domain.isNotEmpty()) {
                                    database.itemDao().getLoginItemsByDomain(domain, userId)
                                } else {
                                    emptyList()
                                }
                                items.addAll(userItems)
                            }

                            Log.d(TAG, "Found ${items.size} items in vault-based storage for domain '$domain'")

                            for (item in items) {
                                Log.d(TAG, "Creating entry for item: ${item.username} @ ${item.primaryDomain}")
                                val entry = createPasswordEntryFromItem(item, option)
                                credentialEntries.add(entry)
                            }
                        } else {
                            Log.d(TAG, "Vault locked - not returning credentials, only auth action")
                        }
                    } else if (option is BeginGetPublicKeyCredentialOption) {
                        val requestRpId = PasskeyUtils.parseRpIdFromGetRequestJson(option.requestJson)
                        val origin = resolveCallingOrigin(rawOrigin, request.callingAppInfo?.packageName)
                        val fallbackDomain = extractPasskeyRpIdFromOrigin(origin)
                        val rpId = requestRpId?.takeIf { it.isNotBlank() } ?: fallbackDomain

                        if (rpId.isBlank()) {
                            Log.w(TAG, "Passkey option missing rpId/domain, skipping entry generation")
                            continue
                        }

                        if (!isVaultUnlocked) {
                            Log.d(TAG, "Vault locked - not returning passkey entries, only auth action")
                            continue
                        }

                        val passkeyEntries = loadPasskeyEntriesForRpId(
                            option = option,
                            rpId = rpId,
                            userIds = unlockedUserIds
                        )

                        if (passkeyEntries.isEmpty()) {
                            Log.d(TAG, "No matching passkeys found for rpId=$rpId")
                        } else {
                            Log.d(TAG, "Adding ${passkeyEntries.size} passkey entries for rpId=$rpId")
                            credentialEntries.addAll(passkeyEntries)
                        }
                    }
                }

                Log.d(TAG, "Returning ${credentialEntries.size} credential entries and ${authenticationActions.size} auth actions")
                val responseBuilder = BeginGetCredentialResponse.Builder()
                    .setCredentialEntries(credentialEntries)

                if (authenticationActions.isNotEmpty()) {
                    responseBuilder.setAuthenticationActions(authenticationActions)
                }

                val response = responseBuilder.build()
                callback.onResult(response)
                Log.d(TAG, "Response sent successfully")
            } catch (e: Exception) {
                Log.e(TAG, "Error in onBeginGetCredentialRequest", e)
                callback.onError(GetCredentialUnknownException("Failed to get credentials: ${e.message}"))
            }
        }
    }

    /**
     * Handle credential creation requests.
     * Called when an app wants to save a new credential.
     */
    override fun onBeginCreateCredentialRequest(
        request: BeginCreateCredentialRequest,
        cancellationSignal: CancellationSignal,
        callback: OutcomeReceiver<BeginCreateCredentialResponse, CreateCredentialException>
    ) {
        Log.d(TAG, "onBeginCreateCredentialRequest called")

        try {
            if (request is BeginCreatePasswordCredentialRequest) {
                val createEntry = CreateEntry.Builder(
                    "Bittery",
                    createCreatePendingIntent(request)
                )
                    .setDescription("Save password to Bittery")
                    .build()

                val response = BeginCreateCredentialResponse.Builder()
                    .setCreateEntries(listOf(createEntry))
                    .build()

                callback.onResult(response)
            } else if (request is BeginCreatePublicKeyCredentialRequest) {
                val createEntry = CreateEntry.Builder(
                    "Bittery",
                    createPasskeyCreatePendingIntent(request)
                )
                    .setDescription("Save passkey to Bittery")
                    .setPublicKeyCredentialCount(1)
                    .build()

                val response = BeginCreateCredentialResponse.Builder()
                    .setCreateEntries(listOf(createEntry))
                    .build()

                callback.onResult(response)
            } else {
                // Unknown credential type
                callback.onError(CreateCredentialUnknownException("Unsupported credential type"))
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error in onBeginCreateCredentialRequest", e)
            callback.onError(CreateCredentialUnknownException("Failed to create credential: ${e.message}"))
        }
    }

    /**
     * Handle credential state clearing.
     */
    override fun onClearCredentialStateRequest(
        request: ProviderClearCredentialStateRequest,
        cancellationSignal: CancellationSignal,
        callback: OutcomeReceiver<Void?, ClearCredentialException>
    ) {
        Log.d(TAG, "onClearCredentialStateRequest called")
        // We don't store any session state, so just return success
        callback.onResult(null)
    }

    /**
     * Create a PasswordCredentialEntry for display in the credential picker.
     * Used for legacy CredentialEntity storage.
     */
    private fun createPasswordEntry(
        credential: CredentialEntity,
        option: BeginGetPasswordOption
    ): PasswordCredentialEntry {
        val pendingIntent = createGetPendingIntent(credential.id)

        return PasswordCredentialEntry.Builder(
            applicationContext,
            credential.username,
            pendingIntent,
            option
        )
            .setDisplayName(credential.displayName)
            .setLastUsedTime(Instant.ofEpochMilli(credential.lastUsedAt))
            .build()
    }

    /**
     * Create a PasswordCredentialEntry from unified ItemEntity storage.
     * The item's password is encrypted and will be decrypted in GetCredentialsActivity.
     */
    private fun createPasswordEntryFromItem(
        item: ItemEntity,
        option: BeginGetPasswordOption
    ): PasswordCredentialEntry {
        val pendingIntent = createGetPendingIntentForItem(item.id)

        return PasswordCredentialEntry.Builder(
            applicationContext,
            item.username ?: "",
            pendingIntent,
            option
        )
            .setDisplayName(item.displayTitle)
            .setLastUsedTime(Instant.ofEpochMilli(item.lastUsedAt))
            .build()
    }

    /**
     * Create passkey entries for matching stored passkeys under an item.
     */
    private fun createPasskeyEntryFromItem(
        item: ItemEntity,
        passkey: StoredPasskey,
        option: BeginGetPublicKeyCredentialOption
    ): PublicKeyCredentialEntry {
        val pendingIntent = createGetPasskeyPendingIntent(item.id, passkey.credentialId)
        val displayUser = passkey.userDisplayName.ifBlank {
            passkey.userName.ifBlank { item.username ?: "Passkey" }
        }

        return PublicKeyCredentialEntry.Builder(
            applicationContext,
            displayUser,
            pendingIntent,
            option
        )
            .setDisplayName(item.displayTitle.ifBlank { passkey.rpId })
            .setLastUsedTime(Instant.ofEpochMilli(item.lastUsedAt))
            .build()
    }

    private suspend fun loadPasskeyEntriesForRpId(
        option: BeginGetPublicKeyCredentialOption,
        rpId: String,
        userIds: List<String>
    ): List<PublicKeyCredentialEntry> {
        val normalizedRpId = PasskeyUtils.normalizeHost(rpId)
        if (normalizedRpId.isBlank()) return emptyList()

        val allowedCredentialIds = PasskeyUtils.parseAllowCredentialIdsFromGetRequestJson(option.requestJson)
        val parentDomain = extractParentDomain(normalizedRpId)
        val entries = mutableListOf<PublicKeyCredentialEntry>()
        val seen = mutableSetOf<String>()

        for (userId in userIds) {
            val muk = VaultStateManager.getMasterUnlockKey(userId) ?: continue

            val items = if (parentDomain.isNotBlank() && parentDomain != normalizedRpId) {
                database.itemDao().getLoginItemsByDomainWithFallback(
                    normalizedRpId,
                    parentDomain,
                    userId
                )
            } else {
                database.itemDao().getLoginItemsByDomain(normalizedRpId, userId)
            }

            for (item in items) {
                val matchingPasskeys = loadMatchingPasskeysForItem(
                    item = item,
                    muk = muk,
                    rpId = normalizedRpId,
                    allowedCredentialIds = allowedCredentialIds
                )

                for (passkey in matchingPasskeys) {
                    val dedupeKey = "${item.id}:${passkey.credentialId}"
                    if (!seen.add(dedupeKey)) {
                        continue
                    }

                    entries.add(createPasskeyEntryFromItem(item, passkey, option))
                }
            }
        }

        return entries
    }

    private suspend fun loadMatchingPasskeysForItem(
        item: ItemEntity,
        muk: ByteArray,
        rpId: String,
        allowedCredentialIds: Set<String>
    ): List<StoredPasskey> {
        return try {
            val vaultKey = database.vaultKeyDao().getByVaultId(item.vaultId, item.userId)
                ?: return emptyList()

            val decryptedVaultKey = VaultDecryptor.decryptVaultKeyWithMuk(vaultKey, muk)
            val itemDataJson = VaultDecryptor.decryptItemJson(item, decryptedVaultKey)
            val passkeys = PasskeyUtils.parseStoredPasskeys(itemDataJson)

            passkeys.filter { passkey ->
                val passkeyRpId = PasskeyUtils.normalizeHost(passkey.rpId)
                if (passkeyRpId != rpId) {
                    return@filter false
                }

                if (allowedCredentialIds.isEmpty()) {
                    return@filter true
                }

                allowedCredentialIds.contains(
                    PasskeyUtils.canonicalizeCredentialId(passkey.credentialId)
                )
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to load passkeys for item ${item.id}", e)
            emptyList()
        }
    }

    /**
     * Create PendingIntent for credential retrieval (legacy storage).
     * Opens GetCredentialsActivity for biometric authentication.
     */
    private fun createGetPendingIntent(credentialId: String): PendingIntent {
        val intent = Intent(applicationContext, GetCredentialsActivity::class.java).apply {
            putExtra(EXTRA_CREDENTIAL_ID, credentialId)
            putExtra(EXTRA_REQUEST_TYPE, REQUEST_TYPE_GET)
        }

        return PendingIntent.getActivity(
            applicationContext,
            credentialId.hashCode(),
            intent,
            PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
    }

    /**
     * Create PendingIntent for item credential retrieval (unified storage).
     * Opens GetCredentialsActivity to decrypt using MUK.
     */
    private fun createGetPendingIntentForItem(itemId: String): PendingIntent {
        val intent = Intent(applicationContext, GetCredentialsActivity::class.java).apply {
            putExtra(EXTRA_ITEM_ID, itemId)
            putExtra(EXTRA_REQUEST_TYPE, REQUEST_TYPE_GET)
        }

        return PendingIntent.getActivity(
            applicationContext,
            itemId.hashCode(),
            intent,
            PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
    }

    /**
     * Create PendingIntent for passkey credential retrieval.
     */
    private fun createGetPasskeyPendingIntent(itemId: String, credentialId: String): PendingIntent {
        val intent = Intent(applicationContext, GetCredentialsActivity::class.java).apply {
            putExtra(EXTRA_ITEM_ID, itemId)
            putExtra(EXTRA_PASSKEY_CREDENTIAL_ID, credentialId)
            putExtra(EXTRA_REQUEST_TYPE, REQUEST_TYPE_GET_PASSKEY)
        }

        val requestCode = "${itemId}_$credentialId".hashCode()
        return PendingIntent.getActivity(
            applicationContext,
            requestCode,
            intent,
            PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
    }

    /**
     * Create PendingIntent for vault unlock.
     * Opens GetCredentialsActivity in unlock mode.
     */
    private fun createUnlockPendingIntent(): PendingIntent {
        val intent = Intent(applicationContext, GetCredentialsActivity::class.java).apply {
            putExtra(EXTRA_REQUEST_TYPE, REQUEST_TYPE_UNLOCK)
        }

        return PendingIntent.getActivity(
            applicationContext,
            REQUEST_TYPE_UNLOCK.hashCode(),
            intent,
            PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
    }

    /**
     * Create PendingIntent for credential creation.
     * Opens activity to save a new credential.
     */
    private fun createCreatePendingIntent(request: BeginCreatePasswordCredentialRequest): PendingIntent {
        val intent = Intent(applicationContext, GetCredentialsActivity::class.java).apply {
            putExtra(EXTRA_REQUEST_TYPE, REQUEST_TYPE_CREATE)
            // The actual username/password will come from ProviderCreateCredentialRequest
        }

        return PendingIntent.getActivity(
            applicationContext,
            REQUEST_TYPE_CREATE.hashCode(),
            intent,
            PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
    }

    /**
     * Create PendingIntent for passkey registration.
     */
    private fun createPasskeyCreatePendingIntent(
        request: BeginCreatePublicKeyCredentialRequest
    ): PendingIntent {
        val intent = Intent(applicationContext, GetCredentialsActivity::class.java).apply {
            putExtra(EXTRA_REQUEST_TYPE, REQUEST_TYPE_CREATE_PASSKEY)
        }

        val requestCode = "${REQUEST_TYPE_CREATE_PASSKEY}:${request.requestJson.hashCode()}".hashCode()
        return PendingIntent.getActivity(
            applicationContext,
            requestCode,
            intent,
            PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
    }

    /**
     * Extract domain from origin URL or package name.
     */
    private fun extractDomain(origin: String): String {
        return try {
            if (origin.startsWith("http")) {
                // It's a URL, extract the host
                val url = java.net.URL(origin)
                url.host.removePrefix("www.")
            } else if (origin.startsWith("android:apk-key-hash:")) {
                // It's an Android app signature, extract package name from calling app
                ""
            } else {
                // Assume it's already a domain or package name
                origin.removePrefix("www.")
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to extract domain from: $origin", e)
            ""
        }
    }

    private fun extractPasskeyRpIdFromOrigin(origin: String): String {
        return try {
            if (!origin.startsWith("http")) {
                ""
            } else {
                java.net.URI(origin).host?.lowercase()?.trimEnd('.') ?: ""
            }
        } catch (_: Exception) {
            ""
        }
    }

    private fun resolveCallingOrigin(originJsonOrString: String?, packageName: String?): String {
        val origins = extractOriginList(originJsonOrString)
        val origin = origins
            .firstOrNull { it.isNotBlank() }
            ?.let { normalizeOrigin(it) }
        return origin ?: packageName.orEmpty()
    }

    private fun normalizeOrigin(origin: String): String {
        val trimmed = origin.trim()
        if (trimmed.isBlank()) return trimmed
        if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
            return trimmed
        }

        return try {
            val uri = java.net.URI(trimmed)
            val scheme = uri.scheme?.lowercase() ?: return trimmed.removeSuffix("/")
            val host = uri.host?.lowercase() ?: return trimmed.removeSuffix("/")
            val authorityHost = if (host.contains(":")) "[$host]" else host
            val port = uri.port
            val includePort = port != -1 &&
                !((scheme == "https" && port == 443) || (scheme == "http" && port == 80))

            buildString {
                append(scheme)
                append("://")
                append(authorityHost)
                if (includePort) {
                    append(':')
                    append(port)
                }
            }
        } catch (_: Exception) {
            trimmed.removeSuffix("/")
        }
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
     * Extract parent domain from a subdomain.
     * e.g., "login.example.com" -> "example.com"
     */
    private fun extractParentDomain(domain: String): String {
        val parts = domain.split(".")
        return if (parts.size > 2) {
            // Remove first subdomain part
            parts.drop(1).joinToString(".")
        } else {
            // Already a base domain
            domain
        }
    }
}
