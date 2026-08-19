package com.bittery.mobile.credentialprovider.vault

/**
 * The one place travel mode is enforced on a read.
 *
 * Every serving read comes back as if it said
 * `WHERE account_id = ? AND vault_id NOT IN hidden_vault_ids_for_account`, and it
 * is written once, here. The vault reaches the replica only through
 * [ReplicaStore], so a lookup added tomorrow is filtered whether or not its author
 * thought about travel mode. Every member is implemented by hand rather than
 * delegated wholesale, so adding one to [ReplicaStore] breaks this file until
 * somebody decides which kind it is.
 *
 * **It filters; it does not replace the purge.** A hidden vault's keys and cached
 * items are *erased* from the device, not merely suppressed — that is what
 * `CONTEXT.md` means by "hidden vault", and
 * `AndroidNativeCredentialVault.replaceReplica` does the erasing. This layer is
 * the second lock. It holds if a purge fails, and it holds if a future sync ever
 * sends a hidden vault down.
 *
 * **No verified policy means no answers.** The TypeScript fails closed the same
 * way: `TravelModeEnforcer.verifyOrClear` answers a policy it cannot verify by
 * locking the account and purging the native mirror, so the account stops
 * offering credentials. Here the account simply serves nothing until a snapshot
 * brings a verified policy.
 */
