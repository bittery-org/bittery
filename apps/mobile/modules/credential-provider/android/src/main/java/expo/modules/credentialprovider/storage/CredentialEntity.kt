package expo.modules.credentialprovider.storage

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * Entity representing a stored credential in the credential provider database.
 * Passwords are encrypted with an Android Keystore key that requires biometric authentication.
 *
 * DEPRECATED: This entity uses the legacy double-encryption approach where passwords
 * are re-encrypted with BiometricKeyManager after being decrypted from server data.
 *
 * Use ItemEntity for new credential storage, which stores server-encrypted data directly
 * and decrypts on-demand using the Master Unlock Key from VaultStateManager.
 *
 * This entity is kept for backward compatibility with existing credentials.
 *
 * @see ItemEntity for the new unified storage approach
 */
@Entity(
    tableName = "credentials",
    indices = [
        Index(value = ["domain"]),
        Index(value = ["vaultId", "itemId"], unique = true)
    ]
)
data class CredentialEntity(
    @PrimaryKey
    val id: String,

    /** The vault ID from the main Bittery vault */
    val vaultId: String,

    /** The item ID from the main Bittery vault */
    val itemId: String,

    /** The domain/origin this credential is for (e.g., "example.com") */
    val domain: String,

    /** The username/email for this credential */
    val username: String,

    /** Display name shown in the credential picker */
    val displayName: String,

    /** The password encrypted with the biometric Keystore key (Base64 encoded) */
    val encryptedPassword: String,

    /** The IV used for encryption (Base64 encoded) */
    val iv: String,

    /** Optional icon URL for display */
    val iconUrl: String? = null,

    /** Timestamp when this credential was last used for autofill */
    val lastUsedAt: Long = 0,

    /** Timestamp when this credential was last synced from the main vault */
    val syncedAt: Long = System.currentTimeMillis()
)
