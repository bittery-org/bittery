package com.bittery.mobile.credentialprovider.vault

import org.json.JSONObject

/**
 * The cryptography the vault asks for, and never performs.
 *
 * Every operation here lands in `bittery-crypto-core` through the existing
 * bindings. Nothing in this module implements AES, RSA or a KDF, and this port
 * exists so a test can drive the vault without the native library.
 *
 * A failure throws. The vault turns that into a result its callers can read.
 */
internal interface VaultCrypto {

    /** Unwrap a vault key with the master unlock key. */
    fun decryptVaultKey(vaultKey: ReplicaVaultKey, muk: ByteArray): ByteArray

    fun decryptItemJson(item: ReplicaItem, vaultKey: ByteArray): JSONObject

    fun decryptLogin(item: ReplicaItem, vaultKey: ByteArray): DecryptedLogin

    fun encryptItemJson(
        json: JSONObject,
        vaultKey: ByteArray,
        vaultId: String,
        itemId: String,
        version: Long,
        serverUserId: String,
    ): EncryptedPayload

    fun generatePasskeyKeypair(): PasskeyKeypair

    fun generateCredentialId(): String

    fun buildPasskeyAttestation(
        rpId: String,
        credentialIdBase64: String,
        cosePublicKeyBase64: String,
        signCount: Int,
    ): PasskeyAttestation

    fun signPasskeyAssertion(
        privateKeyBase64: String,
        rpId: String,
        clientDataHashBase64: String,
        signCount: Int,
    ): PasskeySignature
}

internal data class PasskeyKeypair(
    val privateKeyBase64: String,
    val publicKeyCoseBase64: String,
    val publicKeySpkiBase64: String,
)

internal data class PasskeyAttestation(
    val authenticatorDataBase64: String,
    val attestationObjectBase64: String,
)

internal data class PasskeySignature(
    val authenticatorDataBase64: String,
    val signatureDerBase64: String,
)
