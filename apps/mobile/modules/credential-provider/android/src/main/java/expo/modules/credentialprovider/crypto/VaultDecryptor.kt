package expo.modules.credentialprovider.crypto

import android.util.Base64
import expo.modules.credentialprovider.storage.ItemEntity
import expo.modules.credentialprovider.storage.VaultKeyEntity
import org.json.JSONObject

/**
 * High-level utility for decrypting vault items.
 *
 * Decryption flow:
 * 1. Decrypt vault key using MUK (for personal vaults) or RSA private key (for shared vaults)
 * 2. Use decrypted vault key to decrypt item's encrypted data
 * 3. Parse decrypted JSON to extract fields (password, etc.)
 */
object VaultDecryptor {

    /**
     * Decrypted login item data.
     */
    data class DecryptedLoginItem(
        val id: String,
        val title: String,
        val username: String?,
        val password: String?,
        val url: String?,
        val urls: List<String>,
        val notes: String?,
        val totp: String?,
        val customFields: Map<String, String>
    )

    /**
     * Decrypt a vault key using the Master Unlock Key.
     * Used for personal vaults where the key is encrypted with MUK.
     *
     * @param vaultKey The vault key entity from database
     * @param muk The Master Unlock Key (32 bytes)
     * @return Decrypted vault key bytes (32 bytes)
     * @throws IllegalArgumentException if encryption algorithm is unsupported
     */
    fun decryptVaultKeyWithMuk(vaultKey: VaultKeyEntity, muk: ByteArray): ByteArray {
        require(
            vaultKey.encryptionAlgorithm == "AES-GCM-AAD-V1" ||
            vaultKey.encryptionAlgorithm == "AES-GCM"
        ) {
            "Unsupported encryption algorithm: ${vaultKey.encryptionAlgorithm}"
        }

        val encryptedData = AesGcmCrypto.EncryptedData(
            ciphertext = vaultKey.encryptedKey,
            iv = vaultKey.encryptionIv,
            algorithm = vaultKey.encryptionAlgorithm
        )

        val decryptedBase64 = if (vaultKey.encryptionAlgorithm == "AES-GCM-AAD-V1") {
            // New format: vault key wrapped with AAD context
            AesGcmCrypto.decryptWithContext(
                encryptedData,
                muk,
                vaultId = vaultKey.vaultId,
                entityId = "vault-key-wrap",
                entityType = "vault_key",
                version = vaultKey.keyVersion.coerceAtLeast(1L),
                userId = vaultKey.userId
            )
        } else {
            // Legacy AES-GCM without AAD context
            AesGcmCrypto.decrypt(encryptedData, muk)
        }

        // The vault key is stored as Base64 when encrypted
        return Base64.decode(decryptedBase64, Base64.NO_WRAP)
    }

    /**
     * Decrypt a vault key using the RSA private key.
     * Used for shared/team vaults where the key is encrypted with user's public key.
     *
     * @param vaultKey The vault key entity from database
     * @param privateKeyPEM The decrypted RSA private key in PEM format
     * @return Decrypted vault key bytes (32 bytes)
     * @throws IllegalArgumentException if encryption algorithm is not RSA-OAEP
     */
    fun decryptVaultKeyWithRsa(vaultKey: VaultKeyEntity, privateKeyPEM: String): ByteArray {
        require(vaultKey.encryptionAlgorithm == "RSA-OAEP") {
            "Unsupported encryption algorithm: ${vaultKey.encryptionAlgorithm}"
        }

        // RSA-encrypted vault key is Base64-encoded ciphertext
        val decryptedBase64 = RsaCrypto.decrypt(vaultKey.encryptedKey, privateKeyPEM)
        return Base64.decode(decryptedBase64, Base64.NO_WRAP)
    }

    /**
     * Decrypt the user's RSA private key using the MUK.
     *
     * @param encryptedPrivateKey Base64-encoded encrypted private key
     * @param iv Base64-encoded IV
     * @param muk The Master Unlock Key (32 bytes)
     * @return Decrypted RSA private key in PEM format
     */
    fun decryptPrivateKey(
        encryptedPrivateKey: String,
        iv: String,
        muk: ByteArray
    ): String {
        val encryptedData = AesGcmCrypto.EncryptedData(
            ciphertext = encryptedPrivateKey,
            iv = iv,
            algorithm = "AES-GCM-AAD-V1"
        )

        return AesGcmCrypto.decrypt(encryptedData, muk)
    }

