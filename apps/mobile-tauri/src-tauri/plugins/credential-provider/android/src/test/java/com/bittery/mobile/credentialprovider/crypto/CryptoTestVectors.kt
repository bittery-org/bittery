package com.bittery.mobile.credentialprovider.crypto

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Test vectors for verifying cross-platform crypto compatibility.
 *
 * These tests verify that the Kotlin implementations produce byte-for-byte
 * identical output to the TypeScript implementations in packages/crypto/.
 *
 * Test vectors were generated using the TypeScript implementations:
 * - packages/crypto/src/key-derivation.ts
 * - packages/crypto/src/encryption.ts
 *
 * To regenerate test vectors:
 * 1. Create a test script in TypeScript that calls deriveKeys() and encrypt()
 * 2. Print the Base64-encoded results
 * 3. Update the expected values here
 */
class CryptoTestVectors {

    companion object {
        // Test input values
        const val TEST_PASSWORD = "testPassword123!"
        const val TEST_SECRET_KEY = "A3-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
        const val TEST_EMAIL = "test@example.com"
        const val KDF_SCHEMA_VERSION = 1
        const val KDF_ALGORITHM = "pbkdf2-sha256"
        const val KDF_ITERATIONS = 600_000

        /**
         * Expected test vectors from TypeScript implementation.
         *
         * Generated using:
         * ```typescript
         * import { deriveKeys, arrayBufferToBase64 } from "@bittery/crypto/key-derivation";
         *
         * const result = await deriveKeys(
         *   "testPassword123!",
         *   "A3-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX",
         *   "test@example.com"
         * );
         *
         * console.log("authKey:", arrayBufferToBase64(result.authKey));
         * console.log("masterUnlockKey:", arrayBufferToBase64(result.masterUnlockKey));
         * ```
         *
         * Independently reproduced with Node's `pbkdf2Sync` and `hkdfSync`.
         */
        const val EXPECTED_AUTH_KEY_BASE64 = "ZceGVJ8qMMsFI+KQQBwCkK36+s1tZcnalkgD5HX8JCk="
        const val EXPECTED_MUK_BASE64 = "o3TQ32pQg8cRvihBOAZxiA+Hz+7+o4wqWSlt4s0McNo="
    }

    /**
     * Test that PBKDF2 + HKDF key derivation produces consistent results.
     *
     * This test verifies:
     * 1. Combined password format: "password|secretKey"
     * 2. Salt is lowercase email
     * 3. PBKDF2: SHA-256, 600k iterations, 32 bytes
     * 4. HKDF: SHA-256, info="bittery-auth-key" and "bittery-unlock-key"
     */
    @Test
    fun testKeyDerivation() {
        val result = KeyDerivation.deriveKeys(
            accountPassword = TEST_PASSWORD,
            secretKey = TEST_SECRET_KEY,
            email = TEST_EMAIL,
            schemaVersion = KDF_SCHEMA_VERSION,
            algorithm = KDF_ALGORITHM,
            iterations = KDF_ITERATIONS
        )

        // Verify key lengths
        assertEquals("Auth key should be 32 bytes", 32, result.authKey.size)
        assertEquals("MUK should be 32 bytes", 32, result.masterUnlockKey.size)

        // Verify keys are different (HKDF with different info strings)
        assert(!result.authKey.contentEquals(result.masterUnlockKey)) {
            "Auth key and MUK should be different"
        }

        // Log the Base64 values for comparison with TypeScript
        val authKeyBase64 = KeyDerivation.toBase64(result.authKey)
        val mukBase64 = KeyDerivation.toBase64(result.masterUnlockKey)

        println("=== Key Derivation Test Vectors ===")
        println("Input password: $TEST_PASSWORD")
        println("Input secretKey: $TEST_SECRET_KEY")
        println("Input email: $TEST_EMAIL")
        println("Auth key (Base64): $authKeyBase64")
        println("MUK (Base64): $mukBase64")
        println("===================================")

        assertEquals("Auth key should match the cross-platform vector", EXPECTED_AUTH_KEY_BASE64, authKeyBase64)
        assertEquals("MUK should match the cross-platform vector", EXPECTED_MUK_BASE64, mukBase64)
    }

    /**
     * Test that key derivation is deterministic.
     * Same inputs should always produce the same outputs.
     */
    @Test
    fun testKeyDerivationDeterministic() {
        val result1 = KeyDerivation.deriveKeys(TEST_PASSWORD, TEST_SECRET_KEY, TEST_EMAIL, KDF_SCHEMA_VERSION, KDF_ALGORITHM, KDF_ITERATIONS)
        val result2 = KeyDerivation.deriveKeys(TEST_PASSWORD, TEST_SECRET_KEY, TEST_EMAIL, KDF_SCHEMA_VERSION, KDF_ALGORITHM, KDF_ITERATIONS)

        assertArrayEquals("Auth key should be deterministic", result1.authKey, result2.authKey)
        assertArrayEquals("MUK should be deterministic", result1.masterUnlockKey, result2.masterUnlockKey)
    }

