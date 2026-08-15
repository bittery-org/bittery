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
import expo.modules.credentialprovider.domain.DomainMatch
import expo.modules.credentialprovider.passkey.PasskeyUtils
import expo.modules.credentialprovider.passkey.StoredPasskey
import expo.modules.credentialprovider.state.VaultStateManager
import expo.modules.credentialprovider.storage.CredentialDatabase
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
    private data class PasskeyCandidate(
        val item: ItemEntity,
        val passkey: StoredPasskey
    )

    companion object {
        private const val TAG = "BitteryCredProvider"
        const val EXTRA_ITEM_ID = "item_id"
        const val EXTRA_REQUEST_TYPE = "request_type"
        const val REQUEST_TYPE_GET = "get"
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

    override fun onCreate() {
        super.onCreate()
        VaultStateManager.initialize(applicationContext)
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
            Log.w(TAG, "Failed to get origin (caller may not be in allowlist): ${e::class.simpleName}: ${e.message}")
            null
        }
        val callingOrigin = resolveCallingOrigin(rawOrigin, request.callingAppInfo?.packageName)
        Log.d(TAG, "CallingAppInfo.origin(raw): $rawOrigin")
        Log.d(TAG, "CallingAppInfo.origin(resolved): $callingOrigin")
        Log.d(TAG, "CallingAppInfo.packageName: ${request.callingAppInfo?.packageName}")
        Log.d(TAG, "Options count: ${request.beginGetCredentialOptions.size}")
        val optionTypes = request.beginGetCredentialOptions.map { it::class.simpleName }
        Log.d(TAG, "Option types: $optionTypes")
        // Full debug dump to diagnose MUK state at the moment the service is invoked
        VaultStateManager.dumpDebugState("onBeginGetCredentialRequest")
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

                        // Query credentials matching the origin/domain. Items are
                        // indexed under DomainMatch.lookupKeys, so querying the same
                        // keys is DomainMatch.matches expressed in SQL.
                        val domain = extractDomain(origin)
                        val domainKeys = DomainMatch.lookupKeys(domain)
                        val isValidWebDomain = isLikelyWebDomain(domain)
                        Log.d(TAG, "Extracted domain: $domain, keys: $domainKeys, isValidWebDomain: $isValidWebDomain")

                        // Only return credentials if vault is unlocked
                        // Decryption happens in GetCredentialsActivity using MUK
                        if (isVaultUnlocked) {
                            val items = mutableListOf<ItemEntity>()
                            for (userId in unlockedUserIds) {
                                val userItems = if (isValidWebDomain && domainKeys.size > 1) {
                                    database.itemDao()
                                        .getLoginItemsByDomainAndParent(domainKeys[0], domainKeys[1], userId)
                                } else if (isValidWebDomain && domainKeys.isNotEmpty()) {
                                    database.itemDao().getLoginItemsByDomain(domainKeys[0], userId)
                                } else {
                                    Log.w(
                                        TAG,
                                        "Skipping password credential suggestions for invalid or untrusted origin: rawOrigin=$rawOrigin resolvedOrigin=$origin package=${request.callingAppInfo?.packageName}"
                                    )
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
				callback.onError(
					CreateCredentialUnknownException(
						"Password creation is not available through the credential provider"
					)
				)
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
     * Create a PasswordCredentialEntry from unified ItemEntity storage.
     * The item's password is encrypted and will be decrypted in GetCredentialsActivity.
     */
    private fun createPasswordEntryFromItem(
        item: ItemEntity,
        option: BeginGetPasswordOption
    ): PasswordCredentialEntry {
        val pendingIntent = createGetPendingIntentForItem(item.id)
        val username = item.username?.takeIf { it.isNotBlank() }
            ?: item.displayTitle.takeIf { it.isNotBlank() }
            ?: item.primaryDomain
            ?: "Login"
        val lastUsed = if (item.lastUsedAt > 0) {
            Instant.ofEpochMilli(item.lastUsedAt)
        } else {
            Instant.ofEpochMilli(item.updatedAt)
        }

        return PasswordCredentialEntry.Builder(
            applicationContext,
            username,
            pendingIntent,
            option
        )
            .setDisplayName(item.displayTitle.ifBlank { item.primaryDomain ?: "Login" })
            .setLastUsedTime(lastUsed)
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
        val username = resolvePasskeyEntryUsername(passkey, item)
        val displayUser = resolvePasskeyDisplayName(passkey, item)

        return PublicKeyCredentialEntry.Builder(
            applicationContext,
            username,
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
        val domainsToQuery = DomainMatch.lookupKeys(normalizedRpId)
        val candidateByGroup = LinkedHashMap<String, PasskeyCandidate>()
        val seen = mutableSetOf<String>()

        for (userId in userIds) {
            val muk = VaultStateManager.getMasterUnlockKey(userId) ?: continue

            val itemById = LinkedHashMap<String, ItemEntity>()
            for (domain in domainsToQuery) {
                val domainItems = database.itemDao().getLoginItemsByDomain(domain, userId)
                for (item in domainItems) {
                    itemById[item.id] = item
                }
            }
            for (item in itemById.values) {
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

                    val groupKey = passkeyGroupKey(item, passkey)
                    val existing = candidateByGroup[groupKey]
                    if (existing == null || shouldPreferPasskeyCandidate(item, passkey, existing)) {
                        candidateByGroup[groupKey] = PasskeyCandidate(item, passkey)
                    }
                }
            }
        }

        val entries = mutableListOf<PublicKeyCredentialEntry>()
        for (candidate in candidateByGroup.values) {
            entries.add(
                createPasskeyEntryFromItem(
                    item = candidate.item,
                    passkey = candidate.passkey,
                    option = option
                )
            )
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
                if (passkey.privateKey.isBlank()) {
                    return@filter false
                }
                val passkeyRpId = PasskeyUtils.normalizeHost(passkey.rpId)
                if (!domainsEquivalent(passkeyRpId, rpId)) {
                    return@filter false
                }

                if (allowedCredentialIds.isEmpty()) {
                    return@filter true
                }

                val canonicalPasskeyId = PasskeyUtils.canonicalizeCredentialId(passkey.credentialId)
                !canonicalPasskeyId.isNullOrBlank() && allowedCredentialIds.contains(canonicalPasskeyId)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to load passkeys for item ${item.id}", e)
            emptyList()
        }
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
     * Extract domain from origin URL or package name. An Android signature
     * origin identifies no host at all, so it yields nothing rather than a
     * string that could accidentally match an indexed domain.
     */
    private fun extractDomain(origin: String): String {
        if (origin.startsWith("android:apk-key-hash:")) return ""
        return DomainMatch.normalizeHost(origin)
    }

    private fun extractPasskeyRpIdFromOrigin(origin: String): String {
        if (!origin.startsWith("http")) return ""
        return DomainMatch.normalizeHost(origin)
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
     * Check if a domain looks like a valid web domain rather than an Android package name
     * or other non-web identifier.
     * e.g., "github.com" -> true, "com.android.chrome" -> false, "" -> false
     */
    private fun isLikelyWebDomain(domain: String): Boolean {
        if (domain.isBlank()) return false
        // Web domains have a TLD as the last segment (e.g., .com, .org, .io)
        // Package names have a TLD as the first segment (e.g., com.android.chrome)
        // Simple heuristic: if it contains a dot and the last segment looks like a TLD
        val parts = domain.split(".")
        if (parts.size < 2) return false
        val lastPart = parts.last()
        // Common TLDs are short (2-6 chars). Package name last segments are longer app names.
        // Also check that first segment isn't a well-known TLD prefix (com, org, net, etc.)
        val tldPrefixes = setOf("com", "org", "net", "io", "edu", "gov", "mil", "int")
        if (tldPrefixes.contains(parts.first().lowercase()) && parts.size > 2) {
            // Looks like a reversed-domain package name (com.android.chrome)
            return false
        }
        return lastPart.length in 2..6
    }

    private fun resolvePasskeyEntryUsername(passkey: StoredPasskey, item: ItemEntity): String {
        return passkey.userName
            .takeIf { it.isNotBlank() }
            ?: item.username?.takeIf { it.isNotBlank() }
            ?: passkey.userDisplayName.takeIf { it.isNotBlank() }
            ?: "Passkey"
    }

    private fun resolvePasskeyDisplayName(passkey: StoredPasskey, item: ItemEntity): String {
        return passkey.userDisplayName
            .takeIf { it.isNotBlank() }
            ?: passkey.userName.takeIf { it.isNotBlank() }
            ?: item.username?.takeIf { it.isNotBlank() }
            ?: "Passkey"
    }

    private fun passkeyGroupKey(item: ItemEntity, passkey: StoredPasskey): String {
        val normalizedUser = resolvePasskeyEntryUsername(passkey, item).trim().lowercase()
        return "${item.userId}:$normalizedUser"
    }

    private fun shouldPreferPasskeyCandidate(
        newItem: ItemEntity,
        newPasskey: StoredPasskey,
        existing: PasskeyCandidate
    ): Boolean {
        val newPasskeyTime = passkeyRecencyMillis(newPasskey)
        val existingPasskeyTime = passkeyRecencyMillis(existing.passkey)
        if (newPasskeyTime != existingPasskeyTime) {
            return newPasskeyTime > existingPasskeyTime
        }

        return newItem.lastUsedAt > existing.item.lastUsedAt
    }

    private fun passkeyRecencyMillis(passkey: StoredPasskey): Long {
        val lastUsed = parseIsoInstantMillis(passkey.lastUsedAt)
        if (lastUsed > 0L) {
            return lastUsed
        }

        return parseIsoInstantMillis(passkey.createdAt)
    }

    private fun parseIsoInstantMillis(value: String?): Long {
        if (value.isNullOrBlank()) return 0L
        return try {
            Instant.parse(value).toEpochMilli()
        } catch (_: Exception) {
            0L
        }
    }

    /** Passkey rpId identity, not the wider password-matching rule. */
    private fun domainsEquivalent(left: String, right: String): Boolean =
        DomainMatch.sameRelyingParty(left, right)
}
