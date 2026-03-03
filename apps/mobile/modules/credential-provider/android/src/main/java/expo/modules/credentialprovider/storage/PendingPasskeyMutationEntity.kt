package expo.modules.credentialprovider.storage

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * Queue entry for deferred passkey mutations.
 *
 * These are flushed by the React Native layer before inbound vault sync runs.
 */
@Entity(
    tableName = "pending_passkey_mutations",
    indices = [
        Index(value = ["userId"]),
        Index(value = ["createdAt"]),
        Index(value = ["operation"])
    ]
)
data class PendingPasskeyMutationEntity(
    @PrimaryKey
    val id: String,
    val userId: String,
    val vaultId: String,
    val itemId: String,
    /** "create_item" | "update_item" */
    val operation: String,
    val encryptedData: String,
    val encryptionIv: String,
    val encryptionAlgorithm: String = "AES-GCM-AAD-V1",
    val createdAt: Long = System.currentTimeMillis(),
    val attemptCount: Int = 0,
    val lastError: String? = null
)