    /**
     * Test that email is case-insensitive (lowercased before use).
     */
    @Test
    fun testEmailCaseInsensitive() {
        val result1 = KeyDerivation.deriveKeys(TEST_PASSWORD, TEST_SECRET_KEY, "Test@Example.com", KDF_SCHEMA_VERSION, KDF_ALGORITHM, KDF_ITERATIONS)
        val result2 = KeyDerivation.deriveKeys(TEST_PASSWORD, TEST_SECRET_KEY, "test@example.com", KDF_SCHEMA_VERSION, KDF_ALGORITHM, KDF_ITERATIONS)

        assertArrayEquals("Keys should be same for different email case", result1.authKey, result2.authKey)
        assertArrayEquals("Keys should be same for different email case", result1.masterUnlockKey, result2.masterUnlockKey)
    }

    /**
     * Test AES-GCM encryption/decryption round-trip.
     */
    @Test
    fun testAesGcmRoundTrip() {
        val key = AesGcmCrypto.generateKey()
        val plaintext = "Hello, this is a test message!"

        val encrypted = AesGcmCrypto.encrypt(plaintext, key)
        val decrypted = AesGcmCrypto.decrypt(encrypted, key)

        assertEquals("Decrypted text should match original", plaintext, decrypted)
    }

    /**
     * Test that AES-GCM produces different ciphertext each time (random IV).
     */
    @Test
    fun testAesGcmRandomIv() {
        val key = AesGcmCrypto.generateKey()
        val plaintext = "Same message"

        val encrypted1 = AesGcmCrypto.encrypt(plaintext, key)
        val encrypted2 = AesGcmCrypto.encrypt(plaintext, key)

        // Ciphertext should be different due to random IV
        assert(encrypted1.ciphertext != encrypted2.ciphertext) {
            "Ciphertext should be different for each encryption"
        }
        assert(encrypted1.iv != encrypted2.iv) {
            "IV should be different for each encryption"
        }

        // But both should decrypt to the same plaintext
        assertEquals(plaintext, AesGcmCrypto.decrypt(encrypted1, key))
        assertEquals(plaintext, AesGcmCrypto.decrypt(encrypted2, key))
    }

    /**
     * Test AES-GCM with 32-byte key requirement.
     */
    @Test(expected = IllegalArgumentException::class)
    fun testAesGcmRejectsWrongKeySize() {
        val wrongKey = ByteArray(16) // Too short
        AesGcmCrypto.encrypt("test", wrongKey)
    }

    /**
     * Test cross-platform AES-GCM decryption.
     *
     * This test uses a ciphertext generated by the TypeScript implementation
     * to verify that Kotlin can decrypt it correctly.
     *
     * TODO: Generate actual test vectors from TypeScript.
     */
    @Test
    fun testAesGcmCrossplatformDecryption() {
        // TODO: Generate these from TypeScript:
        // const key = new Uint8Array(32).fill(0x42) // Known key
        // const result = await encrypt("test message", key)
        // console.log(JSON.stringify(result))

        // Placeholder test with generated data
        println("=== AES-GCM Cross-Platform Test ===")
        println("TODO: Generate test vectors from TypeScript")
        println("===================================")
    }

    /**
     * Test Base64 encoding/decoding.
     */
    @Test
    fun testBase64EncodeDecode() {
        val original = byteArrayOf(0, 1, 2, 255.toByte(), 254.toByte(), 128.toByte())
        val encoded = KeyDerivation.toBase64(original)
        val decoded = KeyDerivation.fromBase64(encoded)

        assertArrayEquals("Base64 round-trip should preserve bytes", original, decoded)
    }
}

/**
 * Integration test for verifying end-to-end flow.
 * This would be run as an instrumented test on a device.
 */
class CryptoIntegrationTests {

    /**
     * Test full credential decryption flow.
     *
     * This simulates:
     * 1. Derive MUK from password + secret key
     * 2. Decrypt vault key using MUK
     * 3. Decrypt item using vault key
     *
     * TODO: Create test data from actual server response format.
     */
    @Test
    fun testFullDecryptionFlow() {
        println("=== Full Decryption Flow Test ===")
        println("TODO: Create test data from actual server responses")
        println("=================================")

        // This test would:
        // 1. Use test credentials to derive MUK
        // 2. Use test encrypted vault key
        // 3. Use test encrypted item
        // 4. Verify decrypted password matches expected value
    }
}
