package com.bittery.mobile.credentialprovider.vault

import com.bittery.mobile.credentialprovider.storage.AuthDataEntity
import com.bittery.mobile.credentialprovider.storage.CredentialDatabase
import com.bittery.mobile.credentialprovider.storage.ItemDomainEntity
import com.bittery.mobile.credentialprovider.storage.ItemEntity
import com.bittery.mobile.credentialprovider.storage.PendingPasskeyMutationEntity
import com.bittery.mobile.credentialprovider.storage.TravelModePolicyEntity
import com.bittery.mobile.credentialprovider.storage.VaultKeyEntity

/**
 * The replica, in SQLite.
 *
 * The only place in the module that knows Room exists. Everything above works in
 * [ReplicaItem] and friends, so the vault's logic never sees an entity, a DAO or
 * a query.
 */
internal class RoomReplicaStore(
    private val database: CredentialDatabase,
) : ReplicaStore {

    override suspend fun upsertAccountProfile(
        serverUserId: String,
        email: String,
        secretKey: String,
        kdf: KdfProfile,
    ) {
        // A real sync always replaces the nullable placeholder profile with a
        // complete one, and keeps every other column the account already had.
        val existing = database.authDataDao().getByUserId(serverUserId)
        val account = existing?.copy(
            email = email,
            secretKey = secretKey,
            kdfSchemaVersion = kdf.schemaVersion,
            kdfAlgorithm = kdf.algorithm,
            kdfIterations = kdf.iterations,
        ) ?: AuthDataEntity(
            email = email,
            userId = serverUserId,
            secretKey = secretKey,
            srpSalt = "",
            publicKey = "",
            encryptedPrivateKey = "",
            encryptedPrivateKeyIv = "",
            kdfSchemaVersion = kdf.schemaVersion,
            kdfAlgorithm = kdf.algorithm,
            kdfIterations = kdf.iterations,
        )
        database.authDataDao().insert(account)
    }

    override suspend fun putVaultKeys(vaultKeys: List<ReplicaVaultKey>) {
        database.vaultKeyDao().insertAll(vaultKeys.map { it.toEntity() })
    }

    override suspend fun putItems(items: List<ReplicaItem>) {
        database.itemDao().insertAll(items.map { it.toEntity() })
    }

    override suspend fun putItem(item: ReplicaItem) {
        database.itemDao().insert(item.toEntity())
    }

    override suspend fun replaceItemDomains(itemId: String, domains: List<ReplicaItemDomain>) {
        database.itemDomainDao().replaceDomainsForItem(itemId, domains.map { it.toEntity() })
    }

    override suspend fun vaultIdsFor(serverUserId: String): List<String> =
        database.vaultKeyDao().getVaultIdsByUserId(serverUserId)

    override suspend fun deleteVaultKey(vaultId: String, serverUserId: String) {
        database.vaultKeyDao().delete(vaultId, serverUserId)
    }

    override suspend fun itemIdsFor(serverUserId: String): List<String> =
        database.itemDao().getItemIdsByUserId(serverUserId)

    override suspend fun deleteItem(itemId: String) {
        database.itemDao().deleteById(itemId)
    }

    override suspend fun item(itemId: String): ReplicaItem? =
        database.itemDao().getById(itemId)?.toRecord()

    override suspend fun vaultKey(vaultId: String, serverUserId: String): ReplicaVaultKey? =
        database.vaultKeyDao().getByVaultId(vaultId, serverUserId)?.toRecord()

    override suspend fun vaultKeysFor(serverUserId: String): List<ReplicaVaultKey> =
        database.vaultKeyDao().getByUserId(serverUserId).map { it.toRecord() }

    override suspend fun loginItemsByDomain(
        domain: String,
        serverUserId: String,
    ): List<ReplicaItem> =
        database.itemDao().getLoginItemsByDomain(domain, serverUserId).map { it.toRecord() }

    override suspend fun loginItemsByDomainAndParent(
        domain: String,
        parentDomain: String,
        serverUserId: String,
    ): List<ReplicaItem> = database.itemDao()
        .getLoginItemsByDomainAndParent(domain, parentDomain, serverUserId)
        .map { it.toRecord() }

    override suspend fun loginItemsByDomainsAnyUser(domains: List<String>): List<ReplicaItem> =
        database.itemDao().getLoginItemsByDomainsAnyUser(domains).map { it.toRecord() }

    override suspend fun loginItemsFor(serverUserId: String): List<ReplicaItem> =
        database.itemDao().getLoginItemsByUserId(serverUserId).map { it.toRecord() }

    override suspend fun indexedDomains(): List<String> = database.itemDomainDao().getAllDomains()

    override suspend fun touchLastUsed(itemId: String, timestampMs: Long) {
        database.itemDao().updateLastUsed(itemId, timestampMs)
    }

    override suspend fun updateItemAndQueue(
        item: ReplicaItem,
        mutation: PendingPasskeyMutation,
    ) {
        database.passkeyMutationDao().updateItemAndQueue(item.toEntity(), mutation.toEntity())
    }

    override suspend fun createItemAndQueue(
        item: ReplicaItem,
        domains: List<ReplicaItemDomain>,
        mutation: PendingPasskeyMutation,
    ) {
        database.passkeyMutationDao().createItemAndQueue(
            item.toEntity(),
            domains.map { it.toEntity() },
            mutation.toEntity(),
        )
    }

    override suspend fun pendingMutations(serverUserId: String?): List<PendingPasskeyMutation> {
        val dao = database.pendingPasskeyMutationDao()
        val entities = if (serverUserId == null) dao.getAll() else dao.getByUserId(serverUserId)
        return entities.map { it.toRecord() }
    }

    override suspend fun dropPendingMutations(ids: List<String>) {
        database.pendingPasskeyMutationDao().deleteByIds(ids)
    }

    override suspend fun recordPendingMutationFailure(ids: List<String>, error: String) {
        database.pendingPasskeyMutationDao().markFailed(ids, error)
    }

    override suspend fun travelModePolicy(serverUserId: String): NativeTravelModePolicy? =
        database.travelModePolicyDao().getByUserId(serverUserId)?.toRecord()

    override suspend fun putTravelModePolicy(
        serverUserId: String,
        policy: NativeTravelModePolicy?,
    ) {
        val dao = database.travelModePolicyDao()
        if (policy == null) {
            dao.deleteByUserId(serverUserId)
            return
        }
        dao.insert(policy.toEntity(serverUserId))
    }

    override suspend fun deleteVaultContents(
        serverUserId: String,
        vaultIds: Collection<String>,
    ) {
        database.travelModePolicyDao().eraseVaults(serverUserId, vaultIds.toList())
    }
}

