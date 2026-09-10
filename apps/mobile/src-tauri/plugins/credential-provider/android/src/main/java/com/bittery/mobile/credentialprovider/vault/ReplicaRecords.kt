package com.bittery.mobile.credentialprovider.vault

/**
 * The records the vault works in.
 *
 * They mirror the Room rows field for field, but carry no Room annotation and no
 * Android type. That is the point: everything above [ReplicaStore] can then be
 * built, compared and tested on a plain JVM, and only the store adapter knows
 * that the replica happens to live in SQLite.
 *
 * "Replica" is what this data is. The server owns the vault; the device keeps an
 * encrypted copy so autofill can answer without a network call.
 *
 * Two identities travel together and must not be confused. `accountId` is what
 * the app and the live unlock state key by. `serverUserId` is what the server
 * stamps rows with, so it is what the replica keys by.
 */
internal data class ReplicaItem(
    val id: String,
    val vaultId: String,
    val serverUserId: String,
    val category: String,
    val displayTitle: String,
    val encryptedData: String,
    val encryptionIv: String,
    val encryptionAlgorithm: String,
    val primaryDomain: String?,
    val username: String?,
    val iconUrl: String?,
    val lastUsedAtMs: Long,
    val syncedAtMs: Long,
    val createdAtMs: Long,
    val updatedAtMs: Long,
    val isFavorite: Boolean,
    val version: Long,
    val lastModifiedBy: String?,
    val encryptionVersion: Long,
    val encryptedByServerUserId: String,
)

/** One wrapped vault key. The wrap is undone with the master unlock key. */
internal data class ReplicaVaultKey(
    val vaultId: String,
    val serverUserId: String,
    val vaultName: String,
    val vaultType: String,
    val encryptedKey: String,
    val encryptionIv: String,
    val encryptionAlgorithm: String,
    val role: String,
    val keyVersion: Long,
)

/** One row of the domain index an origin lookup joins against. */
internal data class ReplicaItemDomain(
    val itemId: String,
    val domain: String,
    val isPrimary: Boolean,
    val fullUrl: String?,
)

/** A vault write made on the device that the server has not accepted yet. */
internal data class PendingPasskeyMutation(
    val id: String,
    val serverUserId: String,
    val vaultId: String,
    val itemId: String,
    /** "create_item" or "update_item". */
    val operation: String,
    val encryptedData: String,
    val encryptionIv: String,
    val encryptionAlgorithm: String,
    val baseVersion: Long,
    val encryptionVersion: Long,
    val encryptedByServerUserId: String,
    val createdAtMs: Long,
    val attemptCount: Int,
    val lastError: String?,
)

/** The key-derivation profile an account's master unlock key was derived under. */
internal data class KdfProfile(
    val schemaVersion: Int,
    val algorithm: String,
    val iterations: Int,
)

/** A ciphertext with the IV and algorithm needed to read it back. */
internal data class EncryptedPayload(
    val ciphertext: String,
    val iv: String,
    val algorithm: String,
)

/** The fields autofill needs out of a decrypted login item. */
internal data class DecryptedLogin(
    val username: String?,
    val password: String?,
)
