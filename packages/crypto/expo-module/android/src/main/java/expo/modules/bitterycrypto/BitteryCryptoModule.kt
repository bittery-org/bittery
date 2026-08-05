package expo.modules.bitterycrypto

import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap

class BitteryCryptoModule : Module() {
    companion object {
        init {
            System.loadLibrary("bittery_crypto_ffi")
        }
    }

    private val scope = CoroutineScope(Dispatchers.Default)

    // Store SRP client/server handles
    private val srpClients = ConcurrentHashMap<Long, Long>()
    private val srpServers = ConcurrentHashMap<Long, Long>()
    private var nextClientId = 0L
    private var nextServerId = 0L

    override fun definition() = ModuleDefinition {
        Name("BitteryCrypto")

        // ============================================================================
        // Key Derivation
        // ============================================================================

        AsyncFunction("deriveKeys") { password: String, secretKey: String, email: String, schemaVersion: Int, algorithm: String, iterations: Int, promise: Promise ->
            scope.launch {
                try {
                    require(schemaVersion == 1 && algorithm == "pbkdf2-sha256" && iterations in 600_000..1_200_000) {
                        "Invalid KDF profile"
                    }
                    val result = nativeDeriveKeys(password, secretKey, email, schemaVersion, algorithm, iterations)
                    if (result.error != null) {
                        promise.reject(CodedException("KEY_DERIVATION_FAILED", result.error, null))
                    } else {
                        promise.resolve(mapOf(
                            "authKey" to result.authKey,
                            "masterUnlockKey" to result.masterUnlockKey
                        ))
                    }
                } catch (e: Exception) {
                    promise.reject(CodedException("KEY_DERIVATION_FAILED", e.message ?: "Unknown error", e))
                }
            }
        }

        AsyncFunction("deriveMasterKey") { accountPassword: String, secretKey: String, email: String, schemaVersion: Int, algorithm: String, iterations: Int, promise: Promise ->
            scope.launch {
                try {
                    require(schemaVersion == 1 && algorithm == "pbkdf2-sha256" && iterations in 600_000..1_200_000) {
                        "Invalid KDF profile"
                    }
                    val result = nativeDeriveMasterKey(accountPassword, secretKey, email, schemaVersion, algorithm, iterations)
                    if (result.startsWith("ERROR:")) {
                        promise.reject(CodedException("KEY_DERIVATION_FAILED", result.removePrefix("ERROR:"), null))
                    } else {
                        promise.resolve(result)
                    }
                } catch (e: Exception) {
                    promise.reject(CodedException("KEY_DERIVATION_FAILED", e.message ?: "Unknown error", e))
                }
            }
        }

        AsyncFunction("deriveKeysFromMasterKey") { masterKeyBase64: String, email: String, promise: Promise ->
            scope.launch {
                try {
                    val result = nativeDeriveKeysFromMasterKey(masterKeyBase64, email)
                    if (result.error != null) {
                        promise.reject(CodedException("KEY_DERIVATION_FAILED", result.error, null))
                    } else {
                        promise.resolve(mapOf(
                            "authKey" to result.authKey,
                            "masterUnlockKey" to result.masterUnlockKey
                        ))
                    }
                } catch (e: Exception) {
                    promise.reject(CodedException("KEY_DERIVATION_FAILED", e.message ?: "Unknown error", e))
                }
            }
        }

        // ============================================================================
        // AES-256-GCM Encryption
        // ============================================================================

        AsyncFunction("encrypt") { plaintext: String, keyBase64: String, promise: Promise ->
            scope.launch {
                try {
                    val result = nativeEncrypt(plaintext, keyBase64)
                    if (result.error != null) {
                        promise.reject(CodedException("ENCRYPTION_FAILED", result.error, null))
                    } else {
                        promise.resolve(mapOf(
                            "ciphertext" to result.ciphertext,
                            "iv" to result.iv,
                            "algorithm" to result.algorithm
                        ))
                    }
                } catch (e: Exception) {
                    promise.reject(CodedException("ENCRYPTION_FAILED", e.message ?: "Unknown error", e))
                }
            }
        }

        AsyncFunction("decrypt") { ciphertext: String, iv: String, algorithm: String, keyBase64: String, promise: Promise ->
            scope.launch {
                try {
                    val result = nativeDecrypt(ciphertext, iv, algorithm, keyBase64)
                    if (result.startsWith("ERROR:")) {
                        promise.reject(CodedException("DECRYPTION_FAILED", result.removePrefix("ERROR:"), null))
                    } else {
                        promise.resolve(result)
                    }
                } catch (e: Exception) {
                    promise.reject(CodedException("DECRYPTION_FAILED", e.message ?: "Unknown error", e))
                }
            }
        }

        AsyncFunction("encryptWithContext") { plaintext: String, keyBase64: String, vaultId: String, entityId: String, entityType: String, version: Long, userId: String, promise: Promise ->
            scope.launch {
                try {
                    val result = nativeEncryptWithContext(plaintext, keyBase64, vaultId, entityId, entityType, version, userId)
                    if (result.error != null) {
                        promise.reject(CodedException("ENCRYPTION_FAILED", result.error, null))
                    } else {
                        promise.resolve(mapOf(
                            "ciphertext" to result.ciphertext,
                            "iv" to result.iv,
                            "algorithm" to result.algorithm
                        ))
                    }
                } catch (e: Exception) {
                    promise.reject(CodedException("ENCRYPTION_FAILED", e.message ?: "Unknown error", e))
                }
            }
        }

        // encryptedData is { ciphertext, iv, algorithm } — bundled to stay within the
        // Expo SDK AsyncFunction 8-param+Promise (Function9) arity limit.
        AsyncFunction("decryptWithContext") { encryptedData: Map<String, Any>, keyBase64: String, vaultId: String, entityId: String, entityType: String, version: Long, userId: String, promise: Promise ->
            scope.launch {
                try {
                    val ciphertext = encryptedData["ciphertext"] as? String ?: ""
                    val iv = encryptedData["iv"] as? String ?: ""
                    val algorithm = encryptedData["algorithm"] as? String ?: "AES-GCM-AAD-V1"
                    val result = nativeDecryptWithContext(ciphertext, iv, algorithm, keyBase64, vaultId, entityId, entityType, version, userId)
                    if (result.startsWith("ERROR:")) {
                        promise.reject(CodedException("DECRYPTION_FAILED", result.removePrefix("ERROR:"), null))
                    } else {
                        promise.resolve(result)
                    }
                } catch (e: Exception) {
                    promise.reject(CodedException("DECRYPTION_FAILED", e.message ?: "Unknown error", e))
                }
            }
        }

        Function("generateEncryptionKey") {
            nativeGenerateEncryptionKey()
        }

        Function("generateUuid") {
            nativeGenerateUuid()
        }

        // ============================================================================
        // RSA-4096
        // ============================================================================

        AsyncFunction("generateRsaKeyPair") { promise: Promise ->
            scope.launch {
                try {
                    val result = nativeGenerateRsaKeyPair()
                    if (result.error != null) {
                        promise.reject(CodedException("RSA_GENERATION_FAILED", result.error, null))
                    } else {
                        promise.resolve(mapOf(
                            "publicKey" to result.publicKey,
                            "privateKey" to result.privateKey
                        ))
                    }
                } catch (e: Exception) {
                    promise.reject(CodedException("RSA_GENERATION_FAILED", e.message ?: "Unknown error", e))
                }
            }
        }

        AsyncFunction("rsaEncrypt") { plaintext: String, publicKeyPem: String, promise: Promise ->
            scope.launch {
                try {
                    val result = nativeRsaEncrypt(plaintext, publicKeyPem)
                    if (result.startsWith("ERROR:")) {
                        promise.reject(CodedException("RSA_ENCRYPTION_FAILED", result.removePrefix("ERROR:"), null))
                    } else {
                        promise.resolve(result)
                    }
                } catch (e: Exception) {
                    promise.reject(CodedException("RSA_ENCRYPTION_FAILED", e.message ?: "Unknown error", e))
                }
            }
        }

        AsyncFunction("rsaDecrypt") { ciphertext: String, privateKeyPem: String, promise: Promise ->
            scope.launch {
                try {
                    val result = nativeRsaDecrypt(ciphertext, privateKeyPem)
                    if (result.startsWith("ERROR:")) {
                        promise.reject(CodedException("RSA_DECRYPTION_FAILED", result.removePrefix("ERROR:"), null))
                    } else {
                        promise.resolve(result)
                    }
                } catch (e: Exception) {
                    promise.reject(CodedException("RSA_DECRYPTION_FAILED", e.message ?: "Unknown error", e))
                }
            }
        }

        // ============================================================================
        // Secret Key
        // ============================================================================

        Function("generateSecretKey") {
            nativeGenerateSecretKey()
        }

        Function("validateSecretKey") { secretKey: String ->
            nativeValidateSecretKey(secretKey)
        }

        Function("getSecretKeyHint") { secretKey: String ->
            nativeGetSecretKeyHint(secretKey)
        }

        Function("generateRecoveryKey") {
            nativeGenerateRecoveryKey()
        }

        Function("validateRecoveryKey") { recoveryKey: String ->
            nativeValidateRecoveryKey(recoveryKey)
        }

        AsyncFunction("encryptMasterKey") { masterKeyBase64: String, recoveryKey: String, email: String, promise: Promise ->
            scope.launch {
                try {
                    val result = nativeEncryptMasterKey(masterKeyBase64, recoveryKey, email)
                    if (result.error != null) {
                        promise.reject(CodedException("ENCRYPTION_FAILED", result.error, null))
                    } else {
                        promise.resolve(mapOf(
                            "ciphertext" to result.ciphertext,
                            "iv" to result.iv,
                            "algorithm" to result.algorithm
                        ))
                    }
                } catch (e: Exception) {
                    promise.reject(CodedException("ENCRYPTION_FAILED", e.message ?: "Unknown error", e))
                }
            }
        }

        AsyncFunction("decryptMasterKey") { ciphertext: String, iv: String, algorithm: String, recoveryKey: String, email: String, promise: Promise ->
            scope.launch {
                try {
                    val result = nativeDecryptMasterKey(ciphertext, iv, algorithm, recoveryKey, email)
                    if (result.startsWith("ERROR:")) {
                        promise.reject(CodedException("DECRYPTION_FAILED", result.removePrefix("ERROR:"), null))
                    } else {
                        promise.resolve(result)
                    }
                } catch (e: Exception) {
                    promise.reject(CodedException("DECRYPTION_FAILED", e.message ?: "Unknown error", e))
                }
            }
        }

        // ============================================================================
        // TOTP (Time-Based One-Time Password)
        // ============================================================================

        Function("generateTotp") { secret: String, algorithm: String, digits: Int, period: Long ->
            val result = nativeGenerateTotp(secret, algorithm, digits, period)
            if (result.error != null) {
                throw CodedException("TOTP_FAILED", result.error, null)
            }
            mapOf(
                "code" to result.code,
                "remainingSeconds" to result.remainingSeconds,
                "period" to result.period,
                "progress" to result.progress
            )
        }

        // ============================================================================
        // SRP-6a Client
        // ============================================================================

        Function("srpClientNew") { hashAlgorithm: String, primeGroup: Int ->
            val handle = nativeSrpClientNew(hashAlgorithm, primeGroup)
            if (handle == 0L) {
                throw CodedException("SRP_CLIENT_CREATION_FAILED", "Failed to create SRP client", null)
            }
            val clientId = nextClientId++
            srpClients[clientId] = handle
            clientId
        }

        Function("srpClientFree") { clientId: Long ->
            srpClients.remove(clientId)?.let { handle ->
                nativeSrpClientFree(handle)
            }
        }

        Function("srpClientGenerateSalt") { clientId: Long ->
            val handle = srpClients[clientId]
                ?: throw CodedException("INVALID_CLIENT", "Invalid SRP client ID", null)
            nativeSrpClientGenerateSalt(handle)
        }

        AsyncFunction("srpClientDeriveSafePrivateKey") { clientId: Long, salt: String, password: String, iterations: Int, promise: Promise ->
            val handle = srpClients[clientId]
            if (handle == null) {
                promise.reject(CodedException("INVALID_CLIENT", "Invalid SRP client ID", null))
                return@AsyncFunction
            }
            scope.launch {
                try {
                    val result = nativeSrpClientDeriveSafePrivateKey(handle, salt, password, iterations)
                    if (result == null) {
                        promise.reject(CodedException("SRP_KEY_DERIVATION_FAILED", "Failed to derive private key", null))
                    } else {
                        promise.resolve(result)
                    }
                } catch (e: Exception) {
                    promise.reject(CodedException("SRP_KEY_DERIVATION_FAILED", e.message ?: "Unknown error", e))
                }
            }
        }

        Function("srpClientDeriveVerifier") { clientId: Long, privateKey: String ->
            val handle = srpClients[clientId]
                ?: throw CodedException("INVALID_CLIENT", "Invalid SRP client ID", null)
            val verifier = nativeSrpClientDeriveVerifier(handle, privateKey)
                ?: throw CodedException("SRP_KEY_DERIVATION_FAILED", "Failed to derive verifier", null)
            if (verifier.isBlank()) {
                throw CodedException("SRP_KEY_DERIVATION_FAILED", "Failed to derive verifier", null)
            }
            verifier
        }

        Function("srpClientGenerateEphemeral") { clientId: Long ->
            val handle = srpClients[clientId]
                ?: throw CodedException("INVALID_CLIENT", "Invalid SRP client ID", null)
            val result = nativeSrpClientGenerateEphemeral(handle)
            mapOf(
                "public" to result.publicValue,
                "secret" to result.secret
            )
        }

        AsyncFunction("srpClientDeriveSession") { clientId: Long, clientSecretEphemeral: String, serverPublicEphemeral: String, salt: String, username: String, privateKey: String, promise: Promise ->
            val handle = srpClients[clientId]
            if (handle == null) {
                promise.reject(CodedException("INVALID_CLIENT", "Invalid SRP client ID", null))
                return@AsyncFunction
            }
            scope.launch {
                try {
                    val result = nativeSrpClientDeriveSession(
                        handle,
                        clientSecretEphemeral,
                        serverPublicEphemeral,
                        salt,
                        username,
                        privateKey
                    )
                    if (result.error != null) {
                        promise.reject(CodedException("SRP_SESSION_FAILED", result.error, null))
                    } else {
                        promise.resolve(mapOf(
                            "key" to result.key,
                            "proof" to result.proof
                        ))
                    }
                } catch (e: Exception) {
                    promise.reject(CodedException("SRP_SESSION_FAILED", e.message ?: "Unknown error", e))
                }
            }
        }

        AsyncFunction("srpClientVerifySession") { clientId: Long, clientPublicEphemeral: String, sessionKey: String, sessionProof: String, serverSessionProof: String, promise: Promise ->
            val handle = srpClients[clientId]
            if (handle == null) {
                promise.reject(CodedException("INVALID_CLIENT", "Invalid SRP client ID", null))
                return@AsyncFunction
            }
            scope.launch {
                try {
                    val result = nativeSrpClientVerifySession(
                        handle,
                        clientPublicEphemeral,
                        sessionKey,
                        sessionProof,
                        serverSessionProof
                    )
                    if (result.startsWith("ERROR:")) {
                        promise.reject(CodedException("SRP_VERIFY_FAILED", result.removePrefix("ERROR:"), null))
                    } else {
                        promise.resolve(true)
                    }
                } catch (e: Exception) {
                    promise.reject(CodedException("SRP_VERIFY_FAILED", e.message ?: "Unknown error", e))
                }
            }
        }

        // ============================================================================
        // SRP-6a Server
        // ============================================================================

        Function("srpServerNew") { hashAlgorithm: String, primeGroup: Int ->
            val handle = nativeSrpServerNew(hashAlgorithm, primeGroup)
            if (handle == 0L) {
                throw CodedException("SRP_SERVER_CREATION_FAILED", "Failed to create SRP server", null)
            }
            val serverId = nextServerId++
            srpServers[serverId] = handle
            serverId
        }

        Function("srpServerFree") { serverId: Long ->
            srpServers.remove(serverId)?.let { handle ->
                nativeSrpServerFree(handle)
            }
        }

        AsyncFunction("srpServerGenerateEphemeral") { serverId: Long, verifier: String, promise: Promise ->
            val handle = srpServers[serverId]
            if (handle == null) {
                promise.reject(CodedException("INVALID_SERVER", "Invalid SRP server ID", null))
                return@AsyncFunction
            }
            scope.launch {
                try {
                    val result = nativeSrpServerGenerateEphemeral(handle, verifier)
                    if (result.publicValue.isBlank() || result.secret.isBlank()) {
                        promise.reject(CodedException("SRP_EPHEMERAL_FAILED", "Failed to generate ephemeral", null))
                        return@launch
                    }
                    promise.resolve(mapOf(
                        "public" to result.publicValue,
                        "secret" to result.secret
                    ))
                } catch (e: Exception) {
                    promise.reject(CodedException("SRP_EPHEMERAL_FAILED", e.message ?: "Unknown error", e))
                }
            }
        }

        AsyncFunction("srpServerDeriveSession") { serverId: Long, serverSecretEphemeral: String, clientPublicEphemeral: String, salt: String, username: String, verifier: String, clientSessionProof: String, promise: Promise ->
            val handle = srpServers[serverId]
            if (handle == null) {
                promise.reject(CodedException("INVALID_SERVER", "Invalid SRP server ID", null))
                return@AsyncFunction
            }
            scope.launch {
                try {
                    val result = nativeSrpServerDeriveSession(
                        handle,
                        serverSecretEphemeral,
                        clientPublicEphemeral,
                        salt,
                        username,
                        verifier,
                        clientSessionProof
                    )
                    if (result.error != null) {
                        promise.reject(CodedException("SRP_SESSION_FAILED", result.error, null))
                    } else {
                        promise.resolve(mapOf(
                            "key" to result.key,
                            "proof" to result.proof
                        ))
                    }
                } catch (e: Exception) {
                    promise.reject(CodedException("SRP_SESSION_FAILED", e.message ?: "Unknown error", e))
                }
            }
        }

        // ============================================================================
        // Passkey / WebAuthn
        // ============================================================================

        AsyncFunction("generatePasskeyKeypair") { promise: Promise ->
            scope.launch {
                try {
                    val result = nativePasskeyGenerateKeypair()
                    if (result.error != null) {
                        promise.reject(CodedException("PASSKEY_GENERATION_FAILED", result.error, null))
                    } else {
                        promise.resolve(mapOf(
                            "privateKey" to result.privateKey,
                            "publicKeyCose" to result.publicKeyCose
                        ))
                    }
                } catch (e: Exception) {
                    promise.reject(CodedException("PASSKEY_GENERATION_FAILED", e.message ?: "Unknown error", e))
                }
            }
        }

        Function("generatePasskeyCredentialId") {
            nativePasskeyGenerateCredentialId()
        }

        AsyncFunction("buildPasskeyAttestationObject") { rpId: String, credentialIdBase64: String, cosePublicKeyBase64: String, signCount: Int, promise: Promise ->
            scope.launch {
                try {
                    val result = nativePasskeyBuildAttestationObject(rpId, credentialIdBase64, cosePublicKeyBase64, signCount)
                    if (result.error != null) {
                        promise.reject(CodedException("PASSKEY_ATTESTATION_FAILED", result.error, null))
                    } else {
                        promise.resolve(mapOf(
                            "authenticatorData" to result.authenticatorData,
                            "attestationObject" to result.attestationObject
                        ))
                    }
                } catch (e: Exception) {
                    promise.reject(CodedException("PASSKEY_ATTESTATION_FAILED", e.message ?: "Unknown error", e))
                }
            }
        }

        AsyncFunction("signPasskeyAssertion") { privateKeyBase64: String, rpId: String, clientDataHashBase64: String, signCount: Int, promise: Promise ->
            scope.launch {
                try {
                    val result = nativePasskeySignAssertion(privateKeyBase64, rpId, clientDataHashBase64, signCount)
                    if (result.error != null) {
                        promise.reject(CodedException("PASSKEY_ASSERTION_FAILED", result.error, null))
                    } else {
                        promise.resolve(mapOf(
                            "authenticatorData" to result.authenticatorData,
                            "signatureDer" to result.signatureDer
                        ))
                    }
                } catch (e: Exception) {
                    promise.reject(CodedException("PASSKEY_ASSERTION_FAILED", e.message ?: "Unknown error", e))
                }
            }
        }

        // ============================================================================
        // Key Rotation
        // ============================================================================

        AsyncFunction("encryptVaultKeyForMember") { vaultKeyBase64: String, memberPublicKeyPem: String, promise: Promise ->
            scope.launch {
                try {
                    val result = nativeEncryptVaultKeyForMember(vaultKeyBase64, memberPublicKeyPem)
                    if (result.startsWith("ERROR:")) {
                        promise.reject(CodedException("ENCRYPTION_FAILED", result.removePrefix("ERROR:"), null))
                    } else {
                        promise.resolve(result)
                    }
                } catch (e: Exception) {
                    promise.reject(CodedException("ENCRYPTION_FAILED", e.message ?: "Unknown error", e))
                }
            }
        }

        AsyncFunction("encryptVaultKeyWithMuk") { vaultKeyBase64: String, masterUnlockKeyBase64: String, vaultId: String, userId: String, keyVersion: Long, promise: Promise ->
            scope.launch {
                try {
                    val result = nativeEncryptVaultKeyWithMuk(vaultKeyBase64, masterUnlockKeyBase64, vaultId, userId, keyVersion)
                    if (result.startsWith("ERROR:")) {
                        promise.reject(CodedException("ENCRYPTION_FAILED", result.removePrefix("ERROR:"), null))
                    } else {
                        promise.resolve(result)
                    }
                } catch (e: Exception) {
                    promise.reject(CodedException("ENCRYPTION_FAILED", e.message ?: "Unknown error", e))
                }
            }
        }

        AsyncFunction("reEncryptItem") { itemId: String, encryptedData: String, encryptionIv: String, encryptionAlgorithm: String, oldVaultKeyBase64: String, newVaultKeyBase64: String, promise: Promise ->
            scope.launch {
                try {
                    val result = nativeReEncryptItem(itemId, encryptedData, encryptionIv, encryptionAlgorithm, oldVaultKeyBase64, newVaultKeyBase64)
                    if (result.error != null) {
                        promise.reject(CodedException("ENCRYPTION_FAILED", result.error, null))
                    } else {
                        promise.resolve(mapOf(
                            "itemId" to result.itemId,
                            "encryptedData" to result.encryptedData,
                            "encryptionIv" to result.encryptionIv
                        ))
                    }
                } catch (e: Exception) {
                    promise.reject(CodedException("ENCRYPTION_FAILED", e.message ?: "Unknown error", e))
                }
            }
        }

        AsyncFunction("performKeyRotation") { oldVaultKeyBase64: String, membersJson: String, itemsJson: String, vaultId: String, keyVersion: Long, currentUserId: String, masterUnlockKeyBase64: String, promise: Promise ->
            scope.launch {
                try {
                    val result = nativePerformKeyRotation(oldVaultKeyBase64, membersJson, itemsJson, vaultId, keyVersion, currentUserId, masterUnlockKeyBase64)
                    if (result.error != null) {
                        promise.reject(CodedException("ENCRYPTION_FAILED", result.error, null))
                    } else {
                        promise.resolve(mapOf(
                            "memberEncryptedKeysJson" to result.memberEncryptedKeysJson,
                            "reEncryptedItemsJson" to result.reEncryptedItemsJson
                        ))
                    }
                } catch (e: Exception) {
                    promise.reject(CodedException("ENCRYPTION_FAILED", e.message ?: "Unknown error", e))
                }
            }
        }

        AsyncFunction("validateRotationData") { membersJson: String, promise: Promise ->
            scope.launch {
                try {
                    val result = nativeValidateRotationData(membersJson)
                    promise.resolve(mapOf(
                        "valid" to result.valid,
                        "errorsJson" to result.errorsJson
                    ))
                } catch (e: Exception) {
                    promise.reject(CodedException("ENCRYPTION_FAILED", e.message ?: "Unknown error", e))
                }
            }
        }
    }

