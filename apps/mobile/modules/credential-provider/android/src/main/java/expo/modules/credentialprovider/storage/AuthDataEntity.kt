package expo.modules.credentialprovider.storage

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * Entity storing user authentication data.
 *
 * The secret key is stored in plaintext because it's useless without the password.
 * This matches the behavior in storage-react-native.ts where secret key is stored plaintext.
 *
 * The encrypted private key is encrypted with the Master Unlock Key (MUK) and
 * can only be decrypted when the vault is unlocked.
 */
@Entity(
    tableName = "auth_data",
    indices = [
        Index(value = ["userId"], unique = true)
    ]
)
data class AuthDataEntity(
    /** User's email address (primary key for single-account lookup) */
    @PrimaryKey
    val email: String,

    /** User ID from the server */
    val userId: String,

    /** The Secret Key in A3-XXXXXX format (stored plaintext, useless without password) */
    val secretKey: String,

    /** SRP salt used for password verification (Base64 encoded) */
    val srpSalt: String,

    /** User's RSA public key (PEM format, unencrypted) */
    val publicKey: String,

    /** User's RSA private key encrypted with MUK (Base64 encoded ciphertext) */
    val encryptedPrivateKey: String,

    /** IV used to encrypt the private key (Base64 encoded) */
    val encryptedPrivateKeyIv: String,

    /** Encryption algorithm used (should be "AES-GCM-AAD-V1") */
    val encryptionAlgorithm: String = "AES-GCM-AAD-V1",

    /** Hint for the secret key (e.g., last 4 characters) */
    val secretKeyHint: String? = null,

    /** Display name for this account */
    val displayName: String? = null,

    /** Team name if applicable */
    val teamName: String? = null,

    /** Timestamp when this account was added */
    val addedAt: Long = System.currentTimeMillis(),

    /** Timestamp when this account was last active */
    val lastActiveAt: Long = System.currentTimeMillis(),

    /** Timestamp of last master password entry (for 30-day re-entry check) */
    val lastMasterPasswordEntry: Long = System.currentTimeMillis(),

    /** Whether biometric unlock is enabled for this account */
    val biometricEnabled: Boolean = false,

    /** Custom server URL if not using default */
    val serverUrl: String? = null,

    /** KDF profile metadata is null only for resynchronizable placeholder rows. */
    val kdfSchemaVersion: Int? = null,
    val kdfAlgorithm: String? = null,
    val kdfIterations: Int? = null
)
