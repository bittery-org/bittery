package expo.modules.credentialprovider.storage

import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * Entity storing vault items with encrypted data from the server.
 *
 * The item's sensitive data (password, notes, etc.) is stored in encryptedData,
 * exactly as received from the server. Decryption happens on-demand when the
 * vault is unlocked, using:
 * 1. MUK to decrypt the vault key
 * 2. Vault key to decrypt the item data
 *
 * Denormalized fields (primaryDomain, username, displayTitle) are populated
 * during sync from the decrypted data to enable credential lookup without
 * decryption. Only login items are synced to this table.
 */
@Entity(
    tableName = "items",
    indices = [
        Index(value = ["vaultId"]),
        Index(value = ["vaultId", "userId"]),
        Index(value = ["category"]),
        Index(value = ["username"])
    ],
    foreignKeys = [
        ForeignKey(
            entity = VaultKeyEntity::class,
            parentColumns = ["vaultId", "userId"],
            childColumns = ["vaultId", "userId"],
            onDelete = ForeignKey.CASCADE
        )
    ]
)
data class ItemEntity(
    /** Item ID from the server */
    @PrimaryKey
    val id: String,

    /** Vault ID this item belongs to */
    val vaultId: String,

    /** User ID who owns access to this item */
    val userId: String,

    /** Item category: "login", "secure-note", "credit-card", "identity" */
    val category: String,

    /** Item title (from unencrypted overview) */
    val displayTitle: String,

    /** The encrypted item data blob from server (Base64 encoded) */
    val encryptedData: String,

    /** IV used for encryption (Base64 encoded) */
    val encryptionIv: String,

    /** Encryption algorithm (should be "AES-GCM") */
    val encryptionAlgorithm: String = "AES-GCM",

    // ============================================
    // Denormalized fields for credential lookup
    // Only populated for "login" category items
    // ============================================

    /** Primary domain for autofill matching (e.g., "example.com") */
    val primaryDomain: String? = null,

    /** Username/email for this login */
    val username: String? = null,

    /** Icon URL for display in credential picker */
    val iconUrl: String? = null,

    // ============================================
    // Metadata
    // ============================================

    /** Timestamp when this item was last used for autofill */
    val lastUsedAt: Long = 0,

    /** Timestamp when this item was last synced from server */
    val syncedAt: Long = System.currentTimeMillis(),

    /** Timestamp when item was created (from server) */
    val createdAt: Long = System.currentTimeMillis(),

    /** Timestamp when item was last updated (from server) */
    val updatedAt: Long = System.currentTimeMillis(),

    /** Whether this item is marked as favorite */
    val isFavorite: Boolean = false
)