    // ============================================================================
    // Native JNI Methods
    // ============================================================================

    // Key Derivation
    private external fun nativeDeriveKeys(password: String, secretKey: String, email: String, schemaVersion: Int, algorithm: String, iterations: Int): DerivedKeysResult
    private external fun nativeDeriveMasterKey(accountPassword: String, secretKey: String, email: String, schemaVersion: Int, algorithm: String, iterations: Int): String
    private external fun nativeDeriveKeysFromMasterKey(masterKeyBase64: String, email: String): DerivedKeysResult

    // Encryption
    private external fun nativeEncrypt(plaintext: String, keyBase64: String): EncryptResult
    private external fun nativeDecrypt(ciphertext: String, iv: String, algorithm: String, keyBase64: String): String
    private external fun nativeEncryptWithContext(plaintext: String, keyBase64: String, vaultId: String, entityId: String, entityType: String, version: Long, userId: String): EncryptResult
    private external fun nativeDecryptWithContext(ciphertext: String, iv: String, algorithm: String, keyBase64: String, vaultId: String, entityId: String, entityType: String, version: Long, userId: String): String
    private external fun nativeGenerateEncryptionKey(): String
    private external fun nativeGenerateUuid(): String

    // RSA
    private external fun nativeGenerateRsaKeyPair(): RsaKeyPairResult
    private external fun nativeRsaEncrypt(plaintext: String, publicKeyPem: String): String
    private external fun nativeRsaDecrypt(ciphertext: String, privateKeyPem: String): String

