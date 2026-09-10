package com.bittery.mobile.credentialprovider.vault

import javax.crypto.Cipher
import kotlinx.coroutines.Dispatchers
import org.json.JSONObject

/**
 * The stand-ins that let the vault be tested on a plain JVM.
 *
 * One per port. Together they are the reason the vault's decisions — which
 * account owns a row, when a read may answer, what a locked account means — can
 * be driven without a device, a Keystore, a database or the native crypto core.
 */

/** A clock the test winds by hand, so expiry is driven rather than waited on. */
internal class FakeMonotonicClock(var nowMs: Long = 1_000L) : MonotonicClock {
    override fun nowMs(): Long = nowMs

    fun advance(ms: Long) {
        nowMs += ms
    }
}

internal class FakeWallClock(var nowMs: Long = 1_700_000_000_000L) : WallClock {
    override fun nowMs(): Long = nowMs
}

/** A 32-byte key whose every byte is [fill]. The fake crypto reads that byte. */
internal fun muk(fill: Byte) = ByteArray(LiveUnlockStore.MUK_SIZE_BYTES) { fill }

/**
 * The escrow, without a Keystore.
 *
 * [unwrapped] is what a successful biometric unlock produces; setting
 * [unwrapFailure] makes the unwrap fail after the prompt passed, which is the
 * case a caller must not confuse with a refusal.
 */
internal class FakeEscrowVault : EscrowVault {
    var record: Record? = null
    var masterPasswordRequired = false
    var remainingMs = 60_000L
    var lastMasterPasswordEntryMs = 0L
    var unwrapped: ByteArray = muk(1)
    var unwrapFailure: Exception? = null
    var cipherFailure: Exception? = null
    var wrapFailure: Exception? = null
    var wraps = mutableListOf<Wrap>()
    var cleared = 0

    class Record(
        val accountId: String?,
        val serverUserId: String?,
        val email: String = "user@example.com",
    )

    class Wrap(
        val muk: ByteArray,
        val email: String,
        val accountId: String,
        val serverUserId: String,
        val timeoutMs: Long,
    )

    override fun hasValidEscrow(): Boolean {
        val current = record ?: return false
        return !current.accountId.isNullOrBlank() && !current.serverUserId.isNullOrBlank()
    }

    /**
     * A record that names no account still exists — it just cannot be trusted to
     * say which vault it opens. That is the pre-rekey case.
     */
    fun holdsRecordNamingNoAccount() {
        record = Record(accountId = null, serverUserId = null)
    }

    override fun hasValidEscrowForEmail(email: String): Boolean =
        hasValidEscrow() && record?.email == email

    override fun remainingMs(): Long = remainingMs

    override fun accountId(): String? = record?.accountId

    override fun serverUserId(): String? = record?.serverUserId

    override fun canUseBiometricUnlock(): Boolean = hasValidEscrow() && !masterPasswordRequired

    override fun isMasterPasswordReentryRequired(): Boolean = masterPasswordRequired

    override fun recordMasterPasswordEntry() {
        lastMasterPasswordEntryMs = 42L
        masterPasswordRequired = false
    }

    override fun lastMasterPasswordEntryMs(): Long = lastMasterPasswordEntryMs

    override fun clear() {
        cleared++
        record = null
    }

    override fun wrap(
        muk: ByteArray,
        email: String,
        accountId: String,
        serverUserId: String,
        timeoutMs: Long,
    ) {
        wrapFailure?.let { throw it }
        wraps.add(Wrap(muk.copyOf(), email, accountId, serverUserId, timeoutMs))
        record = Record(accountId, serverUserId, email)
    }

    override fun decryptCipher(): Cipher {
        cipherFailure?.let { throw it }
        return Cipher.getInstance("AES/GCM/NoPadding")
    }

    override fun unwrap(cipher: Cipher): ByteArray {
        unwrapFailure?.let { throw it }
        return unwrapped.copyOf()
    }
}

/**
 * The replica, in memory.
 *
 * Only the queries the vault asks for, with the same meaning: login items only,
 * scoped to one server user unless the query says otherwise.
 */
internal class InMemoryReplicaStore : ReplicaStore {
    val items = LinkedHashMap<String, ReplicaItem>()
    val vaultKeys = LinkedHashMap<String, ReplicaVaultKey>()
    val domains = LinkedHashMap<String, List<ReplicaItemDomain>>()
    val pending = LinkedHashMap<String, PendingPasskeyMutation>()
    val accountProfiles = LinkedHashMap<String, KdfProfile>()
    val lastUsedWrites = mutableListOf<Pair<String, Long>>()
    var indexedDomainsFailure: Exception? = null

