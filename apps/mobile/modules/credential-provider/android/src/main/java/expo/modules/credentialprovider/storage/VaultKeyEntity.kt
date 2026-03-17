package expo.modules.credentialprovider.storage

import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index

/**
 * Entity storing encrypted vault keys.
 *
 * Each vault key is encrypted with either:
 * - The user's MUK (for personal vaults)
 * - The user's RSA public key (for shared vaults)
 *
 * The vault key is then used to decrypt individual items in that vault.
 */
@Entity(
    tableName = "vault_keys",
    primaryKeys = ["vaultId", "userId"],
    indices = [
        Index(value = ["userId"]),
        Index(value = ["vaultId"])
    ],
    foreignKeys = [
        ForeignKey(
            entity = AuthDataEntity::class,
            parentColumns = ["userId"],
            childColumns = ["userId"],
            onDelete = ForeignKey.CASCADE
        )
    ]
)
data class VaultKeyEntity(
    /** Vault ID from the server */
    val vaultId: String,

    /** User ID who has access to this vault */
    val userId: String,

    /** Vault name for display */
    val vaultName: String,

    /** Vault type: "personal" or "team" */
    val vaultType: String,

    /**
     * The encrypted vault key (Base64 encoded).
     * - For personal vaults: encrypted with MUK
     * - For team vaults: encrypted with user's RSA public key
     */
    val encryptedKey: String,

    /** IV used for encryption (Base64 encoded) */
    val encryptionIv: String,

    /** Encryption algorithm: "AES-GCM" for MUK, "RSA-OAEP" for shared */
    val encryptionAlgorithm: String,

    /** User's role in this vault: "owner", "admin", "member", "read-only" */
    val role: String,

    /** Timestamp when this key was last synced from server */
    val syncedAt: Long = System.currentTimeMillis(),

    /**
     * Key version — part of the AES-GCM-AAD-V1 context used to wrap this vault key.
     * Matches the `keyVersion` field in the VaultKeyWrapContext stored alongside
     * the ciphertext on the server.
     */
    val keyVersion: Long = 1L
)
