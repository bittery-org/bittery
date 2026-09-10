package com.bittery.mobile.credentialprovider.vault

import com.bittery.mobile.credentialprovider.crypto.NativeCrypto
import com.bittery.mobile.credentialprovider.crypto.VaultDecryptor
import com.bittery.mobile.credentialprovider.storage.ItemEntity
import com.bittery.mobile.credentialprovider.storage.VaultKeyEntity
import org.json.JSONObject

/**
 * The vault's cryptography, in `bittery-crypto-core`.
 *
 * Nothing here computes anything: every call lands in the Rust core through the
 * existing bindings, and this adapter only reshapes arguments and turns a
 * reported failure into an exception the vault can catch.
 */
internal class NativeVaultCrypto : VaultCrypto {

    override fun decryptVaultKey(vaultKey: ReplicaVaultKey, muk: ByteArray): ByteArray =
        VaultDecryptor.decryptVaultKeyWithMuk(vaultKey.toEntity(), muk)

    override fun decryptItemJson(item: ReplicaItem, vaultKey: ByteArray): JSONObject =
        VaultDecryptor.decryptItemJson(item.toEntity(), vaultKey)

    override fun decryptLogin(item: ReplicaItem, vaultKey: ByteArray): DecryptedLogin {
        val decrypted = VaultDecryptor.decryptLoginItem(item.toEntity(), vaultKey)
        return DecryptedLogin(username = decrypted.username, password = decrypted.password)
    }

    override fun encryptItemJson(
        json: JSONObject,
        vaultKey: ByteArray,
        vaultId: String,
        itemId: String,
        version: Long,
        serverUserId: String,
    ): EncryptedPayload {
        val encrypted = VaultDecryptor.encryptItemJson(
            updatedJson = json,
            vaultKey = vaultKey,
            vaultId = vaultId,
            itemId = itemId,
            version = version,
            userId = serverUserId,
        )
        return EncryptedPayload(
            ciphertext = encrypted.ciphertext,
            iv = encrypted.iv,
            algorithm = encrypted.algorithm,
        )
    }

    override fun generatePasskeyKeypair(): PasskeyKeypair {
        val json = JSONObject(valueOf(NativeCrypto.passkeyGenerateKeypair(), "keypair"))
        return PasskeyKeypair(
            privateKeyBase64 = json.getString("privateKey"),
            publicKeyCoseBase64 = json.getString("publicKeyCose"),
            publicKeySpkiBase64 = json.getString("publicKeySpki"),
        )
    }

    override fun generateCredentialId(): String =
        valueOf(NativeCrypto.passkeyGenerateCredentialId(), "credential ID")

    override fun buildPasskeyAttestation(
        rpId: String,
        credentialIdBase64: String,
        cosePublicKeyBase64: String,
        signCount: Int,
    ): PasskeyAttestation {
        val json = JSONObject(
            valueOf(
                NativeCrypto.passkeyBuildAttestationObject(
                    rpId = rpId,
                    credentialIdBase64 = credentialIdBase64,
                    cosePublicKeyBase64 = cosePublicKeyBase64,
                    signCount = signCount,
                ),
                "attestation object",
            ),
        )
        return PasskeyAttestation(
            authenticatorDataBase64 = json.getString("authenticatorData"),
            attestationObjectBase64 = json.getString("attestationObject"),
        )
    }

    override fun signPasskeyAssertion(
        privateKeyBase64: String,
        rpId: String,
        clientDataHashBase64: String,
        signCount: Int,
    ): PasskeySignature {
        val json = JSONObject(
            valueOf(
                NativeCrypto.passkeySignAssertion(
                    privateKeyBase64 = privateKeyBase64,
                    rpId = rpId,
                    clientDataHashBase64 = clientDataHashBase64,
                    signCount = signCount,
                ),
                "assertion signature",
            ),
        )
        return PasskeySignature(
            authenticatorDataBase64 = json.getString("authenticatorData"),
            signatureDerBase64 = json.getString("signatureDer"),
        )
    }

    /** The core reports failure in the result, not by throwing. Make it throw. */
    private fun valueOf(result: NativeCrypto.Result, what: String): String {
        val value = result.value
        if (!result.isSuccess || value == null) {
            throw IllegalStateException(result.error ?: "Failed to produce the $what")
        }
        return value
    }
}

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