internal class TravelModeReplicaStore(
    private val delegate: ReplicaStore,
) : ReplicaStore {

    /**
     * The policies this call has already looked up.
     *
     * One lookup per account per query, not one per row. Deliberately per call and
     * not a field: a policy committed a moment ago must take effect on the very
     * next query, and a cache that outlives the call is a window where it does not.
     */
    private class Policies(private val store: ReplicaStore) {
        private val seen = HashMap<String, NativeTravelModePolicy?>()

        suspend fun of(serverUserId: String): NativeTravelModePolicy? {
            if (seen.containsKey(serverUserId)) return seen[serverUserId]
            val policy = store.travelModePolicy(serverUserId)
            seen[serverUserId] = policy
            return policy
        }

        /** The invariant: a verified policy exists, and it does not hide this vault. */
        suspend fun serves(serverUserId: String, vaultId: String): Boolean {
            val policy = of(serverUserId) ?: return false
            return !policy.hides(vaultId)
        }
    }

    private fun policies() = Policies(delegate)

    // ------------------------------------------------------------------
    // Serving reads — filtered. What a caller may be offered.
    // ------------------------------------------------------------------

    override suspend fun item(itemId: String): ReplicaItem? {
        val item = delegate.item(itemId) ?: return null
        return item.takeIf { policies().serves(it.serverUserId, it.vaultId) }
    }

    override suspend fun vaultKey(vaultId: String, serverUserId: String): ReplicaVaultKey? {
        if (!policies().serves(serverUserId, vaultId)) return null
        return delegate.vaultKey(vaultId, serverUserId)
    }

    override suspend fun vaultKeysFor(serverUserId: String): List<ReplicaVaultKey> =
        delegate.vaultKeysFor(serverUserId).keepVaultKeys(policies())

    override suspend fun loginItemsByDomain(
        domain: String,
        serverUserId: String,
    ): List<ReplicaItem> = delegate.loginItemsByDomain(domain, serverUserId).keepItems(policies())

    override suspend fun loginItemsByDomainAndParent(
        domain: String,
        parentDomain: String,
        serverUserId: String,
    ): List<ReplicaItem> = delegate
        .loginItemsByDomainAndParent(domain, parentDomain, serverUserId)
        .keepItems(policies())

    override suspend fun loginItemsByDomainsAnyUser(domains: List<String>): List<ReplicaItem> =
        delegate.loginItemsByDomainsAnyUser(domains).keepItems(policies())

    override suspend fun loginItemsFor(serverUserId: String): List<ReplicaItem> =
        delegate.loginItemsFor(serverUserId).keepItems(policies())

    // ------------------------------------------------------------------
    // Snapshot writes — filtered. Never keep what may not be served.
    // ------------------------------------------------------------------

    override suspend fun putVaultKeys(vaultKeys: List<ReplicaVaultKey>) {
        val policies = policies()
        delegate.putVaultKeys(vaultKeys.filter { policies.serves(it.serverUserId, it.vaultId) })
    }

    override suspend fun putItems(items: List<ReplicaItem>) {
        delegate.putItems(items.keepItems(policies()))
    }

    // ------------------------------------------------------------------
    // Maintenance and writeback — unfiltered, on purpose.
    //
    // These answer "what is on this device", which is exactly what a purge and an
    // orphan sweep have to know. A filtered answer would leave hidden rows behind
    // because nothing could see them to delete them. None of them reaches a
    // caller: the vault uses them to decide what to erase and what to send home.
    // ------------------------------------------------------------------

    override suspend fun vaultIdsFor(serverUserId: String): List<String> =
        delegate.vaultIdsFor(serverUserId)

    override suspend fun itemIdsFor(serverUserId: String): List<String> =
        delegate.itemIdsFor(serverUserId)

    override suspend fun indexedDomains(): List<String> = delegate.indexedDomains()

    override suspend fun pendingMutations(serverUserId: String?): List<PendingPasskeyMutation> =
        delegate.pendingMutations(serverUserId)

    // ------------------------------------------------------------------
    // Straight-through: the policy itself, deletes, and the single-item writes
    // whose inputs already came back through a filtered read.
    // ------------------------------------------------------------------

    override suspend fun travelModePolicy(serverUserId: String): NativeTravelModePolicy? =
        delegate.travelModePolicy(serverUserId)

    override suspend fun putTravelModePolicy(
        serverUserId: String,
        policy: NativeTravelModePolicy?,
    ) = delegate.putTravelModePolicy(serverUserId, policy)

    override suspend fun deleteVaultContents(serverUserId: String, vaultIds: Collection<String>) =
        delegate.deleteVaultContents(serverUserId, vaultIds)

    override suspend fun upsertAccountProfile(
        serverUserId: String,
        email: String,
        secretKey: String,
        kdf: KdfProfile,
    ) = delegate.upsertAccountProfile(serverUserId, email, secretKey, kdf)

    override suspend fun putItem(item: ReplicaItem) = delegate.putItem(item)

    override suspend fun replaceItemDomains(itemId: String, domains: List<ReplicaItemDomain>) =
        delegate.replaceItemDomains(itemId, domains)

    override suspend fun deleteVaultKey(vaultId: String, serverUserId: String) =
        delegate.deleteVaultKey(vaultId, serverUserId)

    override suspend fun deleteItem(itemId: String) = delegate.deleteItem(itemId)

    override suspend fun touchLastUsed(itemId: String, timestampMs: Long) =
        delegate.touchLastUsed(itemId, timestampMs)

    override suspend fun updateItemAndQueue(
        item: ReplicaItem,
        mutation: PendingPasskeyMutation,
    ) = delegate.updateItemAndQueue(item, mutation)

    override suspend fun createItemAndQueue(
        item: ReplicaItem,
        domains: List<ReplicaItemDomain>,
        mutation: PendingPasskeyMutation,
    ) = delegate.createItemAndQueue(item, domains, mutation)

    override suspend fun dropPendingMutations(ids: List<String>) =
        delegate.dropPendingMutations(ids)

    override suspend fun recordPendingMutationFailure(ids: List<String>, error: String) =
        delegate.recordPendingMutationFailure(ids, error)

    /** Each row judged against its own account's policy, never the caller's. */
    private suspend fun List<ReplicaItem>.keepItems(policies: Policies): List<ReplicaItem> =
        filter { policies.serves(it.serverUserId, it.vaultId) }

    private suspend fun List<ReplicaVaultKey>.keepVaultKeys(
        policies: Policies,
    ): List<ReplicaVaultKey> = filter { policies.serves(it.serverUserId, it.vaultId) }
}