    // Secret Key
    private external fun nativeGenerateSecretKey(): String
    private external fun nativeValidateSecretKey(secretKey: String): Boolean
    private external fun nativeGetSecretKeyHint(secretKey: String): String
    private external fun nativeGenerateRecoveryKey(): String
    private external fun nativeValidateRecoveryKey(recoveryKey: String): Boolean
    private external fun nativeEncryptMasterKey(masterKeyBase64: String, recoveryKey: String, email: String): EncryptResult
    private external fun nativeDecryptMasterKey(ciphertext: String, iv: String, algorithm: String, recoveryKey: String, email: String): String

    // SRP Client
    private external fun nativeSrpClientNew(hashAlgorithm: String, primeGroup: Int): Long
    private external fun nativeSrpClientFree(handle: Long)
    private external fun nativeSrpClientGenerateSalt(handle: Long): String
    private external fun nativeSrpClientDeriveSafePrivateKey(handle: Long, salt: String, password: String, iterations: Int): String?
    private external fun nativeSrpClientDeriveVerifier(handle: Long, privateKey: String): String?
    private external fun nativeSrpClientGenerateEphemeral(handle: Long): EphemeralResult
    private external fun nativeSrpClientDeriveSession(
        handle: Long,
        clientSecretEphemeral: String,
        serverPublicEphemeral: String,
        salt: String,
        username: String,
        privateKey: String
    ): SessionResult
    private external fun nativeSrpClientVerifySession(
        handle: Long,
        clientPublicEphemeral: String,
        sessionKey: String,
        sessionProof: String,
        serverSessionProof: String
    ): String

