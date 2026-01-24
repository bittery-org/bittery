package expo.modules.credentialprovider.storage

import android.content.Context
import android.os.Build
import android.util.Base64
import androidx.annotation.RequiresApi
import expo.modules.credentialprovider.crypto.BiometricKeyManager
import java.util.UUID
import javax.crypto.Cipher

/**
 * High-level manager for credential storage operations.
 * Handles encryption/decryption and database operations.
 *
 * LEGACY STORAGE (DEPRECATED):
 * This class manages the legacy credential storage where passwords are
 * encrypted with BiometricKeyManager (a separate Android Keystore key).
 * This results in "double encryption" - passwords are encrypted on the server
 * with the vault key, then encrypted again here with the biometric key.
 *
 * NEW UNIFIED STORAGE:
 * The new architecture stores server-encrypted data directly in ItemEntity
 * and uses VaultStateManager + MUK for on-demand decryption. This eliminates
 * double encryption and allows the credential provider to work with the same
 * encrypted data as the main app.
 *
 * The BitteryCredentialProviderService and GetCredentialsActivity support both
 * storage types for backward compatibility:
 * - Legacy: CredentialEntity (this class)
 * - Unified: ItemEntity + VaultKeyEntity + VaultDecryptor
 *
 * Migration: Data can be migrated by simply re-syncing from the server after
 * the user unlocks with their password. The legacy data will be preserved until
 * explicitly cleared.
 *
 * @deprecated Use ItemEntity + VaultDecryptor for new credential storage.
 */
class CredentialStorageManager(private val context: Context) {
    private val database: CredentialDatabase by lazy {
        CredentialDatabase.getInstance(context)
    }

    private val dao: CredentialDao by lazy {
        database.credentialDao()
    }

    val biometricKeyManager: BiometricKeyManager by lazy {
        BiometricKeyManager(context)
    }

    /**
     * Save a credential with the given authenticated cipher.
     * The cipher must be authenticated via BiometricPrompt first.
     */
    @RequiresApi(Build.VERSION_CODES.M)
    suspend fun saveCredential(
        cipher: Cipher,
        vaultId: String,
        itemId: String,
        domain: String,
        username: String,
        password: String,
        displayName: String,
        iconUrl: String? = null
    ): String {
        // Encrypt the password
        val (encryptedData, iv) = biometricKeyManager.encryptWithCipher(
            cipher,
            password.toByteArray(Charsets.UTF_8)
        )

        val encryptedPasswordBase64 = Base64.encodeToString(encryptedData, Base64.NO_WRAP)
        val ivBase64 = Base64.encodeToString(iv, Base64.NO_WRAP)

        // Check if credential already exists for this vault item
        val existing = dao.getByVaultAndItem(vaultId, itemId)
        val id = existing?.id ?: UUID.randomUUID().toString()

        val credential = CredentialEntity(
            id = id,
            vaultId = vaultId,
            itemId = itemId,
            domain = domain,
            username = username,
            displayName = displayName,
            encryptedPassword = encryptedPasswordBase64,
            iv = ivBase64,
            iconUrl = iconUrl,
            lastUsedAt = existing?.lastUsedAt ?: 0,
            syncedAt = System.currentTimeMillis()
        )

        dao.insert(credential)
        return id
    }

    /**
     * Get a decrypted password using the given authenticated cipher.
     * The cipher must be authenticated via BiometricPrompt first.
     */
    @RequiresApi(Build.VERSION_CODES.M)
    suspend fun getDecryptedPassword(cipher: Cipher, credentialId: String): String? {
        val credential = dao.getById(credentialId) ?: return null

        val encryptedData = Base64.decode(credential.encryptedPassword, Base64.NO_WRAP)
        val decryptedData = biometricKeyManager.decryptWithCipher(cipher, encryptedData)

        // Update last used timestamp
        dao.updateLastUsed(credentialId, System.currentTimeMillis())

        return String(decryptedData, Charsets.UTF_8)
    }

    /**
     * Get all credentials (metadata only, no decrypted passwords).
     */
    suspend fun getAllCredentials(): List<CredentialEntity> {
        return dao.getAll()
    }

    /**
     * Get credentials matching a domain.
     */
    suspend fun getCredentialsByDomain(domain: String): List<CredentialEntity> {
        // Try exact match first
        val exact = dao.getByDomain(domain)
        if (exact.isNotEmpty()) {
            return exact
        }

        // Try to extract base domain and search
        val baseDomain = extractBaseDomain(domain)
        return if (baseDomain != domain) {
            dao.searchByDomain(baseDomain)
        } else {
            dao.searchByDomain(domain)
        }
    }

    /**
     * Get a credential by ID.
     */
    suspend fun getCredentialById(id: String): CredentialEntity? {
        return dao.getById(id)
    }

    /**
     * Get credential IV for setting up decryption cipher.
     */
    suspend fun getCredentialIv(credentialId: String): ByteArray? {
        val credential = dao.getById(credentialId) ?: return null
        return Base64.decode(credential.iv, Base64.NO_WRAP)
    }

    /**
     * Delete a credential by ID.
     */
    suspend fun deleteCredential(id: String) {
        dao.deleteById(id)
    }

    /**
     * Delete a credential by vault and item ID.
     */
    suspend fun deleteCredentialByVaultAndItem(vaultId: String, itemId: String) {
        dao.deleteByVaultAndItem(vaultId, itemId)
    }

    /**
     * Delete all credentials.
     */
    suspend fun clearAll() {
        dao.deleteAll()
        biometricKeyManager.deleteKey()
    }

    /**
     * Get count of stored credentials.
     */
    suspend fun getCredentialCount(): Int {
        return dao.getCount()
    }

    /**
     * Get all item IDs currently stored (for sync comparison).
     */
    suspend fun getAllItemIds(): Set<String> {
        return dao.getAllItemIds().toSet()
    }

    /**
     * Extract base domain from a full domain.
     * e.g., "login.example.com" -> "example.com"
     */
    private fun extractBaseDomain(domain: String): String {
        val parts = domain.split(".")
        return if (parts.size > 2) {
            parts.takeLast(2).joinToString(".")
        } else {
            domain
        }
    }
}
