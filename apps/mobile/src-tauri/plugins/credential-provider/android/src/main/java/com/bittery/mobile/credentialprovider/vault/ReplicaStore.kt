package com.bittery.mobile.credentialprovider.vault

/**
 * Everything the vault needs from the local encrypted replica.
 *
 * This is deliberately table-shaped, and it is deliberately *inside* the module.
 * Callers never see it: they ask [NativeCredentialVault] for credentials, and the
 * vault decides which rows that means. Keeping the shape here also keeps Room out
 * of the vault's own logic, so that logic runs in a plain JVM test.
 *
 * **Two kinds of read live here, and travel mode tells them apart.** A *serving*
 * read answers "what may this caller be offered" — anything returning a
 * [ReplicaItem] or a [ReplicaVaultKey] to a lookup. [TravelModeReplicaStore]
 * filters every one of them, and that is the only place the rule is written. A
 * *maintenance* read answers "what is on this device" — [vaultIdsFor],
 * [itemIdsFor], [indexedDomains] and [pendingMutations] — and stays unfiltered,
 * because a purge that cannot see a hidden row cannot delete it. Anything added
 * below is one or the other; decide which, and say so.
 */
internal interface ReplicaStore {

    /** Record the account's KDF profile and secret key, keeping any other columns. */
    suspend fun upsertAccountProfile(
        serverUserId: String,
        email: String,
        secretKey: String,
        kdf: KdfProfile,
    )

    suspend fun putVaultKeys(vaultKeys: List<ReplicaVaultKey>)

    suspend fun putItems(items: List<ReplicaItem>)

    suspend fun putItem(item: ReplicaItem)

    suspend fun replaceItemDomains(itemId: String, domains: List<ReplicaItemDomain>)

    suspend fun vaultIdsFor(serverUserId: String): List<String>

    suspend fun deleteVaultKey(vaultId: String, serverUserId: String)

    suspend fun itemIdsFor(serverUserId: String): List<String>

    suspend fun deleteItem(itemId: String)

    suspend fun item(itemId: String): ReplicaItem?

    suspend fun vaultKey(vaultId: String, serverUserId: String): ReplicaVaultKey?

    suspend fun vaultKeysFor(serverUserId: String): List<ReplicaVaultKey>

    suspend fun loginItemsByDomain(domain: String, serverUserId: String): List<ReplicaItem>

    suspend fun loginItemsByDomainAndParent(
        domain: String,
        parentDomain: String,
        serverUserId: String,
    ): List<ReplicaItem>

    /** Cross-account lookup, used only to tell "no match" from "match, but locked". */
    suspend fun loginItemsByDomainsAnyUser(domains: List<String>): List<ReplicaItem>

    suspend fun loginItemsFor(serverUserId: String): List<ReplicaItem>

    /** Every indexed domain. Diagnostic only. */
    suspend fun indexedDomains(): List<String>

    suspend fun touchLastUsed(itemId: String, timestampMs: Long)

    /** One transaction: rewrite the item and queue the write for the server. */
    suspend fun updateItemAndQueue(item: ReplicaItem, mutation: PendingPasskeyMutation)

    /** One transaction: create the item with its domain rows and queue the write. */
    suspend fun createItemAndQueue(
        item: ReplicaItem,
        domains: List<ReplicaItemDomain>,
        mutation: PendingPasskeyMutation,
    )

    /** Queued writes, for one account or — with a null id — for all of them. */
    suspend fun pendingMutations(serverUserId: String?): List<PendingPasskeyMutation>

    suspend fun dropPendingMutations(ids: List<String>)

    suspend fun recordPendingMutationFailure(ids: List<String>, error: String)

    // ------------------------------------------------------------------
    // Travel mode
    // ------------------------------------------------------------------

    /**
     * The account's verified travel-mode policy, or `null` when none is verified.
     *
     * It is stored beside the rows it governs so a process restart cannot separate
     * the two. The key material is gone after a restart, but a biometric unlock can
     * bring it back without the app syncing first, and the policy has to be there
     * when it does.
     */
    suspend fun travelModePolicy(serverUserId: String): NativeTravelModePolicy?

    /** Record the policy. `null` means unverified: the account then serves nothing. */
    suspend fun putTravelModePolicy(serverUserId: String, policy: NativeTravelModePolicy?)

    /**
     * Erase every key, item and domain row of these vaults.
     *
     * This is the purge travel mode requires — a hidden vault's material leaves the
     * device rather than being filtered out of a list. Queued writes for those
     * vaults go too; they carry the same ciphertext.
     */
    suspend fun deleteVaultContents(serverUserId: String, vaultIds: Collection<String>)
}