    /**
     * Runs at the moment a snapshot's items are written.
     *
     * The one seam a test needs to ask what a query would answer *during* an apply,
     * which is how the policy-before-data ordering is proved rather than asserted.
     */
    var onPutItems: (suspend () -> Unit)? = null

    /**
     * The policy a test has not named.
     *
     * Verified and off, so a test about something else never has to think about
     * travel mode. The tests that are about it name their own — including the
     * `null` that means nobody verified one.
     */
    var defaultTravelModePolicy: NativeTravelModePolicy? = NativeTravelModePolicy(
        enabled = false,
        hiddenVaultIds = emptySet(),
        updatedAtMs = 1L,
    )
    private val travelModePolicies = LinkedHashMap<String, NativeTravelModePolicy?>()

    fun setTravelModePolicy(serverUserId: String, policy: NativeTravelModePolicy?) {
        travelModePolicies[serverUserId] = policy
    }

    private fun keyOf(vaultId: String, serverUserId: String) = "$vaultId/$serverUserId"

    fun put(item: ReplicaItem) {
        items[item.id] = item
    }

    fun put(vaultKey: ReplicaVaultKey) {
        vaultKeys[keyOf(vaultKey.vaultId, vaultKey.serverUserId)] = vaultKey
    }

    fun index(itemId: String, vararg domainNames: String) {
        domains[itemId] = domainNames.mapIndexed { index, domain ->
            ReplicaItemDomain(itemId, domain, index == 0, null)
        }
    }

    private fun itemsIndexedUnder(domain: String): List<ReplicaItem> =
        domains.entries
            .filter { entry -> entry.value.any { it.domain == domain } }
            .mapNotNull { items[it.key] }
            .filter { it.category == "login" }

    override suspend fun upsertAccountProfile(
        serverUserId: String,
        email: String,
        secretKey: String,
        kdf: KdfProfile,
    ) {
        accountProfiles[serverUserId] = kdf
    }

    override suspend fun putVaultKeys(vaultKeys: List<ReplicaVaultKey>) {
        vaultKeys.forEach { put(it) }
    }

    override suspend fun putItems(items: List<ReplicaItem>) {
        onPutItems?.invoke()
        items.forEach { put(it) }
    }

    override suspend fun putItem(item: ReplicaItem) {
        put(item)
    }

    override suspend fun replaceItemDomains(itemId: String, domains: List<ReplicaItemDomain>) {
        if (!items.containsKey(itemId)) {
            // Room enforces this with a foreign key. So does the fake.
            throw IllegalStateException("No item $itemId to index")
        }
        this.domains[itemId] = domains
    }

    override suspend fun vaultIdsFor(serverUserId: String): List<String> =
        vaultKeys.values.filter { it.serverUserId == serverUserId }.map { it.vaultId }

    override suspend fun deleteVaultKey(vaultId: String, serverUserId: String) {
        vaultKeys.remove(keyOf(vaultId, serverUserId))
    }

    override suspend fun itemIdsFor(serverUserId: String): List<String> =
        items.values.filter { it.serverUserId == serverUserId }.map { it.id }

    override suspend fun deleteItem(itemId: String) {
        items.remove(itemId)
        domains.remove(itemId)
    }

    override suspend fun item(itemId: String): ReplicaItem? = items[itemId]

    override suspend fun vaultKey(vaultId: String, serverUserId: String): ReplicaVaultKey? =
        vaultKeys[keyOf(vaultId, serverUserId)]

    override suspend fun vaultKeysFor(serverUserId: String): List<ReplicaVaultKey> =
        vaultKeys.values.filter { it.serverUserId == serverUserId }

    override suspend fun loginItemsByDomain(
        domain: String,
        serverUserId: String,
    ): List<ReplicaItem> = itemsIndexedUnder(domain).filter { it.serverUserId == serverUserId }

    override suspend fun loginItemsByDomainAndParent(
        domain: String,
        parentDomain: String,
        serverUserId: String,
    ): List<ReplicaItem> {
        val matched = LinkedHashMap<String, ReplicaItem>()
        for (item in itemsIndexedUnder(domain) + itemsIndexedUnder(parentDomain)) {
            if (item.serverUserId == serverUserId) matched[item.id] = item
        }
        return matched.values.toList()
    }