    /**
     * Decrypt an item's encrypted data using the vault key.
     *
     * Tries to decrypt with the correct AES-GCM-AAD-V1 context using the stored
     * version, falling back to lower version candidates (down to 1) to handle
     * items that were re-encrypted after version bumps.
     *
     * @param item The item entity from database
     * @param vaultKey Decrypted vault key bytes (32 bytes)
     * @return Decrypted JSON string containing item data
     */
    fun decryptItemData(item: ItemEntity, vaultKey: ByteArray): String {
        val encryptedData = AesGcmCrypto.EncryptedData(
            ciphertext = item.encryptedData,
            iv = item.encryptionIv,
            algorithm = item.encryptionAlgorithm
        )

        val storedVersion = item.version.coerceAtLeast(1L)
        val decryptUserId = item.lastModifiedBy?.takeIf { it.isNotBlank() } ?: item.userId
        var lastError: Exception? = null

        for (version in storedVersion downTo 1L) {
            try {
                return AesGcmCrypto.decryptWithContext(
                    encryptedData,
                    vaultKey,
                    vaultId = item.vaultId,
                    entityId = item.id,
                    entityType = "item",
                    version = version,
                    userId = decryptUserId
                )
            } catch (e: Exception) {
                lastError = e
            }
        }

        throw lastError ?: RuntimeException("Failed to decrypt item ${item.id}")
    }

    /**
     * Decrypt an item's encrypted data and parse to JSON.
     */
    fun decryptItemJson(item: ItemEntity, vaultKey: ByteArray): JSONObject {
        val decryptedJson = decryptItemData(item, vaultKey)
        return JSONObject(decryptedJson)
    }

    /**
     * Encrypt an updated item JSON object using the item's vault key.
     */
    fun encryptItemJson(
        updatedJson: JSONObject,
        vaultKey: ByteArray,
        vaultId: String,
        itemId: String,
        version: Long,
        userId: String
    ): AesGcmCrypto.EncryptedData {
        return AesGcmCrypto.encryptWithContext(
            plaintext = updatedJson.toString(),
            key = vaultKey,
            vaultId = vaultId,
            entityId = itemId,
            entityType = "item",
            version = version.coerceAtLeast(1L),
            userId = userId
        )
    }

    /**
     * Decrypt a login item and parse its fields.
     *
     * @param item The item entity from database
     * @param vaultKey Decrypted vault key bytes (32 bytes)
     * @return DecryptedLoginItem with parsed fields
     */
    fun decryptLoginItem(item: ItemEntity, vaultKey: ByteArray): DecryptedLoginItem {
        require(item.category == "login") {
            "Item is not a login: ${item.category}"
        }

        val decryptedJson = decryptItemData(item, vaultKey)
        val json = JSONObject(decryptedJson)

        // Parse URLs
        val urls = mutableListOf<String>()
        if (json.has("url") && !json.isNull("url")) {
            urls.add(json.getString("url"))
        }
        if (json.has("urls") && !json.isNull("urls")) {
            val urlsArray = json.getJSONArray("urls")
            for (i in 0 until urlsArray.length()) {
                val url = urlsArray.optString(i)
                if (url.isNotEmpty() && url !in urls) {
                    urls.add(url)
                }
            }
        }

        // Parse custom fields
        val customFields = mutableMapOf<String, String>()
        if (json.has("customFields") && !json.isNull("customFields")) {
            val fieldsArray = json.getJSONArray("customFields")
            for (i in 0 until fieldsArray.length()) {
                val field = fieldsArray.getJSONObject(i)
                val name = field.optString("name", "")
                val value = field.optString("value", "")
                if (name.isNotEmpty()) {
                    customFields[name] = value
                }
            }
        }

        return DecryptedLoginItem(
            id = item.id,
            title = item.displayTitle,
            username = json.optString("username")?.takeIf { it.isNotEmpty() },
            password = json.optString("password")?.takeIf { it.isNotEmpty() },
            url = urls.firstOrNull(),
            urls = urls,
            notes = json.optString("notes")?.takeIf { it.isNotEmpty() },
            totp = json.optString("totp")?.takeIf { it.isNotEmpty() },
            customFields = customFields
        )
    }

    /**
     * Extract just the password from an encrypted login item.
     * More efficient than decryptLoginItem when only password is needed.
     *
     * @param item The item entity from database
     * @param vaultKey Decrypted vault key bytes (32 bytes)
     * @return The password, or null if not found
     */
    fun extractPassword(item: ItemEntity, vaultKey: ByteArray): String? {
        val decryptedJson = decryptItemData(item, vaultKey)
        val json = JSONObject(decryptedJson)
        return json.optString("password")?.takeIf { it.isNotEmpty() }
    }
}
