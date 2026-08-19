package com.bittery.mobile.credentialprovider.vault

import androidx.fragment.app.FragmentActivity
import com.bittery.mobile.credentialprovider.domain.DomainMatch
import com.bittery.mobile.credentialprovider.passkey.PasskeyUtils
import com.bittery.mobile.credentialprovider.passkey.StoredPasskey
import java.time.Instant
import java.util.UUID
import javax.crypto.Cipher
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/** Wall-clock milliseconds, injected so stored timestamps are testable. */
internal fun interface WallClock {
    fun nowMs(): Long
}

/**
 * The vault, assembled from four things it does not implement: the live keys, the
 * escrow, the replica and the cryptography.
 *
 * All four are ports, so this class holds the *decisions* — which account owns a
 * row, whether a lookup may answer, what a locked account means for the caller —
 * and none of the machinery. That is what makes the decisions testable.
 *
 * Every read answers from the live keys. Only [unlockWithBiometric] touches the
 * escrow, and it shows a prompt first.
 */
internal class AndroidNativeCredentialVault(
    private val liveUnlocks: LiveUnlockStore,
    private val escrow: EscrowVault,
    private val replica: ReplicaStore,
    private val crypto: VaultCrypto,
    private val clock: WallClock,
    private val gate: BiometricGate = AndroidBiometricGate(),
    private val logger: VaultLogger = VaultLogger.None,
    /** Room work goes here. A test passes an immediate dispatcher instead. */
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : NativeCredentialVault {

    // ------------------------------------------------------------------
    // Live unlock state
    // ------------------------------------------------------------------

    override fun isUnlocked(accountId: String): Boolean = liveUnlocks.isUnlocked(accountId)

    override fun unlockedAccountIds(): List<String> = liveUnlocks.getUnlockedAccountIds()

    override fun borrowLiveMasterUnlockKey(accountId: String): ByteArray? =
        liveUnlocks.borrowLiveMasterUnlockKey(accountId)

    override fun acceptUnlockedKey(
        accountId: String,
        serverUserId: String,
        muk: ByteArray,
        autoLockTimeoutMs: Long?,
    ) = liveUnlocks.acceptUnlockedKey(accountId, serverUserId, muk, autoLockTimeoutMs)

    override fun setAutoLockTimeout(accountId: String, timeoutMs: Long) =
        liveUnlocks.setAutoLockTimeout(accountId, timeoutMs)

    override fun lock(accountId: String?) = liveUnlocks.lock(accountId)

    // ------------------------------------------------------------------
    // Biometric unlock
    // ------------------------------------------------------------------

    override fun biometricUnlockState(): BiometricUnlockState = BiometricUnlockState(
        hasEscrow = escrow.hasValidEscrow(),
        canUnlock = escrow.canUseBiometricUnlock(),
        masterPasswordRequired = escrow.isMasterPasswordReentryRequired(),
        remainingMs = escrow.remainingMs(),
        lastMasterPasswordEntryMs = escrow.lastMasterPasswordEntryMs(),
    )

    override fun hasBiometricUnlockFor(email: String): Boolean = escrow.hasValidEscrowForEmail(email)

    override fun enrolBiometricUnlock(
        accountId: String,
        serverUserId: String,
        email: String,
        timeoutMs: Long,
    ): EnrolResult {
        val muk = liveUnlocks.borrowLiveMasterUnlockKey(accountId) ?: return EnrolResult.VaultLocked
        return try {
            escrow.wrap(muk, email, accountId, serverUserId, timeoutMs)
            EnrolResult.Enrolled
        } catch (e: Exception) {
            EnrolResult.Failed(e.message ?: e::class.java.simpleName, e)
        } finally {
            muk.fill(0)
        }
    }

    override suspend fun unlockWithBiometric(
        activity: FragmentActivity,
        subtitle: String,
    ): UnlockResult = unlockWithAuthenticatedCipher { cipher ->
        gate.authenticate(activity, subtitle, cipher)
    }

    /**
     * The unlock itself, with the prompt held at arm's length.
     *
     * Split out so a test can drive every outcome — refusal, a record that needs
     * re-enrolment, an unwrap that fails — without an activity to host a prompt.
     */
    suspend fun unlockWithAuthenticatedCipher(
        authenticate: suspend (Cipher) -> CipherAuthentication,
    ): UnlockResult {
        if (!escrow.hasValidEscrow()) return UnlockResult.NoEscrow

        val cipher = try {
            escrow.decryptCipher()
        } catch (e: Exception) {
            return UnlockResult.PromptFailed("Failed to show authentication prompt: ${e.message}")
        }

        return when (val authentication = authenticate(cipher)) {
            is CipherAuthentication.Rejected -> UnlockResult.Rejected(authentication.message)
            is CipherAuthentication.NoHost -> UnlockResult.PromptUnavailable(authentication.message)
            is CipherAuthentication.Failed -> UnlockResult.PromptFailed(authentication.message)

            is CipherAuthentication.Authenticated -> {
                // Read after the prompt, not before: the record could only have
                // been rewritten by an unlock, and this is the unlock.
                val accountId = escrow.accountId()
                val serverUserId = escrow.serverUserId()
                if (accountId.isNullOrBlank() || serverUserId.isNullOrBlank()) {
                    return UnlockResult.NeedsReenrolment
                }

                var muk: ByteArray? = null
                try {
                    muk = escrow.unwrap(authentication.cipher)
                    liveUnlocks.acceptUnlockedKey(accountId, serverUserId, muk)
                    UnlockResult.Unlocked(accountId, serverUserId)
                } catch (e: Exception) {
                    UnlockResult.Failed(e.message ?: e::class.java.simpleName, e)
                } finally {
                    muk?.fill(0)
                }
            }
        }
    }

    override fun forgetBiometricUnlock() = escrow.clear()

    override fun forgetBiometricUnlockFor(accountId: String): Boolean {
        val owner = escrow.accountId()
        if (owner != null && owner != accountId) return false
        escrow.clear()
        return true
    }

    override fun recordMasterPasswordEntry() = escrow.recordMasterPasswordEntry()

    // ------------------------------------------------------------------
    // The local replica
    // ------------------------------------------------------------------

    override suspend fun replaceReplica(
        snapshot: CredentialReplicaSnapshot,
    ): ReplicaUpdateResult = withContext(ioDispatcher) {
        val serverUserId = snapshot.serverUserId

        // The policy commits before a single row moves. That ordering is the whole
        // atomicity claim: the only window it leaves is one where old rows meet the
        // *new* policy, and the new policy is the stricter answer to every question
        // it changes. Writing first would leave the opposite window, where a row the
        // new policy hides is still queryable under the old one.
        replica.putTravelModePolicy(serverUserId, snapshot.travelMode)

        // Fail closed, the way `TravelModeEnforcer.verifyOrClear` does: an account
        // whose policy nobody verified is left serving nothing, and this payload is
        // not written at all. The next sync brings a verified one and recovers.
        val policy = snapshot.travelMode
            ?: return@withContext ReplicaUpdateResult.Rejected(
                "No verified travel mode policy for this account",
            )

        // A hidden vault's keys and items are erased, not merely filtered out of a
        // list — that is what `CONTEXT.md` means by "hidden vault". The query
        // filtering behind [ReplicaStore] is the second lock, not a reason to keep
        // the material.
        replica.deleteVaultContents(serverUserId, policy.suppressedVaultIds)

        // A snapshot replaces every row this account serves, so it may only come
        // from a caller that can read them. No live key means no reader: locking
        // empties the app's repository, and the pass that follows would replace a
        // whole vault with nothing. Refuse the rows and keep the last generation.
        // The policy above still commits — it is the stricter answer, and travel
        // mode must not wait for an unlock.
        if (!liveUnlocks.isUnlocked(snapshot.accountId)) {
            logger.debug("Replica snapshot refused: this account holds no live key")
            return@withContext ReplicaUpdateResult.Rejected(
                "This account holds no live key, so its rows cannot be replaced",
            )
        }

        val visible = snapshot.withoutVaultsHiddenBy(policy)

        replica.upsertAccountProfile(
            serverUserId = serverUserId,
            email = visible.email,
            secretKey = visible.secretKey,
            kdf = visible.kdf,
        )

        if (visible.vaultKeys.isNotEmpty()) {
            replica.putVaultKeys(visible.vaultKeys)
        }
        if (visible.items.isNotEmpty()) {
            replica.putItems(visible.items)
        }

        val domainCount = indexDomains(visible)

        val incomingVaultIds = visible.vaultKeys.map { it.vaultId }.toSet()
        var deletedVaultKeys = 0
        for (vaultId in replica.vaultIdsFor(serverUserId) - incomingVaultIds) {
            replica.deleteVaultKey(vaultId, serverUserId)
            deletedVaultKeys++
        }

        val incomingItemIds = visible.items.map { it.id }.toSet()
        var deletedItems = 0
        for (itemId in replica.itemIdsFor(serverUserId) - incomingItemIds) {
            replica.deleteItem(itemId)
            deletedItems++
        }

        logger.debug(
            "Replica replaced: ${visible.vaultKeys.size} vault keys, ${visible.items.size} " +
                "items, $domainCount domains, $deletedVaultKeys vault keys and $deletedItems " +
                "items removed, ${policy.suppressedVaultIds.size} vaults hidden",
        )

        ReplicaUpdateResult.Applied(
            vaultKeys = visible.vaultKeys.size,
            items = visible.items.size,
            domains = domainCount,
            deletedVaultKeys = deletedVaultKeys,
            deletedItems = deletedItems,
        )
    }

    /**
     * Rebuild the domain index for the synced items.
     *
     * Both the host and its registrable domain are indexed, and a lookup queries
     * both, so the SQL match is exactly `DomainMatch.matches`.
     *
     * An item whose URLs did not survive the trip is opened with the live key and
     * read for its own URLs — a repair, not a lookup, and only while unlocked.
     */
    private suspend fun indexDomains(snapshot: CredentialReplicaSnapshot): Int {
        val itemById = snapshot.items.associateBy { it.id }
        val muk = liveUnlocks.borrowLiveMasterUnlockKey(snapshot.accountId)
        var indexed = 0

        try {
            for ((itemId, urls) in snapshot.itemUrls) {
                try {
                    val domainsByValue = LinkedHashMap<String, ReplicaItemDomain>()
                    for (url in urls) {
                        for (domain in DomainMatch.lookupKeys(url)) {
                            if (!domainsByValue.containsKey(domain)) {
                                domainsByValue[domain] = ReplicaItemDomain(
                                    itemId = itemId,
                                    domain = domain,
                                    isPrimary = domainsByValue.isEmpty(),
                                    fullUrl = url,
                                )
                            }
                        }
                    }

                    if (domainsByValue.isEmpty()) {
                        val item = itemById[itemId]
                        if (muk != null && item != null) {
                            for (domain in recoverDomains(item, muk)) {
                                if (!domainsByValue.containsKey(domain)) {
                                    domainsByValue[domain] = ReplicaItemDomain(
                                        itemId = itemId,
                                        domain = domain,
                                        isPrimary = domainsByValue.isEmpty(),
                                        fullUrl = "https://$domain",
                                    )
                                }
                            }
                        }
                    }

                    val domains = domainsByValue.values.toList()
                    if (domains.isEmpty()) {
                        logger.debug("Item $itemId still has no domains after repair")
                        continue
                    }

                    replica.replaceItemDomains(itemId, domains)
                    indexed += domains.size
                } catch (e: Exception) {
                    logger.warn("Failed to index domains for item $itemId", e)
                }
            }
        } finally {
            muk?.fill(0)
        }

        return indexed
    }

    private suspend fun recoverDomains(item: ReplicaItem, muk: ByteArray): List<String> = try {
        val vaultKey = replica.vaultKey(item.vaultId, item.serverUserId)
        if (vaultKey == null) {
            emptyList()
        } else {
            val itemJson = crypto.decryptItemJson(item, crypto.decryptVaultKey(vaultKey, muk))
            candidateDomains(itemJson).toList()
        }
    } catch (e: Exception) {
        logger.warn("Failed to recover domains from the encrypted item ${item.id}", e)
        emptyList()
    }

    /** Every domain an item names: its URLs and any passkey's relying party. */
    private fun candidateDomains(itemJson: JSONObject): Set<String> {
        val domains = LinkedHashSet<String>()
        domains.addAll(DomainMatch.lookupKeys(itemJson.optString("url")))

        val urlsJson = itemJson.optJSONArray("urls")
        if (urlsJson != null) {
            for (index in 0 until urlsJson.length()) {
                domains.addAll(DomainMatch.lookupKeys(urlsJson.optString(index, "")))
            }
        }

        val passkeysJson = itemJson.optJSONArray("passkeys")
        if (passkeysJson != null) {
            for (index in 0 until passkeysJson.length()) {
                val passkey = passkeysJson.optJSONObject(index) ?: continue
                domains.addAll(DomainMatch.lookupKeys(passkey.optString("rpId", "")))
            }
        }

        return domains
    }

    override suspend fun queuedVaultWrites(serverUserId: String?): List<PendingPasskeyMutation> =
        withContext(ioDispatcher) {
            replica.pendingMutations(serverUserId?.takeIf { it.isNotBlank() })
        }

    override suspend fun forgetQueuedVaultWrites(ids: List<String>) {
        if (ids.isEmpty()) return
        withContext(ioDispatcher) { replica.dropPendingMutations(ids) }
    }

    override suspend fun recordQueuedVaultWriteFailure(ids: List<String>, error: String) {
        if (ids.isEmpty()) return
        withContext(ioDispatcher) { replica.recordPendingMutationFailure(ids, error) }
    }

    // ------------------------------------------------------------------
    // What can be offered here
    // ------------------------------------------------------------------

    override suspend fun credentialsForOrigin(
        origin: String,
        limit: Int,
    ): List<NativeCredential> = withContext(ioDispatcher) {
        val credentials = mutableListOf<NativeCredential>()
        if (limit <= 0) return@withContext credentials

        val keys = DomainMatch.lookupKeys(origin)
        if (keys.isEmpty()) return@withContext credentials

        for (account in unlockedAccounts()) {
            val muk = liveUnlocks.borrowLiveMasterUnlockKey(account.accountId) ?: continue
            try {
                val items = loginItemsFor(keys, account.serverUserId)
                if (items.isEmpty()) {
                    logEmptyLookup(origin)
                } else {
                    logger.debug("Found ${items.size} items for the origin '$origin'")
                }
                for (item in items) {
                    val credential = credentialFrom(item, account, muk) ?: continue
                    credentials.add(credential)
                    if (credentials.size >= limit) return@withContext credentials
                }
            } finally {
                muk.fill(0)
            }
        }

        credentials
    }

    private suspend fun credentialFrom(
        item: ReplicaItem,
        account: UnlockedAccount,
        muk: ByteArray,
    ): NativeCredential? = try {
        val vaultKey = replica.vaultKey(item.vaultId, account.serverUserId)
        if (vaultKey == null) {
            null
        } else {
            val login = crypto.decryptLogin(item, crypto.decryptVaultKey(vaultKey, muk))
            val username = login.username ?: item.username
            val password = login.password
            if (username == null || password == null) {
                null
            } else {
                NativeCredential(
                    itemId = item.id,
                    accountId = account.accountId,
                    label = item.displayTitle.ifBlank { username },
                    username = username,
                    password = password,
                )
            }
        }
    } catch (e: Exception) {
        logger.warn("Failed to decrypt item ${item.id}", e)
        null
    }

    override suspend fun passwordSuggestionsForOrigin(
        origin: String,
    ): List<PasswordSuggestion> = withContext(ioDispatcher) {
        val domain = webHostOf(origin)
        val keys = DomainMatch.lookupKeys(domain)
        if (keys.isEmpty() || !isLikelyWebDomain(domain)) {
            logger.warn("Skipping password suggestions for an origin that names no web host")
            return@withContext emptyList()
        }

        val suggestions = mutableListOf<PasswordSuggestion>()
        for (account in unlockedAccounts()) {
            for (item in loginItemsFor(keys, account.serverUserId)) {
                suggestions.add(
                    PasswordSuggestion(
                        itemId = item.id,
                        username = item.username?.takeIf { it.isNotBlank() }
                            ?: item.displayTitle.takeIf { it.isNotBlank() }
                            ?: item.primaryDomain
                            ?: "Login",
                        displayName = item.displayTitle.ifBlank { item.primaryDomain ?: "Login" },
                        lastUsedAtMs = if (item.lastUsedAtMs > 0) item.lastUsedAtMs else item.updatedAtMs,
                    ),
                )
            }
        }
        suggestions
    }

    override suspend fun passkeySuggestionsFor(
        rpId: String,
        allowedCredentialIds: Set<String>,
    ): List<PasskeySuggestion> = withContext(ioDispatcher) {
        val normalizedRpId = PasskeyUtils.normalizeHost(rpId)
        if (normalizedRpId.isBlank()) return@withContext emptyList()

        val domains = DomainMatch.lookupKeys(normalizedRpId)
        val bestByUser = LinkedHashMap<String, PasskeyCandidate>()
        val seen = mutableSetOf<String>()

        for (account in unlockedAccounts()) {
            val muk = liveUnlocks.borrowLiveMasterUnlockKey(account.accountId) ?: continue
            try {
                val itemById = LinkedHashMap<String, ReplicaItem>()
                for (domain in domains) {
                    for (item in replica.loginItemsByDomain(domain, account.serverUserId)) {
                        itemById[item.id] = item
                    }
                }

                for (item in itemById.values) {
                    for (passkey in matchingPasskeys(item, muk, normalizedRpId, allowedCredentialIds)) {
                        if (!seen.add("${item.id}:${passkey.credentialId}")) continue

                        val groupKey = "${item.serverUserId}:${entryUsername(passkey, item).trim().lowercase()}"
                        val existing = bestByUser[groupKey]
                        if (existing == null || outranks(item, passkey, existing)) {
                            bestByUser[groupKey] = PasskeyCandidate(item, passkey)
                        }
                    }
                }
            } finally {
                muk.fill(0)
            }
        }

        bestByUser.values.map { candidate ->
            PasskeySuggestion(
                itemId = candidate.item.id,
                credentialId = candidate.passkey.credentialId,
                username = entryUsername(candidate.passkey, candidate.item),
                displayName = candidate.item.displayTitle.ifBlank { candidate.passkey.rpId },
                lastUsedAtMs = candidate.item.lastUsedAtMs,
            )
        }
    }

    private suspend fun matchingPasskeys(
        item: ReplicaItem,
        muk: ByteArray,
        rpId: String,
        allowedCredentialIds: Set<String>,
    ): List<StoredPasskey> = try {
        val vaultKey = replica.vaultKey(item.vaultId, item.serverUserId)
        if (vaultKey == null) {
            emptyList()
        } else {
            val itemJson = crypto.decryptItemJson(item, crypto.decryptVaultKey(vaultKey, muk))
            PasskeyUtils.parseStoredPasskeys(itemJson).filter { passkey ->
                when {
                    passkey.privateKey.isBlank() -> false
                    !DomainMatch.sameRelyingParty(
                        PasskeyUtils.normalizeHost(passkey.rpId),
                        rpId,
                    ) -> false

                    allowedCredentialIds.isEmpty() -> true
                    else -> PasskeyUtils.canonicalizeCredentialId(passkey.credentialId)
                        ?.takeIf { it.isNotBlank() }
                        ?.let { allowedCredentialIds.contains(it) } == true
                }
            }
        }
    } catch (e: Exception) {
        logger.warn("Failed to load passkeys for item ${item.id}", e)
        emptyList()
    }

    override suspend fun revealPassword(itemId: String): PasswordReveal = withContext(ioDispatcher) {
        val item = replica.item(itemId) ?: return@withContext PasswordReveal.ItemNotFound

        val muk = borrowFor(item.serverUserId)
            ?: return@withContext PasswordReveal.Locked(
                canUnlockWithBiometric = escrow.canUseBiometricUnlock() &&
                    !escrow.accountId().isNullOrBlank() &&
                    escrow.serverUserId() == item.serverUserId,
            )

        try {
            val vaultKey = replica.vaultKey(item.vaultId, item.serverUserId)
                ?: return@withContext PasswordReveal.Failed("Vault key not found")
            val login = crypto.decryptLogin(item, crypto.decryptVaultKey(vaultKey, muk))
            val password = login.password
                ?: return@withContext PasswordReveal.Failed("No password found in item")

            replica.touchLastUsed(item.id, clock.nowMs())
            PasswordReveal.Revealed(
                username = login.username ?: item.username ?: "",
                password = password,
            )
        } catch (e: Exception) {
            logger.warn("Failed to reveal the password of item ${item.id}", e)
            PasswordReveal.Failed(e.message ?: "Failed to retrieve credential")
        } finally {
            muk.fill(0)
        }
    }

    // ------------------------------------------------------------------
    // Passkeys
    // ------------------------------------------------------------------

    override suspend fun assertPasskey(
        request: PasskeyAssertionRequest,
    ): PasskeyAssertionResult = withContext(ioDispatcher) {
        val item = replica.item(request.itemId)
            ?: return@withContext PasskeyAssertionResult.ItemNotFound
        val muk = borrowFor(item.serverUserId) ?: return@withContext PasskeyAssertionResult.Locked

        try {
            val credentialId = PasskeyUtils.canonicalizeCredentialId(request.credentialId)
                ?: return@withContext PasskeyAssertionResult.Failed("Invalid selected credential ID")
            val vaultKey = replica.vaultKey(item.vaultId, item.serverUserId)
                ?: return@withContext PasskeyAssertionResult.Failed("Vault key not found")

            val decryptedVaultKey = crypto.decryptVaultKey(vaultKey, muk)
            val itemJson = crypto.decryptItemJson(item, decryptedVaultKey)
            val passkey = PasskeyUtils.parseStoredPasskeys(itemJson).firstOrNull {
                PasskeyUtils.canonicalizeCredentialId(it.credentialId) == credentialId &&
                    DomainMatch.sameRelyingParty(it.rpId, request.rpId)
            } ?: return@withContext PasskeyAssertionResult.Failed("Passkey not found in selected item")

            val nextSignCount = nextSignCount(passkey.signCount)
            val signature = crypto.signPasskeyAssertion(
                privateKeyBase64 = passkey.privateKey,
                rpId = request.rpId,
                clientDataHashBase64 = request.clientDataHashBase64,
                signCount = nextSignCount,
            )

            val recorded = recordPasskeyUse(
                itemJson = itemJson,
                credentialId = credentialId,
                rpId = request.rpId,
                nextSignCount = nextSignCount,
                usedAtIso = Instant.ofEpochMilli(clock.nowMs()).toString(),
            )
            if (!recorded) {
                logger.warn("Passkey usage metadata not updated for item ${item.id}")
            }

            val baseVersion = item.version
            val encryptionVersion = baseVersion + 1L
            val encrypted = crypto.encryptItemJson(
                json = itemJson,
                vaultKey = decryptedVaultKey,
                vaultId = item.vaultId,
                itemId = item.id,
                version = encryptionVersion,
                serverUserId = item.serverUserId,
            )
            val now = clock.nowMs()
            val updated = item.copy(
                encryptedData = encrypted.ciphertext,
                encryptionIv = encrypted.iv,
                encryptionAlgorithm = encrypted.algorithm,
                version = encryptionVersion,
                lastModifiedBy = item.serverUserId,
                encryptionVersion = encryptionVersion,
                encryptedByServerUserId = item.serverUserId,
                lastUsedAtMs = now,
                updatedAtMs = now,
            )

            if (recorded) {
                replica.updateItemAndQueue(
                    updated,
                    queuedWrite(updated, "update_item", encrypted, baseVersion, encryptionVersion),
                )
            } else {
                replica.putItem(updated)
            }

            PasskeyAssertionResult.Signed(
                credentialIdBytes = PasskeyUtils.decodeBase64OrBase64Url(credentialId),
                authenticatorData = PasskeyUtils.decodeBase64OrBase64Url(
                    signature.authenticatorDataBase64,
                ),
                signature = PasskeyUtils.decodeBase64OrBase64Url(signature.signatureDerBase64),
                userHandle = try {
                    PasskeyUtils.decodeBase64OrBase64Url(passkey.userHandle)
                } catch (_: Exception) {
                    ByteArray(0)
                },
            )
        } catch (e: Exception) {
            logger.warn("Failed to assert a passkey on item ${item.id}", e)
            PasskeyAssertionResult.Failed(e.message ?: "Assertion failed")
        } finally {
            muk.fill(0)
        }
    }

    /**
     * The next sign count, never below "now in seconds".
     *
     * A restored backup can carry a stale counter, and a relying party that sees
     * one go backwards may refuse the assertion.
     */
    private fun nextSignCount(currentCount: Int): Int {
        val nowSeconds = (clock.nowMs() / 1000L) + 1L
        return maxOf(currentCount.toLong() + 1L, nowSeconds)
            .coerceAtMost(Int.MAX_VALUE.toLong())
            .toInt()
    }

    private fun recordPasskeyUse(
        itemJson: JSONObject,
        credentialId: String,
        rpId: String,
        nextSignCount: Int,
        usedAtIso: String,
    ): Boolean {
        val passkeysJson = itemJson.optJSONArray("passkeys") ?: return false
        var updated = false

        for (index in 0 until passkeysJson.length()) {
            val passkeyJson = passkeysJson.optJSONObject(index) ?: continue
            if (canonicalCredentialIdOf(passkeyJson) != credentialId) continue

            val passkeyRpId = rpIdOf(passkeyJson)
            if (passkeyRpId.isBlank() || !DomainMatch.sameRelyingParty(passkeyRpId, rpId)) continue

            passkeyJson.put("signCount", nextSignCount)
            passkeyJson.put("lastUsedAt", usedAtIso)
            updated = true
        }

        return updated
    }

    override suspend fun passkeySaveTarget(
        rpId: String,
        userName: String,
    ): PasskeySaveTargetChoice = withContext(ioDispatcher) {
        val accounts = unlockedAccounts()
        if (accounts.isEmpty()) return@withContext PasskeySaveTargetChoice.VaultLocked

        val indexed = indexedSaveCandidates(accounts, rpId, userName)
        val candidates = indexed.ifEmpty { decryptedSaveCandidates(accounts, rpId, userName) }

        if (candidates.isEmpty() && matchExistsForLockedAccount(rpId, userName)) {
            return@withContext PasskeySaveTargetChoice.LockedAccountOwnsMatch
        }

        resolveSaveTarget(candidates, userName)
    }

    /**
     * Items already indexed under the relying party.
     *
     * The keys are narrower than a password lookup on purpose: a passkey belongs
     * to its relying party, and a sibling subdomain is a different party.
     */
    private suspend fun indexedSaveCandidates(
        accounts: List<UnlockedAccount>,
        rpId: String,
        userName: String,
    ): List<ReplicaItem> {
        val normalizedRpId = PasskeyUtils.normalizeHost(rpId)
        if (normalizedRpId.isBlank()) return emptyList()

        val domains = DomainMatch.relyingPartyLookupKeys(normalizedRpId)
        val results = LinkedHashMap<String, ReplicaItem>()
        for (account in accounts) {
            for (domain in domains) {
                for (item in replica.loginItemsByDomain(domain, account.serverUserId)) {
                    results[item.id] = item
                }
            }
        }
        return preferUserMatches(results.values.toList(), userName)
    }

    /**
     * The fallback for an item whose domain rows never made it: open the items of
     * the requested user and read the URLs out of the plaintext.
     */
    private suspend fun decryptedSaveCandidates(
        accounts: List<UnlockedAccount>,
        rpId: String,
        userName: String,
    ): List<ReplicaItem> {
        val normalizedRpId = PasskeyUtils.normalizeHost(rpId)
        if (normalizedRpId.isBlank()) return emptyList()
        val requestedUser = normalizeUsername(userName)
        if (requestedUser.isBlank()) return emptyList()

        val results = LinkedHashMap<String, ReplicaItem>()
        for (account in accounts) {
            val muk = liveUnlocks.borrowLiveMasterUnlockKey(account.accountId) ?: continue
            try {
                for (item in replica.loginItemsFor(account.serverUserId)) {
                    if (normalizeUsername(item.username) != requestedUser) continue
                    val vaultKey = replica.vaultKey(item.vaultId, item.serverUserId) ?: continue
                    try {
                        val itemJson = crypto.decryptItemJson(
                            item,
                            crypto.decryptVaultKey(vaultKey, muk),
                        )
                        val domains = storedDomains(itemJson)
                        if (domains.any { DomainMatch.sameRelyingParty(it, normalizedRpId) }) {
                            results[item.id] = item
                        }
                    } catch (e: Exception) {
                        logger.warn("Failed the decrypted candidate lookup for item ${item.id}", e)
                    }
                }
            } finally {
                muk.fill(0)
            }
        }
        return results.values.toList()
    }

    /** Whether some locked account owns a matching item. Only tells apart two "no"s. */
    private suspend fun matchExistsForLockedAccount(rpId: String, userName: String): Boolean {
        val normalizedRpId = PasskeyUtils.normalizeHost(rpId)
        if (normalizedRpId.isBlank()) return false

        val domains = DomainMatch.relyingPartyLookupKeys(normalizedRpId)
        val results = LinkedHashMap<String, ReplicaItem>()
        for (item in replica.loginItemsByDomainsAnyUser(domains)) {
            results[item.id] = item
        }
        return preferUserMatches(results.values.toList(), userName).isNotEmpty()
    }

    private fun preferUserMatches(
        candidates: List<ReplicaItem>,
        userName: String,
    ): List<ReplicaItem> {
        val requestedUser = normalizeUsername(userName)
        if (requestedUser.isBlank()) return candidates

        val exact = candidates.filter { normalizeUsername(it.username) == requestedUser }
        return if (exact.isNotEmpty()) exact else candidates
    }

    private fun resolveSaveTarget(
        candidates: List<ReplicaItem>,
        userName: String,
    ): PasskeySaveTargetChoice {
        if (candidates.isEmpty()) {
            return PasskeySaveTargetChoice.Resolved(PasskeySaveTarget.NewItem)
        }

        val requestedUser = normalizeUsername(userName)
        if (requestedUser.isNotBlank()) {
            val userMatches = candidates.filter { normalizeUsername(it.username) == requestedUser }
            if (userMatches.isNotEmpty()) {
                // Same user, several items: the one they touched last.
                val best = userMatches.maxWithOrNull(
                    compareBy<ReplicaItem> { it.lastUsedAtMs }.thenBy { it.updatedAtMs },
                ) ?: userMatches.first()
                return PasskeySaveTargetChoice.Resolved(PasskeySaveTarget.ExistingItem(best.id))
            }
        }

        if (candidates.size == 1) {
            return PasskeySaveTargetChoice.Resolved(
                PasskeySaveTarget.ExistingItem(candidates.first().id),
            )
        }

        return PasskeySaveTargetChoice.Ambiguous(
            candidates.map {
                PasskeySaveCandidate(
                    itemId = it.id,
                    label = it.displayTitle.ifBlank { "Login item" },
                    username = it.username?.takeIf { name -> name.isNotBlank() },
                )
            },
        )
    }

    override suspend fun savePasskey(
        request: PasskeySaveRequest,
    ): PasskeySaveResult = withContext(ioDispatcher) {
        val accounts = unlockedAccounts()
        val targetItem = when (val target = request.target) {
            is PasskeySaveTarget.ExistingItem -> replica.item(target.itemId)
                ?: return@withContext PasskeySaveResult.Failed("Item not found")

            PasskeySaveTarget.NewItem -> null
        }

        val serverUserId = targetItem?.serverUserId
            ?: accounts.firstOrNull()?.serverUserId
            ?: return@withContext PasskeySaveResult.Failed("Vault is locked for selected account")
        val muk = borrowFor(serverUserId)
            ?: return@withContext PasskeySaveResult.Failed("Vault is locked for selected account")

        try {
            val vaultKey = when {
                targetItem != null -> replica.vaultKey(targetItem.vaultId, targetItem.serverUserId)
                else -> writableVaultKey(serverUserId)
            } ?: return@withContext PasskeySaveResult.Failed("No writable vault key available")

            val decryptedVaultKey = crypto.decryptVaultKey(vaultKey, muk)
            val keypair = crypto.generatePasskeyKeypair()
            val credentialId = PasskeyUtils.canonicalizeCredentialId(crypto.generateCredentialId())
                ?: return@withContext PasskeySaveResult.Failed("Invalid generated credential ID")

            val rpId = PasskeyUtils.normalizeHost(request.rpId)
            val attestation = crypto.buildPasskeyAttestation(
                rpId = request.rpId,
                credentialIdBase64 = credentialId,
                cosePublicKeyBase64 = keypair.publicKeyCoseBase64,
                signCount = 0,
            )

            val passkey = StoredPasskey(
                credentialId = credentialId,
                rpId = rpId,
                rpName = request.rpName,
                userHandle = request.userHandle,
                userName = request.userName,
                userDisplayName = request.userDisplayName,
                privateKey = keypair.privateKeyBase64,
                publicKey = keypair.publicKeyCoseBase64,
                algorithm = -7,
                signCount = 0,
                transports = listOf("internal", "hybrid"),
                createdAt = Instant.ofEpochMilli(clock.nowMs()).toString(),
            )

            val savedItemId = if (targetItem != null) {
                appendPasskey(targetItem, decryptedVaultKey, passkey)
            } else {
                createItemWithPasskey(vaultKey, decryptedVaultKey, passkey, rpId, request)
            }

            PasskeySaveResult.Saved(
                itemId = savedItemId,
                credentialIdBytes = PasskeyUtils.decodeBase64OrBase64Url(credentialId),
                publicKeyCose = PasskeyUtils.decodeBase64OrBase64Url(keypair.publicKeyCoseBase64),
                publicKeySpki = PasskeyUtils.decodeBase64OrBase64Url(keypair.publicKeySpkiBase64),
                attestationObject = PasskeyUtils.decodeBase64OrBase64Url(
                    attestation.attestationObjectBase64,
                ),
                authenticatorData = PasskeyUtils.decodeBase64OrBase64Url(
                    attestation.authenticatorDataBase64,
                ),
            )
        } catch (e: Exception) {
            logger.warn("Failed to save a passkey", e)
            PasskeySaveResult.Failed(e.message ?: "Failed to save the passkey")
        } finally {
            muk.fill(0)
        }
    }

    private suspend fun appendPasskey(
        item: ReplicaItem,
        decryptedVaultKey: ByteArray,
        passkey: StoredPasskey,
    ): String {
        val itemJson = crypto.decryptItemJson(item, decryptedVaultKey)
        val passkeysJson = itemJson.optJSONArray("passkeys")
            ?: JSONArray().also { itemJson.put("passkeys", it) }
        passkeysJson.put(serializePasskey(passkey))

        val baseVersion = item.version
        val encryptionVersion = baseVersion + 1L
        val encrypted = crypto.encryptItemJson(
            json = itemJson,
            vaultKey = decryptedVaultKey,
            vaultId = item.vaultId,
            itemId = item.id,
            version = encryptionVersion,
            serverUserId = item.serverUserId,
        )
        val updated = item.copy(
            encryptedData = encrypted.ciphertext,
            encryptionIv = encrypted.iv,
            encryptionAlgorithm = encrypted.algorithm,
            version = encryptionVersion,
            lastModifiedBy = item.serverUserId,
            encryptionVersion = encryptionVersion,
            encryptedByServerUserId = item.serverUserId,
            updatedAtMs = clock.nowMs(),
        )

        replica.updateItemAndQueue(
            updated,
            queuedWrite(updated, "update_item", encrypted, baseVersion, encryptionVersion),
        )
        return updated.id
    }

    private suspend fun createItemWithPasskey(
        vaultKey: ReplicaVaultKey,
        decryptedVaultKey: ByteArray,
        passkey: StoredPasskey,
        rpId: String,
        request: PasskeySaveRequest,
    ): String {
        val itemId = UUID.randomUUID().toString()
        val primaryUrl = "https://$rpId"
        val itemJson = JSONObject().apply {
            put("title", request.rpName.ifBlank { rpId })
            put("username", request.userName)
            put("url", primaryUrl)
            put("urls", JSONArray())
        }
        PasskeyUtils.writeStoredPasskeys(itemJson, listOf(passkey))

        val encrypted = crypto.encryptItemJson(
            json = itemJson,
            vaultKey = decryptedVaultKey,
            vaultId = vaultKey.vaultId,
            itemId = itemId,
            version = 1L,
            serverUserId = vaultKey.serverUserId,
        )
        val now = clock.nowMs()
        val item = ReplicaItem(
            id = itemId,
            vaultId = vaultKey.vaultId,
            serverUserId = vaultKey.serverUserId,
            category = "login",
            displayTitle = request.rpName.ifBlank { rpId },
            encryptedData = encrypted.ciphertext,
            encryptionIv = encrypted.iv,
            encryptionAlgorithm = encrypted.algorithm,
            primaryDomain = rpId,
            username = request.userName,
            iconUrl = null,
            lastUsedAtMs = 0L,
            syncedAtMs = now,
            createdAtMs = now,
            updatedAtMs = now,
            isFavorite = false,
            version = 1L,
            lastModifiedBy = vaultKey.serverUserId,
            encryptionVersion = 1L,
            encryptedByServerUserId = vaultKey.serverUserId,
        )

        // One row per lookup key, the same way sync indexes items. A passkey
        // registered at login.example.com would otherwise never be found from an
        // example.com origin.
        val domains = DomainMatch.lookupKeys(rpId).mapIndexed { index, domain ->
            ReplicaItemDomain(
                itemId = itemId,
                domain = domain,
                isPrimary = index == 0,
                fullUrl = primaryUrl,
            )
        }

        replica.createItemAndQueue(
            item,
            domains,
            queuedWrite(item, "create_item", encrypted, baseVersion = 0L, encryptionVersion = 1L),
        )
        return itemId
    }

    private suspend fun writableVaultKey(serverUserId: String): ReplicaVaultKey? =
        replica.vaultKeysFor(serverUserId)
            .filter { it.role != "read-only" }
            .sortedWith(
                compareBy<ReplicaVaultKey> { if (it.vaultType == "personal") 0 else 1 }
                    .thenBy { it.vaultName },
            )
            .firstOrNull()

    private fun queuedWrite(
        item: ReplicaItem,
        operation: String,
        encrypted: EncryptedPayload,
        baseVersion: Long,
        encryptionVersion: Long,
    ) = PendingPasskeyMutation(
        id = UUID.randomUUID().toString(),
        serverUserId = item.serverUserId,
        vaultId = item.vaultId,
        itemId = item.id,
        operation = operation,
        encryptedData = encrypted.ciphertext,
        encryptionIv = encrypted.iv,
        encryptionAlgorithm = encrypted.algorithm,
        baseVersion = baseVersion,
        encryptionVersion = encryptionVersion,
        encryptedByServerUserId = item.serverUserId,
        createdAtMs = clock.nowMs(),
        attemptCount = 0,
        lastError = null,
    )

    // ------------------------------------------------------------------
    // Shared helpers
    // ------------------------------------------------------------------

    private class PasskeyCandidate(val item: ReplicaItem, val passkey: StoredPasskey)

    /** One unlocked account, and the server id its replica rows carry. */
    private class UnlockedAccount(val accountId: String, val serverUserId: String)

    private fun unlockedAccounts(): List<UnlockedAccount> =
        liveUnlocks.getUnlockedAccountIds().mapNotNull { accountId ->
            liveUnlocks.serverUserIdFor(accountId)?.let { UnlockedAccount(accountId, it) }
        }

    /** The live key of whichever account owns rows stamped with this server id. */
    private fun borrowFor(serverUserId: String): ByteArray? =
        liveUnlocks.accountIdForServerUserId(serverUserId)
            ?.let { liveUnlocks.borrowLiveMasterUnlockKey(it) }

    /**
     * Items indexed under an origin's keys.
     *
     * Items are indexed under `DomainMatch.lookupKeys`, so querying the same keys
     * is `DomainMatch.matches` expressed in SQL.
     */
    private suspend fun loginItemsFor(keys: List<String>, serverUserId: String): List<ReplicaItem> =
        when (keys.size) {
            0 -> emptyList()
            1 -> replica.loginItemsByDomain(keys[0], serverUserId)
            else -> replica.loginItemsByDomainAndParent(keys[0], keys[1], serverUserId)
        }

    /** Why a fill found nothing. The index is the usual answer. */
    private suspend fun logEmptyLookup(origin: String) {
        val indexed = try {
            replica.indexedDomains()
        } catch (_: Exception) {
            emptyList()
        }
        logger.debug("No items for '$origin'. Indexed domains: ${indexed.take(10)}")
    }

    /**
     * The host an origin names, or nothing.
     *
     * An Android signature origin identifies no host at all, so it yields nothing
     * rather than a string that could accidentally match an indexed domain.
     */
    private fun webHostOf(origin: String): String {
        if (origin.startsWith("android:apk-key-hash:")) return ""
        return DomainMatch.normalizeHost(origin)
    }

    /**
     * Whether a host looks like a site rather than a package name.
     *
     * `github.com` yes, `com.android.chrome` no. A package name reads as a
     * reversed domain, so a well-known TLD in *front* is the tell.
     */
    private fun isLikelyWebDomain(domain: String): Boolean {
        if (domain.isBlank()) return false
        val parts = domain.split(".")
        if (parts.size < 2) return false

        val tldPrefixes = setOf("com", "org", "net", "io", "edu", "gov", "mil", "int")
        if (tldPrefixes.contains(parts.first().lowercase()) && parts.size > 2) return false

        return parts.last().length in 2..6
    }

    private fun normalizeUsername(value: String?): String = value.orEmpty().trim().lowercase()

    private fun entryUsername(passkey: StoredPasskey, item: ReplicaItem): String =
        passkey.userName.takeIf { it.isNotBlank() }
            ?: item.username?.takeIf { it.isNotBlank() }
            ?: passkey.userDisplayName.takeIf { it.isNotBlank() }
            ?: "Passkey"

    private fun outranks(
        item: ReplicaItem,
        passkey: StoredPasskey,
        existing: PasskeyCandidate,
    ): Boolean {
        val candidateTime = passkeyRecencyMs(passkey)
        val existingTime = passkeyRecencyMs(existing.passkey)
        if (candidateTime != existingTime) return candidateTime > existingTime
        return item.lastUsedAtMs > existing.item.lastUsedAtMs
    }

    private fun passkeyRecencyMs(passkey: StoredPasskey): Long {
        val lastUsed = isoMillis(passkey.lastUsedAt)
        return if (lastUsed > 0L) lastUsed else isoMillis(passkey.createdAt)
    }

    private fun isoMillis(value: String?): Long {
        if (value.isNullOrBlank()) return 0L
        return try {
            Instant.parse(value).toEpochMilli()
        } catch (_: Exception) {
            0L
        }
    }

    private fun storedDomains(itemJson: JSONObject): Set<String> {
        val domains = LinkedHashSet<String>()

        PasskeyUtils.normalizeHost(itemJson.optString("url"))
            .takeIf { it.isNotBlank() }
            ?.let { domains.add(it) }

        val urls = itemJson.optJSONArray("urls")
        if (urls != null) {
            for (index in 0 until urls.length()) {
                PasskeyUtils.normalizeHost(urls.optString(index))
                    .takeIf { it.isNotBlank() }
                    ?.let { domains.add(it) }
            }
        }

        for (passkey in PasskeyUtils.parseStoredPasskeys(itemJson)) {
            PasskeyUtils.normalizeHost(passkey.rpId)
                .takeIf { it.isNotBlank() }
                ?.let { domains.add(it) }
        }

        return domains
    }

    private fun serializePasskey(passkey: StoredPasskey): JSONObject {
        val transportsJson = JSONArray()
        for (transport in passkey.transports) {
            transportsJson.put(transport)
        }

        return JSONObject().apply {
            put(
                "credentialId",
                PasskeyUtils.canonicalizeCredentialId(passkey.credentialId) ?: passkey.credentialId,
            )
            put("rpId", PasskeyUtils.normalizeHost(passkey.rpId))
            put("rpName", passkey.rpName)
            put(
                "userHandle",
                PasskeyUtils.canonicalizeCredentialId(passkey.userHandle) ?: passkey.userHandle,
            )
            put("userName", passkey.userName)
            put("userDisplayName", passkey.userDisplayName)
            put("privateKey", passkey.privateKey)
            put("publicKey", passkey.publicKey)
            put("algorithm", passkey.algorithm)
            put("signCount", passkey.signCount)
            put("createdAt", passkey.createdAt)
            passkey.lastUsedAt?.let { put("lastUsedAt", it) }
            passkey.status?.let { put("status", it) }
            passkey.statusReason?.let { put("statusReason", it) }
            passkey.statusUpdatedAt?.let { put("statusUpdatedAt", it) }
            put("transports", transportsJson)
        }
    }

    private fun canonicalCredentialIdOf(passkeyJson: JSONObject): String? {
        val raw = when {
            passkeyJson.has("credentialId") -> passkeyJson.opt("credentialId")
            passkeyJson.has("id") -> passkeyJson.opt("id")
            passkeyJson.has("rawId") -> passkeyJson.opt("rawId")
            else -> null
        }

        return when (raw) {
            is String -> PasskeyUtils.canonicalizeCredentialId(raw)
            is JSONArray -> {
                val bytes = ByteArray(raw.length())
                for (index in 0 until raw.length()) {
                    val numeric = raw.optInt(index, -1)
                    if (numeric !in 0..255) return null
                    bytes[index] = numeric.toByte()
                }
                PasskeyUtils.encodeBase64Url(bytes)
            }

            else -> null
        }
    }

    private fun rpIdOf(passkeyJson: JSONObject): String {
        val rpId = when {
            passkeyJson.has("rpId") -> passkeyJson.optString("rpId")
            passkeyJson.has("rpID") -> passkeyJson.optString("rpID")
            else -> passkeyJson.optJSONObject("rp")?.optString("id").orEmpty()
        }

        return PasskeyUtils.normalizeHost(rpId)
    }
}
