package com.bittery.mobile.credentialprovider.crypto

import android.util.Base64
import android.util.Log
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import uniffi.bittery_crypto_api.EncryptedData
import uniffi.bittery_crypto_api.EncryptionContext
import uniffi.bittery_crypto_api.KdfProfile
import uniffi.bittery_crypto_api.buildPasskeyAttestationObject as apiBuildPasskeyAttestationObject
import uniffi.bittery_crypto_api.decrypt as apiDecrypt
import uniffi.bittery_crypto_api.deriveKeys as apiDeriveKeys
import uniffi.bittery_crypto_api.destroyKey as apiDestroyKey
import uniffi.bittery_crypto_api.encrypt as apiEncrypt
import uniffi.bittery_crypto_api.exportKey as apiExportKey
import uniffi.bittery_crypto_api.generatePasskeyCredentialId as apiGeneratePasskeyCredentialId
import uniffi.bittery_crypto_api.generatePasskeyKeypair as apiGeneratePasskeyKeypair
import uniffi.bittery_crypto_api.importKey as apiImportKey
import uniffi.bittery_crypto_api.initialize as apiInitialize
import uniffi.bittery_crypto_api.rsaDecrypt as apiRsaDecrypt
import uniffi.bittery_crypto_api.rsaEncrypt as apiRsaEncrypt
import uniffi.bittery_crypto_api.signPasskeyAssertion as apiSignPasskeyAssertion

object NativeCrypto {
    private const val TAG = "NativeCrypto"

    val isAvailable: Boolean = try {
        runBlocking { apiInitialize() }
        true
    } catch (error: Throwable) {
        Log.e(TAG, "Failed to initialize native crypto", error)
        false
    }

    data class Result(val value: String?, val error: String?) {
        val isSuccess: Boolean get() = error == null
    }

    data class DerivedKeysResult(
        val authKey: String?,
        val masterUnlockKey: String?,
        val error: String?
    ) {
        val isSuccess: Boolean get() = error == null
    }

    data class EncryptResult(
        val ciphertext: String?,
        val iv: String?,
        val algorithm: String?,
        val error: String?
    ) {
        val isSuccess: Boolean get() = error == null
    }

    fun deriveKeys(
        password: String,
        secretKey: String,
        email: String,
        schemaVersion: Int,
        algorithm: String,
        iterations: Int
    ): DerivedKeysResult = captureDerivedKeys {
        val keys = apiDeriveKeys(
            password,
            secretKey,
            email,
            KdfProfile(schemaVersion.toUInt(), algorithm, iterations.toUInt())
        )
        try {
            DerivedKeysResult(
                encode(apiExportKey(keys.authKey)),
                encode(apiExportKey(keys.masterUnlockKey)),
                null
            )
        } finally {
            apiDestroyKey(keys.authKey)
            apiDestroyKey(keys.masterUnlockKey)
            keys.authKey.close()
            keys.masterUnlockKey.close()
        }
    }

    fun encrypt(plaintext: String, keyBase64: String): EncryptResult =
        encryptWithOptionalContext(plaintext, keyBase64, null)

    fun encryptWithContext(
        plaintext: String,
        keyBase64: String,
        vaultId: String,
        entityId: String,
        entityType: String,
        version: Long,
        userId: String
    ): EncryptResult = encryptWithOptionalContext(
        plaintext,
        keyBase64,
        EncryptionContext(vaultId, entityId, entityType, version.toULong(), userId)
    )

    fun decrypt(
        ciphertext: String,
        iv: String,
        algorithm: String,
        keyBase64: String
    ): Result = decryptWithOptionalContext(ciphertext, iv, algorithm, keyBase64, null)

    fun decryptWithContext(
        ciphertext: String,
        iv: String,
        algorithm: String,
        keyBase64: String,
        vaultId: String,
        entityId: String,
        entityType: String,
        version: Long,
        userId: String
    ): Result = decryptWithOptionalContext(
        ciphertext,
        iv,
        algorithm,
        keyBase64,
        EncryptionContext(vaultId, entityId, entityType, version.toULong(), userId)
    )