    override suspend fun loginItemsByDomainsAnyUser(domains: List<String>): List<ReplicaItem> {
        val matched = LinkedHashMap<String, ReplicaItem>()
        for (domain in domains) {
            for (item in itemsIndexedUnder(domain)) matched[item.id] = item
        }
        return matched.values.toList()
    }

    override suspend fun loginItemsFor(serverUserId: String): List<ReplicaItem> =
        items.values.filter { it.serverUserId == serverUserId && it.category == "login" }

    override suspend fun indexedDomains(): List<String> {
        indexedDomainsFailure?.let { throw it }
        return domains.values.flatten().map { it.domain }.distinct()
    }

    override suspend fun touchLastUsed(itemId: String, timestampMs: Long) {
        lastUsedWrites.add(itemId to timestampMs)
        items[itemId]?.let { items[itemId] = it.copy(lastUsedAtMs = timestampMs) }
    }

    override suspend fun updateItemAndQueue(
        item: ReplicaItem,
        mutation: PendingPasskeyMutation,
    ) {
        put(item)
        pending[mutation.id] = mutation
    }

    override suspend fun createItemAndQueue(
        item: ReplicaItem,
        domains: List<ReplicaItemDomain>,
        mutation: PendingPasskeyMutation,
    ) {
        put(item)
        this.domains[item.id] = domains
        pending[mutation.id] = mutation
    }

    override suspend fun pendingMutations(serverUserId: String?): List<PendingPasskeyMutation> =
        pending.values.filter { serverUserId == null || it.serverUserId == serverUserId }

    override suspend fun dropPendingMutations(ids: List<String>) {
        ids.forEach { pending.remove(it) }
    }

    override suspend fun recordPendingMutationFailure(ids: List<String>, error: String) {
        for (id in ids) {
            val existing = pending[id] ?: continue
            pending[id] = existing.copy(
                attemptCount = existing.attemptCount + 1,
                lastError = error,
            )
        }
    }

    override suspend fun travelModePolicy(serverUserId: String): NativeTravelModePolicy? =
        if (travelModePolicies.containsKey(serverUserId)) {
            travelModePolicies[serverUserId]
        } else {
            defaultTravelModePolicy
        }

    override suspend fun putTravelModePolicy(
        serverUserId: String,
        policy: NativeTravelModePolicy?,
    ) {
        travelModePolicies[serverUserId] = policy
    }

    override suspend fun deleteVaultContents(
        serverUserId: String,
        vaultIds: Collection<String>,
    ) {
        if (vaultIds.isEmpty()) return
        val doomed = items.values
            .filter { it.serverUserId == serverUserId && it.vaultId in vaultIds }
            .map { it.id }
        // Room takes the domain rows with the items, through the cascade.
        doomed.forEach { deleteItem(it) }
        vaultIds.forEach { vaultKeys.remove(keyOf(it, serverUserId)) }
        pending.values
            .filter { it.serverUserId == serverUserId && it.vaultId in vaultIds }
            .map { it.id }
            .forEach { pending.remove(it) }
    }
}

/**
 * The cryptography, faked but not toothless.
 *
 * A vault key only opens with the master unlock key it was wrapped with, so a
 * test that hands one account's key to another account's vault fails the way the
 * real core would. Item plaintext is stored where the ciphertext would be.
 */
internal class FakeVaultCrypto : VaultCrypto {
    /** Items in here refuse to decrypt, standing in for a corrupt row. */
    val undecryptableItemIds = mutableSetOf<String>()

    override fun decryptVaultKey(vaultKey: ReplicaVaultKey, muk: ByteArray): ByteArray {
        val expected = vaultKey.encryptedKey
        val actual = muk.first().toString()
        if (expected != actual) {
            throw IllegalStateException("This key does not open vault ${vaultKey.vaultId}")
        }
        return "vault-key:${vaultKey.vaultId}".toByteArray()
    }

    override fun decryptItemJson(item: ReplicaItem, vaultKey: ByteArray): JSONObject {
        if (item.id in undecryptableItemIds) {
            throw IllegalStateException("Item ${item.id} will not decrypt")
        }
        return JSONObject(item.encryptedData)
    }

    override fun decryptLogin(item: ReplicaItem, vaultKey: ByteArray): DecryptedLogin {
        val json = decryptItemJson(item, vaultKey)
        return DecryptedLogin(
            username = json.optString("username").takeIf { it.isNotEmpty() },
            password = json.optString("password").takeIf { it.isNotEmpty() },
        )
    }