// ----------------------------------------------------------------------
// Row <-> record. The only mapping in the module.
// ----------------------------------------------------------------------

private fun ItemEntity.toRecord() = ReplicaItem(
    id = id,
    vaultId = vaultId,
    serverUserId = userId,
    category = category,
    displayTitle = displayTitle,
    encryptedData = encryptedData,
    encryptionIv = encryptionIv,
    encryptionAlgorithm = encryptionAlgorithm,
    primaryDomain = primaryDomain,
    username = username,
    iconUrl = iconUrl,
    lastUsedAtMs = lastUsedAt,
    syncedAtMs = syncedAt,
    createdAtMs = createdAt,
    updatedAtMs = updatedAt,
    isFavorite = isFavorite,
    version = version,
    lastModifiedBy = lastModifiedBy,
    encryptionVersion = encryptionVersion,
    encryptedByServerUserId = encryptedByUserId,
)

private fun ReplicaItem.toEntity() = ItemEntity(
    id = id,
    vaultId = vaultId,
    userId = serverUserId,
    category = category,
    displayTitle = displayTitle,
    encryptedData = encryptedData,
    encryptionIv = encryptionIv,
    encryptionAlgorithm = encryptionAlgorithm,
    primaryDomain = primaryDomain,
    username = username,
    iconUrl = iconUrl,
    lastUsedAt = lastUsedAtMs,
    syncedAt = syncedAtMs,
    createdAt = createdAtMs,
    updatedAt = updatedAtMs,
    isFavorite = isFavorite,
    version = version,
    lastModifiedBy = lastModifiedBy,
    encryptionVersion = encryptionVersion,
    encryptedByUserId = encryptedByServerUserId,
)

private fun VaultKeyEntity.toRecord() = ReplicaVaultKey(
    vaultId = vaultId,
    serverUserId = userId,
    vaultName = vaultName,
    vaultType = vaultType,
    encryptedKey = encryptedKey,
    encryptionIv = encryptionIv,
    encryptionAlgorithm = encryptionAlgorithm,
    role = role,
    keyVersion = keyVersion,
)

private fun ReplicaVaultKey.toEntity() = VaultKeyEntity(
    vaultId = vaultId,
    userId = serverUserId,
    vaultName = vaultName,
    vaultType = vaultType,
    encryptedKey = encryptedKey,
    encryptionIv = encryptionIv,
    encryptionAlgorithm = encryptionAlgorithm,
    role = role,
    keyVersion = keyVersion,
)

/** Newline-separated, because Room stores no collections and a vault id holds none. */
private fun TravelModePolicyEntity.toRecord() = NativeTravelModePolicy(
    enabled = enabled,
    hiddenVaultIds = hiddenVaultIds.split('\n').filter { it.isNotBlank() }.toSet(),
    updatedAtMs = updatedAt,
)

private fun NativeTravelModePolicy.toEntity(serverUserId: String) = TravelModePolicyEntity(
    userId = serverUserId,
    enabled = enabled,
    hiddenVaultIds = hiddenVaultIds.joinToString("\n"),
    updatedAt = updatedAtMs,
)

private fun ReplicaItemDomain.toEntity() = ItemDomainEntity(
    itemId = itemId,
    domain = domain,
    isPrimary = isPrimary,
    fullUrl = fullUrl,
)

private fun PendingPasskeyMutationEntity.toRecord() = PendingPasskeyMutation(
    id = id,
    serverUserId = userId,
    vaultId = vaultId,
    itemId = itemId,
    operation = operation,
    encryptedData = encryptedData,
    encryptionIv = encryptionIv,
    encryptionAlgorithm = encryptionAlgorithm,
    baseVersion = baseVersion,
    encryptionVersion = encryptionVersion,
    encryptedByServerUserId = encryptedByUserId,
    createdAtMs = createdAt,
    attemptCount = attemptCount,
    lastError = lastError,
)

private fun PendingPasskeyMutation.toEntity() = PendingPasskeyMutationEntity(
    id = id,
    userId = serverUserId,
    vaultId = vaultId,
    itemId = itemId,
    operation = operation,
    encryptedData = encryptedData,
    encryptionIv = encryptionIv,
    encryptionAlgorithm = encryptionAlgorithm,
    baseVersion = baseVersion,
    encryptionVersion = encryptionVersion,
    encryptedByUserId = encryptedByServerUserId,
    createdAt = createdAtMs,
    attemptCount = attemptCount,
    lastError = lastError,
)