    // SRP Server
    private external fun nativeSrpServerNew(hashAlgorithm: String, primeGroup: Int): Long
    private external fun nativeSrpServerFree(handle: Long)
    private external fun nativeSrpServerGenerateEphemeral(handle: Long, verifier: String): EphemeralResult
    private external fun nativeSrpServerDeriveSession(
        handle: Long,
        serverSecretEphemeral: String,
        clientPublicEphemeral: String,
        salt: String,
        username: String,
        verifier: String,
        clientSessionProof: String
    ): SessionResult

    // Passkey / WebAuthn
    private external fun nativePasskeyGenerateKeypair(): PasskeyKeypairResult
    private external fun nativePasskeyGenerateCredentialId(): String
    private external fun nativePasskeyBuildAttestationObject(rpId: String, credentialIdBase64: String, cosePublicKeyBase64: String, signCount: Int): PasskeyAttestationResult
    private external fun nativePasskeySignAssertion(privateKeyBase64: String, rpId: String, clientDataHashBase64: String, signCount: Int): PasskeyAssertionResult

    // Key Rotation
    private external fun nativeEncryptVaultKeyForMember(vaultKeyBase64: String, memberPublicKeyPem: String): String
    private external fun nativeEncryptVaultKeyWithMuk(vaultKeyBase64: String, masterUnlockKeyBase64: String, vaultId: String, userId: String, keyVersion: Long): String
    private external fun nativeReEncryptItem(itemId: String, encryptedData: String, encryptionIv: String, encryptionAlgorithm: String, oldVaultKeyBase64: String, newVaultKeyBase64: String): ReEncryptedItemResult
    private external fun nativePerformKeyRotation(oldVaultKeyBase64: String, membersJson: String, itemsJson: String, vaultId: String, keyVersion: Long, currentUserId: String, masterUnlockKeyBase64: String): KeyRotationResult
    private external fun nativeValidateRotationData(membersJson: String): ValidationResult