    override fun encryptItemJson(
        json: JSONObject,
        vaultKey: ByteArray,
        vaultId: String,
        itemId: String,
        version: Long,
        serverUserId: String,
    ): EncryptedPayload = EncryptedPayload(json.toString(), "iv", "AES-GCM-AAD-V1")

    override fun generatePasskeyKeypair() = PasskeyKeypair("private", "cose", "spki")

    override fun generateCredentialId(): String = "credential"

    override fun buildPasskeyAttestation(
        rpId: String,
        credentialIdBase64: String,
        cosePublicKeyBase64: String,
        signCount: Int,
    ) = PasskeyAttestation("authenticator-data", "attestation-object")

    override fun signPasskeyAssertion(
        privateKeyBase64: String,
        rpId: String,
        clientDataHashBase64: String,
        signCount: Int,
    ) = PasskeySignature("authenticator-data", "signature")
}

/** One assembled vault, with every port faked. */
internal class VaultUnderTest {
    val monotonicClock = FakeMonotonicClock()
    val wallClock = FakeWallClock()
    val liveUnlocks = LiveUnlockStore(monotonicClock)
    val escrow = FakeEscrowVault()
    val replica = InMemoryReplicaStore()
    val crypto = FakeVaultCrypto()

    /** The gate a test drives instead of a prompt. */
    var authentication: (Cipher) -> CipherAuthentication = {
        CipherAuthentication.Authenticated(it)
    }

    val impl = AndroidNativeCredentialVault(
        liveUnlocks = liveUnlocks,
        escrow = escrow,
        // Wrapped exactly as production wraps it, so every test asks the vault the
        // same question the device does — travel-mode filtering included.
        replica = TravelModeReplicaStore(replica),
        crypto = crypto,
        clock = wallClock,
        gate = RefusingGate,
        logger = VaultLogger.None,
        // Unconfined, so a test never has to think about which thread it is on.
        ioDispatcher = Dispatchers.Unconfined,
    )

    /** The vault as its callers see it. This is the surface under test. */
    val vault: NativeCredentialVault = impl

    suspend fun unlockWithBiometric(): UnlockResult =
        impl.unlockWithAuthenticatedCipher { authentication(it) }

    /**
     * A gate that would fail loudly if a test reached a real prompt.
     *
     * Tests drive [unlockWithBiometric] instead, which is the same code with the
     * prompt replaced.
     */
    private object RefusingGate : BiometricGate {
        override suspend fun authenticate(
            activity: androidx.fragment.app.FragmentActivity,
            subtitle: String,
            cipher: Cipher,
        ): CipherAuthentication = throw AssertionError("A test must not show a prompt")
    }
}

/** A login item whose plaintext is [username] and [password]. */
internal fun loginItem(
    id: String,
    serverUserId: String,
    vaultId: String = "vault-$serverUserId",
    username: String = "user@example.com",
    password: String = "secret",
    displayTitle: String = "Example",
    primaryDomain: String? = null,
    lastUsedAtMs: Long = 0L,
    updatedAtMs: Long = 0L,
    extraJson: JSONObject.() -> Unit = {},
): ReplicaItem {
    val json = JSONObject()
        .put("username", username)
        .put("password", password)
    json.extraJson()

    return ReplicaItem(
        id = id,
        vaultId = vaultId,
        serverUserId = serverUserId,
        category = "login",
        displayTitle = displayTitle,
        encryptedData = json.toString(),
        encryptionIv = "iv",
        encryptionAlgorithm = "AES-GCM-AAD-V1",
        primaryDomain = primaryDomain,
        username = username,
        iconUrl = null,
        lastUsedAtMs = lastUsedAtMs,
        syncedAtMs = 0L,
        createdAtMs = 0L,
        updatedAtMs = updatedAtMs,
        isFavorite = false,
        version = 1L,
        lastModifiedBy = null,
        encryptionVersion = 1L,
        encryptedByServerUserId = serverUserId,
    )
}

/** A vault key that opens with `muk(mukFill)`. */
internal fun vaultKey(
    serverUserId: String,
    mukFill: Byte,
    vaultId: String = "vault-$serverUserId",
    vaultType: String = "personal",
    role: String = "owner",
    vaultName: String = "Personal",
) = ReplicaVaultKey(
    vaultId = vaultId,
    serverUserId = serverUserId,
    vaultName = vaultName,
    vaultType = vaultType,
    encryptedKey = mukFill.toString(),
    encryptionIv = "iv",
    encryptionAlgorithm = "AES-GCM-AAD-V1",
    role = role,
    keyVersion = 1L,
)
