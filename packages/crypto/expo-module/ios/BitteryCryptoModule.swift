import ExpoModulesCore
import BitteryCryptoFFI

public class BitteryCryptoModule: Module {
    // SRP client handles stored by ID
    private var srpClients: [Int64: OpaquePointer] = [:]
    private var srpServers: [Int64: OpaquePointer] = [:]
    private var nextClientId: Int64 = 0
    private var nextServerId: Int64 = 0
    private let lock = NSLock()

    public func definition() -> ModuleDefinition {
        Name("BitteryCrypto")

        // ============================================================================
        // Key Derivation
        // ============================================================================

        AsyncFunction("deriveKeys") { (password: String, secretKey: String, email: String, schemaVersion: Int, algorithm: String, iterations: Int, promise: Promise) in
            DispatchQueue.global(qos: .userInitiated).async {
                guard schemaVersion == 1,
                      algorithm == "pbkdf2-sha256",
                      (600_000...1_200_000).contains(iterations),
                      let schema = UInt32(exactly: schemaVersion),
                      let count = UInt32(exactly: iterations) else {
                    promise.reject("KEY_DERIVATION_FAILED", "Invalid KDF profile")
                    return
                }
                let result = bittery_derive_keys(password, secretKey, email, schema, algorithm, count)

                if let error = result.error {
                    let errorStr = String(cString: error)
                    bittery_free_string(result.auth_key)
                    bittery_free_string(result.master_unlock_key)
                    bittery_free_string(result.error)
                    promise.reject("KEY_DERIVATION_FAILED", errorStr)
                    return
                }

                guard let authKey = result.auth_key, let muk = result.master_unlock_key else {
                    bittery_free_string(result.auth_key)
                    bittery_free_string(result.master_unlock_key)
                    promise.reject("KEY_DERIVATION_FAILED", "No keys returned")
                    return
                }

                let authKeyStr = String(cString: authKey)
                let mukStr = String(cString: muk)

                bittery_free_string(result.auth_key)
                bittery_free_string(result.master_unlock_key)

                promise.resolve([
                    "authKey": authKeyStr,
                    "masterUnlockKey": mukStr
                ])
            }
        }

        AsyncFunction("deriveMasterKey") { (accountPassword: String, secretKey: String, email: String, schemaVersion: Int, algorithm: String, iterations: Int, promise: Promise) in
            DispatchQueue.global(qos: .userInitiated).async {
                guard schemaVersion == 1,
                      algorithm == "pbkdf2-sha256",
                      (600_000...1_200_000).contains(iterations),
                      let schema = UInt32(exactly: schemaVersion),
                      let count = UInt32(exactly: iterations) else {
                    promise.reject("KEY_DERIVATION_FAILED", "Invalid KDF profile")
                    return
                }
                guard let result = bittery_derive_master_key(accountPassword, secretKey, email, schema, algorithm, count) else {
                    promise.reject("KEY_DERIVATION_FAILED", "Derivation returned null")
                    return
                }

                let resultStr = String(cString: result)
                bittery_free_string(result)

                if resultStr.hasPrefix("ERROR:") {
                    let errorMsg = String(resultStr.dropFirst(6))
                    promise.reject("KEY_DERIVATION_FAILED", errorMsg)
                } else {
                    promise.resolve(resultStr)
                }
            }
        }

        AsyncFunction("deriveKeysFromMasterKey") { (masterKeyBase64: String, email: String, promise: Promise) in
            DispatchQueue.global(qos: .userInitiated).async {
                let result = bittery_derive_keys_from_master_key(masterKeyBase64, email)

                if let error = result.error {
                    let errorStr = String(cString: error)
                    bittery_free_string(result.auth_key)
                    bittery_free_string(result.master_unlock_key)
                    bittery_free_string(result.error)
                    promise.reject("KEY_DERIVATION_FAILED", errorStr)
                    return
                }

                guard let authKey = result.auth_key, let muk = result.master_unlock_key else {
                    bittery_free_string(result.auth_key)
                    bittery_free_string(result.master_unlock_key)
                    promise.reject("KEY_DERIVATION_FAILED", "No keys returned")
                    return
                }

                let authKeyStr = String(cString: authKey)
                let mukStr = String(cString: muk)

                bittery_free_string(result.auth_key)
                bittery_free_string(result.master_unlock_key)

                promise.resolve([
                    "authKey": authKeyStr,
                    "masterUnlockKey": mukStr
                ])
            }
        }

        // ============================================================================
        // AES-256-GCM Encryption
        // ============================================================================

        AsyncFunction("encrypt") { (plaintext: String, keyBase64: String, promise: Promise) in
            DispatchQueue.global(qos: .userInitiated).async {
                let result = bittery_encrypt(plaintext, keyBase64)

                if let error = result.error {
                    let errorStr = String(cString: error)
                    bittery_free_string(result.ciphertext)
                    bittery_free_string(result.iv)
                    bittery_free_string(result.algorithm)
                    bittery_free_string(result.error)
                    promise.reject("ENCRYPTION_FAILED", errorStr)
                    return
                }

                guard let ciphertext = result.ciphertext,
                      let iv = result.iv,
                      let algorithm = result.algorithm else {
                    bittery_free_string(result.ciphertext)
                    bittery_free_string(result.iv)
                    bittery_free_string(result.algorithm)
                    promise.reject("ENCRYPTION_FAILED", "No result returned")
                    return
                }

                let ciphertextStr = String(cString: ciphertext)
                let ivStr = String(cString: iv)
                let algorithmStr = String(cString: algorithm)

                bittery_free_string(result.ciphertext)
                bittery_free_string(result.iv)
                bittery_free_string(result.algorithm)

                promise.resolve([
                    "ciphertext": ciphertextStr,
                    "iv": ivStr,
                    "algorithm": algorithmStr
                ])
            }
        }

        AsyncFunction("decrypt") { (ciphertext: String, iv: String, algorithm: String, keyBase64: String, promise: Promise) in
            DispatchQueue.global(qos: .userInitiated).async {
                guard let result = bittery_decrypt(ciphertext, iv, algorithm, keyBase64) else {
                    promise.reject("DECRYPTION_FAILED", "Decryption returned null")
                    return
                }

                let resultStr = String(cString: result)
                bittery_free_string(result)

                if resultStr.hasPrefix("ERROR:") {
                    let errorMsg = String(resultStr.dropFirst(6))
                    promise.reject("DECRYPTION_FAILED", errorMsg)
                } else {
                    promise.resolve(resultStr)
                }
            }
        }

        AsyncFunction("encryptWithContext") { (plaintext: String, keyBase64: String, vaultId: String, entityId: String, entityType: String, version: Int64, userId: String, promise: Promise) in
            DispatchQueue.global(qos: .userInitiated).async {
                let result = bittery_encrypt_with_context(plaintext, keyBase64, vaultId, entityId, entityType, UInt64(version), userId)

                if let error = result.error {
                    let errorStr = String(cString: error)
                    bittery_free_string(result.ciphertext)
                    bittery_free_string(result.iv)
                    bittery_free_string(result.algorithm)
                    bittery_free_string(result.error)
                    promise.reject("ENCRYPTION_FAILED", errorStr)
                    return
                }

                guard let ciphertext = result.ciphertext,
                      let iv = result.iv,
                      let algorithm = result.algorithm else {
                    bittery_free_string(result.ciphertext)
                    bittery_free_string(result.iv)
                    bittery_free_string(result.algorithm)
                    promise.reject("ENCRYPTION_FAILED", "No result returned")
                    return
                }

                let ciphertextStr = String(cString: ciphertext)
                let ivStr = String(cString: iv)
                let algorithmStr = String(cString: algorithm)

                bittery_free_string(result.ciphertext)
                bittery_free_string(result.iv)
                bittery_free_string(result.algorithm)

                promise.resolve([
                    "ciphertext": ciphertextStr,
                    "iv": ivStr,
                    "algorithm": algorithmStr
                ])
            }
        }

        AsyncFunction("decryptWithContext") { (ciphertext: String, iv: String, algorithm: String, keyBase64: String, vaultId: String, entityId: String, entityType: String, version: Int64, userId: String, promise: Promise) in
            DispatchQueue.global(qos: .userInitiated).async {
                guard let result = bittery_decrypt_with_context(ciphertext, iv, algorithm, keyBase64, vaultId, entityId, entityType, UInt64(version), userId) else {
                    promise.reject("DECRYPTION_FAILED", "Decryption returned null")
                    return
                }

                let resultStr = String(cString: result)
                bittery_free_string(result)

                if resultStr.hasPrefix("ERROR:") {
                    let errorMsg = String(resultStr.dropFirst(6))
                    promise.reject("DECRYPTION_FAILED", errorMsg)
                } else {
                    promise.resolve(resultStr)
                }
            }
        }

        Function("generateEncryptionKey") { () -> String in
            guard let result = bittery_generate_encryption_key() else {
                return ""
            }
            let key = String(cString: result)
            bittery_free_string(result)
            return key
        }

        Function("generateUuid") { () -> String in
            guard let result = bittery_generate_uuid() else {
                return ""
            }
            let uuid = String(cString: result)
            bittery_free_string(result)
            return uuid
        }

        // ============================================================================
        // RSA-4096
        // ============================================================================

        AsyncFunction("generateRsaKeyPair") { (promise: Promise) in
            DispatchQueue.global(qos: .userInitiated).async {
                let result = bittery_generate_rsa_key_pair()

                if let error = result.error {
                    let errorStr = String(cString: error)
                    bittery_free_string(result.public_key)
                    bittery_free_string(result.private_key)
                    bittery_free_string(result.error)
                    promise.reject("RSA_GENERATION_FAILED", errorStr)
                    return
                }

                guard let publicKey = result.public_key,
                      let privateKey = result.private_key else {
                    bittery_free_string(result.public_key)
                    bittery_free_string(result.private_key)
                    promise.reject("RSA_GENERATION_FAILED", "No keys returned")
                    return
                }

                let publicKeyStr = String(cString: publicKey)
                let privateKeyStr = String(cString: privateKey)

                bittery_free_string(result.public_key)
                bittery_free_string(result.private_key)

                promise.resolve([
                    "publicKey": publicKeyStr,
                    "privateKey": privateKeyStr
                ])
            }
        }

        AsyncFunction("rsaEncrypt") { (plaintext: String, publicKeyPem: String, promise: Promise) in
            DispatchQueue.global(qos: .userInitiated).async {
                guard let result = bittery_rsa_encrypt(plaintext, publicKeyPem) else {
                    promise.reject("RSA_ENCRYPTION_FAILED", "Encryption returned null")
                    return
                }

                let resultStr = String(cString: result)
                bittery_free_string(result)

                if resultStr.hasPrefix("ERROR:") {
                    let errorMsg = String(resultStr.dropFirst(6))
                    promise.reject("RSA_ENCRYPTION_FAILED", errorMsg)
                } else {
                    promise.resolve(resultStr)
                }
            }
        }

        AsyncFunction("rsaDecrypt") { (ciphertext: String, privateKeyPem: String, promise: Promise) in
            DispatchQueue.global(qos: .userInitiated).async {
                guard let result = bittery_rsa_decrypt(ciphertext, privateKeyPem) else {
                    promise.reject("RSA_DECRYPTION_FAILED", "Decryption returned null")
                    return
                }

                let resultStr = String(cString: result)
                bittery_free_string(result)

                if resultStr.hasPrefix("ERROR:") {
                    let errorMsg = String(resultStr.dropFirst(6))
                    promise.reject("RSA_DECRYPTION_FAILED", errorMsg)
                } else {
                    promise.resolve(resultStr)
                }
            }
        }

        // ============================================================================
        // Secret Key
        // ============================================================================

        Function("generateSecretKey") { () -> String in
            guard let result = bittery_generate_secret_key() else {
                return ""
            }
            let key = String(cString: result)
            bittery_free_string(result)
            return key
        }

        Function("validateSecretKey") { (secretKey: String) -> Bool in
            return bittery_validate_secret_key(secretKey) == 1
        }

        Function("getSecretKeyHint") { (secretKey: String) -> String in
            guard let result = bittery_get_secret_key_hint(secretKey) else {
                return ""
            }
            let hint = String(cString: result)
            bittery_free_string(result)
            return hint
        }

        Function("generateRecoveryKey") { () -> String in
            guard let result = bittery_generate_recovery_key() else {
                return ""
            }
            let key = String(cString: result)
            bittery_free_string(result)
            return key
        }

        Function("validateRecoveryKey") { (recoveryKey: String) -> Bool in
            return bittery_validate_recovery_key(recoveryKey) == 1
        }

        AsyncFunction("encryptMasterKey") { (masterKeyBase64: String, recoveryKey: String, email: String, promise: Promise) in
            DispatchQueue.global(qos: .userInitiated).async {
                let result = bittery_encrypt_master_key(masterKeyBase64, recoveryKey, email)

                if let error = result.error {
                    let errorStr = String(cString: error)
                    bittery_free_string(result.ciphertext)
                    bittery_free_string(result.iv)
                    bittery_free_string(result.algorithm)
                    bittery_free_string(result.error)
                    promise.reject("ENCRYPTION_FAILED", errorStr)
                    return
                }

                guard let ciphertext = result.ciphertext,
                      let iv = result.iv,
                      let algorithm = result.algorithm else {
                    bittery_free_string(result.ciphertext)
                    bittery_free_string(result.iv)
                    bittery_free_string(result.algorithm)
                    promise.reject("ENCRYPTION_FAILED", "No result returned")
                    return
                }

                let ciphertextStr = String(cString: ciphertext)
                let ivStr = String(cString: iv)
                let algorithmStr = String(cString: algorithm)

                bittery_free_string(result.ciphertext)
                bittery_free_string(result.iv)
                bittery_free_string(result.algorithm)

                promise.resolve([
                    "ciphertext": ciphertextStr,
                    "iv": ivStr,
                    "algorithm": algorithmStr
                ])
            }
        }

        AsyncFunction("decryptMasterKey") { (ciphertext: String, iv: String, algorithm: String, recoveryKey: String, email: String, promise: Promise) in
            DispatchQueue.global(qos: .userInitiated).async {
                guard let result = bittery_decrypt_master_key(ciphertext, iv, algorithm, recoveryKey, email) else {
                    promise.reject("DECRYPTION_FAILED", "Decryption returned null")
                    return
                }

                let resultStr = String(cString: result)
                bittery_free_string(result)

                if resultStr.hasPrefix("ERROR:") {
                    let errorMsg = String(resultStr.dropFirst(6))
                    promise.reject("DECRYPTION_FAILED", errorMsg)
                } else {
                    promise.resolve(resultStr)
                }
            }
        }

        // ============================================================================
        // SRP-6a Client
        // ============================================================================

        Function("srpClientNew") { (hashAlgorithm: String, primeGroup: Int) -> Int64 in
            guard let handle = bittery_srp_client_new(hashAlgorithm, UInt32(primeGroup)) else {
                return 0
            }

            self.lock.lock()
            defer { self.lock.unlock() }

            let clientId = self.nextClientId
            self.nextClientId += 1
            self.srpClients[clientId] = handle
            return clientId
        }

        Function("srpClientFree") { (clientId: Int64) in
            self.lock.lock()
            defer { self.lock.unlock() }

            if let handle = self.srpClients.removeValue(forKey: clientId) {
                bittery_srp_client_free(handle)
            }
        }

        Function("srpClientGenerateSalt") { (clientId: Int64) -> String in
            self.lock.lock()
            let handle = self.srpClients[clientId]
            self.lock.unlock()

            guard let handle = handle,
                  let result = bittery_srp_client_generate_salt(handle) else {
                return ""
            }
            let salt = String(cString: result)
            bittery_free_string(result)
            return salt
        }

        AsyncFunction("srpClientDeriveSafePrivateKey") { (clientId: Int64, salt: String, password: String, iterations: Int, promise: Promise) in
            self.lock.lock()
            let handle = self.srpClients[clientId]
            self.lock.unlock()

            guard let handle = handle else {
                promise.reject("INVALID_CLIENT", "Invalid SRP client ID")
                return
            }

            DispatchQueue.global(qos: .userInitiated).async {
                guard let result = bittery_srp_client_derive_safe_private_key(handle, salt, password, UInt32(iterations)) else {
                    promise.reject("SRP_KEY_DERIVATION_FAILED", "Failed to derive private key")
                    return
                }
                let privateKey = String(cString: result)
                bittery_free_string(result)
                promise.resolve(privateKey)
            }
        }

        Function("srpClientDeriveVerifier") { (clientId: Int64, privateKey: String) -> String in
            self.lock.lock()
            let handle = self.srpClients[clientId]
            self.lock.unlock()

            guard let handle = handle,
                  let result = bittery_srp_client_derive_verifier(handle, privateKey) else {
                return ""
            }
            let verifier = String(cString: result)
            bittery_free_string(result)
            return verifier
        }

        Function("srpClientGenerateEphemeral") { (clientId: Int64) -> [String: String] in
            self.lock.lock()
            let handle = self.srpClients[clientId]
            self.lock.unlock()

            guard let handle = handle else {
                return ["public": "", "secret": ""]
            }

            let result = bittery_srp_client_generate_ephemeral(handle)

            guard let publicPtr = result.public_,
                  let secretPtr = result.secret else {
                bittery_free_string(result.public_)
                bittery_free_string(result.secret)
                return ["public": "", "secret": ""]
            }

            let publicStr = String(cString: publicPtr)
            let secretStr = String(cString: secretPtr)

            bittery_free_string(result.public_)
            bittery_free_string(result.secret)

            return ["public": publicStr, "secret": secretStr]
        }

        AsyncFunction("srpClientDeriveSession") { (clientId: Int64, clientSecretEphemeral: String, serverPublicEphemeral: String, salt: String, username: String, privateKey: String, promise: Promise) in
            self.lock.lock()
            let handle = self.srpClients[clientId]
            self.lock.unlock()

            guard let handle = handle else {
                promise.reject("INVALID_CLIENT", "Invalid SRP client ID")
                return
            }

            DispatchQueue.global(qos: .userInitiated).async {
                let result = bittery_srp_client_derive_session(handle, clientSecretEphemeral, serverPublicEphemeral, salt, username, privateKey)

                if let error = result.error {
                    let errorStr = String(cString: error)
                    bittery_free_string(result.key)
                    bittery_free_string(result.proof)
                    bittery_free_string(result.error)
                    promise.reject("SRP_SESSION_FAILED", errorStr)
                    return
                }

                guard let key = result.key, let proof = result.proof else {
                    bittery_free_string(result.key)
                    bittery_free_string(result.proof)
                    promise.reject("SRP_SESSION_FAILED", "No session returned")
                    return
                }

                let keyStr = String(cString: key)
                let proofStr = String(cString: proof)

                bittery_free_string(result.key)
                bittery_free_string(result.proof)

                promise.resolve([
                    "key": keyStr,
                    "proof": proofStr
                ])
            }
        }

        AsyncFunction("srpClientVerifySession") { (clientId: Int64, clientPublicEphemeral: String, sessionKey: String, sessionProof: String, serverSessionProof: String, promise: Promise) in
            self.lock.lock()
            let handle = self.srpClients[clientId]
            self.lock.unlock()

            guard let handle = handle else {
                promise.reject("INVALID_CLIENT", "Invalid SRP client ID")
                return
            }

            DispatchQueue.global(qos: .userInitiated).async {
                guard let result = bittery_srp_client_verify_session(handle, clientPublicEphemeral, sessionKey, sessionProof, serverSessionProof) else {
                    promise.reject("SRP_VERIFY_FAILED", "Verification returned null")
                    return
                }

                let resultStr = String(cString: result)
                bittery_free_string(result)

                if resultStr.hasPrefix("ERROR:") {
                    let errorMsg = String(resultStr.dropFirst(6))
                    promise.reject("SRP_VERIFY_FAILED", errorMsg)
                } else {
                    promise.resolve(true)
                }
            }
        }

        // ============================================================================
        // SRP-6a Server
        // ============================================================================

        Function("srpServerNew") { (hashAlgorithm: String, primeGroup: Int) -> Int64 in
            guard let handle = bittery_srp_server_new(hashAlgorithm, UInt32(primeGroup)) else {
                return 0
            }

            self.lock.lock()
            defer { self.lock.unlock() }

            let serverId = self.nextServerId
            self.nextServerId += 1
            self.srpServers[serverId] = handle
            return serverId
        }

        Function("srpServerFree") { (serverId: Int64) in
            self.lock.lock()
            defer { self.lock.unlock() }

            if let handle = self.srpServers.removeValue(forKey: serverId) {
                bittery_srp_server_free(handle)
            }
        }

        AsyncFunction("srpServerGenerateEphemeral") { (serverId: Int64, verifier: String, promise: Promise) in
            self.lock.lock()
            let handle = self.srpServers[serverId]
            self.lock.unlock()

            guard let handle = handle else {
                promise.reject("INVALID_SERVER", "Invalid SRP server ID")
                return
            }

            DispatchQueue.global(qos: .userInitiated).async {
                let result = bittery_srp_server_generate_ephemeral(handle, verifier)

                guard let publicPtr = result.public_,
                      let secretPtr = result.secret else {
                    bittery_free_string(result.public_)
                    bittery_free_string(result.secret)
                    promise.reject("SRP_EPHEMERAL_FAILED", "Failed to generate ephemeral")
                    return
                }

                let publicStr = String(cString: publicPtr)
                let secretStr = String(cString: secretPtr)

                bittery_free_string(result.public_)
                bittery_free_string(result.secret)

                promise.resolve([
                    "public": publicStr,
                    "secret": secretStr
                ])
            }
        }

        AsyncFunction("srpServerDeriveSession") { (serverId: Int64, serverSecretEphemeral: String, clientPublicEphemeral: String, salt: String, username: String, verifier: String, clientSessionProof: String, promise: Promise) in
            self.lock.lock()
            let handle = self.srpServers[serverId]
            self.lock.unlock()

            guard let handle = handle else {
                promise.reject("INVALID_SERVER", "Invalid SRP server ID")
                return
            }

            DispatchQueue.global(qos: .userInitiated).async {
                let result = bittery_srp_server_derive_session(handle, serverSecretEphemeral, clientPublicEphemeral, salt, username, verifier, clientSessionProof)

                if let error = result.error {
                    let errorStr = String(cString: error)
                    bittery_free_string(result.key)
                    bittery_free_string(result.proof)
                    bittery_free_string(result.error)
                    promise.reject("SRP_SESSION_FAILED", errorStr)
                    return
                }

                guard let key = result.key, let proof = result.proof else {
                    bittery_free_string(result.key)
                    bittery_free_string(result.proof)
                    promise.reject("SRP_SESSION_FAILED", "No session returned")
                    return
                }

                let keyStr = String(cString: key)
                let proofStr = String(cString: proof)

                bittery_free_string(result.key)
                bittery_free_string(result.proof)

                promise.resolve([
                    "key": keyStr,
                    "proof": proofStr
                ])
            }
        }

        // ============================================================================
        // Passkey / WebAuthn
        // ============================================================================

        AsyncFunction("generatePasskeyKeypair") { (promise: Promise) in
            DispatchQueue.global(qos: .userInitiated).async {
                let result = bittery_passkey_generate_keypair()

                if let error = result.error {
                    let errorStr = String(cString: error)
                    bittery_free_string(result.private_key)
                    bittery_free_string(result.public_key_cose)
                    bittery_free_string(result.error)
                    promise.reject("PASSKEY_GENERATION_FAILED", errorStr)
                    return
                }

                guard let privateKey = result.private_key,
                      let publicKeyCose = result.public_key_cose else {
                    bittery_free_string(result.private_key)
                    bittery_free_string(result.public_key_cose)
                    promise.reject("PASSKEY_GENERATION_FAILED", "No keypair returned")
                    return
                }

                let privateKeyStr = String(cString: privateKey)
                let publicKeyCoseStr = String(cString: publicKeyCose)

                bittery_free_string(result.private_key)
                bittery_free_string(result.public_key_cose)

                promise.resolve([
                    "privateKey": privateKeyStr,
                    "publicKeyCose": publicKeyCoseStr
                ])
            }
        }

        Function("generatePasskeyCredentialId") { () -> String in
            guard let result = bittery_passkey_generate_credential_id() else {
                return ""
            }
            let credentialId = String(cString: result)
            bittery_free_string(result)
            return credentialId
        }

        AsyncFunction("buildPasskeyAttestationObject") { (rpId: String, credentialIdBase64: String, cosePublicKeyBase64: String, signCount: Int, promise: Promise) in
            DispatchQueue.global(qos: .userInitiated).async {
                guard let count = UInt32(exactly: signCount) else {
                    promise.reject("PASSKEY_ATTESTATION_FAILED", "Invalid signCount")
                    return
                }
                let result = bittery_passkey_build_attestation_object(rpId, credentialIdBase64, cosePublicKeyBase64, count)

                if let error = result.error {
                    let errorStr = String(cString: error)
                    bittery_free_string(result.authenticator_data)
                    bittery_free_string(result.attestation_object)
                    bittery_free_string(result.error)
                    promise.reject("PASSKEY_ATTESTATION_FAILED", errorStr)
                    return
                }

                guard let authenticatorData = result.authenticator_data,
                      let attestationObject = result.attestation_object else {
                    bittery_free_string(result.authenticator_data)
                    bittery_free_string(result.attestation_object)
                    promise.reject("PASSKEY_ATTESTATION_FAILED", "No result returned")
                    return
                }

                let authenticatorDataStr = String(cString: authenticatorData)
                let attestationObjectStr = String(cString: attestationObject)

                bittery_free_string(result.authenticator_data)
                bittery_free_string(result.attestation_object)

                promise.resolve([
                    "authenticatorData": authenticatorDataStr,
                    "attestationObject": attestationObjectStr
                ])
            }
        }

        AsyncFunction("signPasskeyAssertion") { (privateKeyBase64: String, rpId: String, clientDataHashBase64: String, signCount: Int, promise: Promise) in
            DispatchQueue.global(qos: .userInitiated).async {
                guard let count = UInt32(exactly: signCount) else {
                    promise.reject("PASSKEY_ASSERTION_FAILED", "Invalid signCount")
                    return
                }
                let result = bittery_passkey_sign_assertion(privateKeyBase64, rpId, clientDataHashBase64, count)

                if let error = result.error {
                    let errorStr = String(cString: error)
                    bittery_free_string(result.authenticator_data)
                    bittery_free_string(result.signature_der)
                    bittery_free_string(result.error)
                    promise.reject("PASSKEY_ASSERTION_FAILED", errorStr)
                    return
                }

                guard let authenticatorData = result.authenticator_data,
                      let signatureDer = result.signature_der else {
                    bittery_free_string(result.authenticator_data)
                    bittery_free_string(result.signature_der)
                    promise.reject("PASSKEY_ASSERTION_FAILED", "No result returned")
                    return
                }

                let authenticatorDataStr = String(cString: authenticatorData)
                let signatureDerStr = String(cString: signatureDer)

                bittery_free_string(result.authenticator_data)
                bittery_free_string(result.signature_der)

                promise.resolve([
                    "authenticatorData": authenticatorDataStr,
                    "signatureDer": signatureDerStr
                ])
            }
        }

        // ============================================================================
        // Key Rotation
        // ============================================================================

        AsyncFunction("encryptVaultKeyForMember") { (vaultKeyBase64: String, memberPublicKeyPem: String, promise: Promise) in
            DispatchQueue.global(qos: .userInitiated).async {
                guard let result = bittery_encrypt_vault_key_for_member(vaultKeyBase64, memberPublicKeyPem) else {
                    promise.reject("ENCRYPTION_FAILED", "Encryption returned null")
                    return
                }

                let resultStr = String(cString: result)
                bittery_free_string(result)

                if resultStr.hasPrefix("ERROR:") {
                    let errorMsg = String(resultStr.dropFirst(6))
                    promise.reject("ENCRYPTION_FAILED", errorMsg)
                } else {
                    promise.resolve(resultStr)
                }
            }
        }

        AsyncFunction("encryptVaultKeyWithMuk") { (vaultKeyBase64: String, masterUnlockKeyBase64: String, vaultId: String, userId: String, keyVersion: Int64, promise: Promise) in
            DispatchQueue.global(qos: .userInitiated).async {
                guard let result = bittery_encrypt_vault_key_with_muk(vaultKeyBase64, masterUnlockKeyBase64, vaultId, userId, UInt64(keyVersion)) else {
                    promise.reject("ENCRYPTION_FAILED", "Encryption returned null")
                    return
                }

                let resultStr = String(cString: result)
                bittery_free_string(result)

                if resultStr.hasPrefix("ERROR:") {
                    let errorMsg = String(resultStr.dropFirst(6))
                    promise.reject("ENCRYPTION_FAILED", errorMsg)
                } else {
                    promise.resolve(resultStr)
                }
            }
        }

        AsyncFunction("reEncryptItem") { (itemId: String, encryptedData: String, encryptionIv: String, encryptionAlgorithm: String, oldVaultKeyBase64: String, newVaultKeyBase64: String, promise: Promise) in
            DispatchQueue.global(qos: .userInitiated).async {
                let result = bittery_re_encrypt_item(itemId, encryptedData, encryptionIv, encryptionAlgorithm, oldVaultKeyBase64, newVaultKeyBase64)

                if let error = result.error {
                    let errorStr = String(cString: error)
                    bittery_free_re_encrypted_item_result(result)
                    promise.reject("ENCRYPTION_FAILED", errorStr)
                    return
                }

                guard let newItemId = result.item_id,
                      let newEncryptedData = result.encrypted_data,
                      let newEncryptionIv = result.encryption_iv else {
                    bittery_free_re_encrypted_item_result(result)
                    promise.reject("ENCRYPTION_FAILED", "No result returned")
                    return
                }

                let itemIdStr = String(cString: newItemId)
                let encryptedDataStr = String(cString: newEncryptedData)
                let encryptionIvStr = String(cString: newEncryptionIv)

                bittery_free_re_encrypted_item_result(result)

                promise.resolve([
                    "itemId": itemIdStr,
                    "encryptedData": encryptedDataStr,
                    "encryptionIv": encryptionIvStr
                ])
            }
        }

        AsyncFunction("performKeyRotation") { (oldVaultKeyBase64: String, membersJson: String, itemsJson: String, vaultId: String, keyVersion: Int64, currentUserId: String, masterUnlockKeyBase64: String, promise: Promise) in
            DispatchQueue.global(qos: .userInitiated).async {
                let result = bittery_perform_key_rotation(oldVaultKeyBase64, membersJson, itemsJson, vaultId, UInt64(keyVersion), currentUserId, masterUnlockKeyBase64)

                if let error = result.error {
                    let errorStr = String(cString: error)
                    bittery_free_key_rotation_result(result)
                    promise.reject("ENCRYPTION_FAILED", errorStr)
                    return
                }

                guard let memberKeysJson = result.member_encrypted_keys_json,
                      let itemsJsonOut = result.re_encrypted_items_json else {
                    bittery_free_key_rotation_result(result)
                    promise.reject("ENCRYPTION_FAILED", "No result returned")
                    return
                }

                let memberKeysJsonStr = String(cString: memberKeysJson)
                let itemsJsonOutStr = String(cString: itemsJsonOut)

                bittery_free_key_rotation_result(result)

                promise.resolve([
                    "memberEncryptedKeysJson": memberKeysJsonStr,
                    "reEncryptedItemsJson": itemsJsonOutStr
                ])
            }
        }

        // Unlike every other struct-returning member in this file, `ValidationResultFFI`
        // has no `error` field: malformed `membersJson` comes back as `valid: false`,
        // not a thrown error, matching the core's own design.
        AsyncFunction("validateRotationData") { (membersJson: String, promise: Promise) in
            DispatchQueue.global(qos: .userInitiated).async {
                let result = bittery_validate_rotation_data(membersJson)

                guard let errorsJson = result.errors_json else {
                    bittery_free_validation_result(result)
                    promise.reject("ENCRYPTION_FAILED", "No result returned")
                    return
                }

                let errorsJsonStr = String(cString: errorsJson)
                let valid = result.valid == 1

                bittery_free_validation_result(result)

                promise.resolve([
                    "valid": valid,
                    "errorsJson": errorsJsonStr
                ])
            }
        }

        // ============================================================================
        // TOTP (Time-Based One-Time Password)
        // ============================================================================

        Function("generateTotp") { (secret: String, algorithm: String, digits: Int32, period: Int64) -> [String: Any] in
            let result = bittery_generate_totp(secret, algorithm, digits, UInt64(period))

            if let error = result.error {
                let errorStr = String(cString: error)
                bittery_free_totp_result(result)
                throw NSError(domain: "BitteryCrypto", code: 1, userInfo: [NSLocalizedDescriptionKey: errorStr])
            }

            guard let code = result.code else {
                bittery_free_totp_result(result)
                throw NSError(domain: "BitteryCrypto", code: 1, userInfo: [NSLocalizedDescriptionKey: "No code returned"])
            }

            let codeStr = String(cString: code)
            let remainingSeconds = result.remaining_seconds
            let resultPeriod = result.period
            let progress = result.progress

            bittery_free_totp_result(result)

            return [
                "code": codeStr,
                "remainingSeconds": remainingSeconds,
                "period": resultPeriod,
                "progress": progress
            ]
        }
    }
}