    // Result classes for JNI
    data class DerivedKeysResult(
        val authKey: String?,
        val masterUnlockKey: String?,
        val error: String?
    )

    data class EncryptResult(
        val ciphertext: String?,
        val iv: String?,
        val algorithm: String?,
        val error: String?
    )

    data class RsaKeyPairResult(
        val publicKey: String?,
        val privateKey: String?,
        val error: String?
    )

    data class EphemeralResult(
        val publicValue: String,
        val secret: String
    )

    data class SessionResult(
        val key: String?,
        val proof: String?,
        val error: String?
    )

    // `publicKeySpki` is intentionally absent: matches `bittery_passkey_generate_keypair`'s
    // C ABI shape, which has no consumer for it either.
    data class PasskeyKeypairResult(
        val privateKey: String?,
        val publicKeyCose: String?,
        val error: String?
    )

    data class PasskeyAttestationResult(
        val authenticatorData: String?,
        val attestationObject: String?,
        val error: String?
    )

    data class PasskeyAssertionResult(
        val authenticatorData: String?,
        val signatureDer: String?,
        val error: String?
    )

    data class ReEncryptedItemResult(
        val itemId: String?,
        val encryptedData: String?,
        val encryptionIv: String?,
        val error: String?
    )

    data class KeyRotationResult(
        val memberEncryptedKeysJson: String?,
        val reEncryptedItemsJson: String?,
        val error: String?
    )

    // Unlike every other result class in this file, `ValidationResultFFI` has no
    // `error` field: malformed input is reported as `valid = false`, not a throw.
    data class ValidationResult(
        val valid: Boolean,
        val errorsJson: String
    )

    data class TotpResult(
        val code: String?,
        val remainingSeconds: Long,
        val period: Long,
        val progress: Double,
        val error: String?
    )

    private external fun nativeGenerateTotp(
        secret: String,
        algorithm: String,
        digits: Int,
        period: Long
    ): TotpResult
}