    fun rsaEncrypt(plaintext: String, publicKeyPem: String): Result =
        captureResult { apiRsaEncrypt(plaintext, publicKeyPem) }

    fun rsaDecrypt(ciphertext: String, privateKeyPem: String): Result =
        captureResult { apiRsaDecrypt(ciphertext, privateKeyPem) }

    fun passkeyGenerateKeypair(): Result = captureResult {
        val pair = apiGeneratePasskeyKeypair()
        JSONObject()
            .put("privateKey", pair.privateKey)
            .put("publicKeyCose", pair.publicKeyCose)
            .put("publicKeySpki", pair.publicKeySpki)
            .toString()
    }

    fun passkeyGenerateCredentialId(): Result =
        captureResult { apiGeneratePasskeyCredentialId() }

    fun passkeyBuildAttestationObject(
        rpId: String,
        credentialIdBase64: String,
        cosePublicKeyBase64: String,
        signCount: Int
    ): Result = captureResult {
        val attestation = apiBuildPasskeyAttestationObject(
            rpId,
            credentialIdBase64,
            cosePublicKeyBase64,
            signCount.toUInt()
        )
        JSONObject()
            .put("authenticatorData", encode(attestation.authenticatorData))
            .put("attestationObject", encode(attestation.attestationObject))
            .toString()
    }

    fun passkeySignAssertion(
        privateKeyBase64: String,
        rpId: String,
        clientDataHashBase64: String,
        signCount: Int
    ): Result = captureResult {
        val assertion = apiSignPasskeyAssertion(
            privateKeyBase64,
            rpId,
            clientDataHashBase64,
            signCount.toUInt()
        )
        JSONObject()
            .put("authenticatorData", encode(assertion.authenticatorData))
            .put("signatureDer", encode(assertion.signatureDer))
            .toString()
    }

    private fun encryptWithOptionalContext(
        plaintext: String,
        keyBase64: String,
        context: EncryptionContext?
    ): EncryptResult = captureEncrypt {
        withImportedKey(keyBase64) { key ->
            val encrypted = apiEncrypt(plaintext, key, context)
            EncryptResult(encrypted.ciphertext, encrypted.iv, encrypted.algorithm, null)
        }
    }

    private fun decryptWithOptionalContext(
        ciphertext: String,
        iv: String,
        algorithm: String,
        keyBase64: String,
        context: EncryptionContext?
    ): Result = captureResult {
        withImportedKey(keyBase64) { key ->
            apiDecrypt(EncryptedData(ciphertext, iv, algorithm), key, context)
        }
    }

    private suspend fun <T> withImportedKey(
        keyBase64: String,
        operation: suspend (uniffi.bittery_crypto_api.KeyHandle) -> T
    ): T {
        val key = apiImportKey(Base64.decode(keyBase64, Base64.NO_WRAP))
        try {
            return operation(key)
        } finally {
            apiDestroyKey(key)
            key.close()
        }
    }

    private fun captureResult(operation: suspend () -> String): Result = try {
        Result(runBlocking { operation() }, null)
    } catch (error: Throwable) {
        Result(null, error.message ?: error.toString())
    }

    private fun captureEncrypt(operation: suspend () -> EncryptResult): EncryptResult = try {
        runBlocking { operation() }
    } catch (error: Throwable) {
        EncryptResult(null, null, null, error.message ?: error.toString())
    }

    private fun captureDerivedKeys(
        operation: suspend () -> DerivedKeysResult
    ): DerivedKeysResult = try {
        runBlocking { operation() }
    } catch (error: Throwable) {
        DerivedKeysResult(null, null, error.message ?: error.toString())
    }

    private fun encode(bytes: ByteArray): String =
        Base64.encodeToString(bytes, Base64.NO_WRAP)
}
