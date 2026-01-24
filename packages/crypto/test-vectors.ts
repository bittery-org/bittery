/**
 * Test Vector Generator for Cross-Platform Crypto Verification
 *
 * Run this script to generate test vectors for verifying the Kotlin
 * implementation matches the TypeScript implementation.
 *
 * Usage:
 *   npx ts-node packages/crypto/test-vectors.ts
 *
 * The output can be used to update the expected values in:
 *   apps/mobile/modules/credential-provider/android/src/test/java/.../CryptoTestVectors.kt
 */

import { deriveKeys, arrayBufferToBase64, base64ToArrayBuffer } from "./src/key-derivation";
import { encrypt, decrypt } from "./src/encryption";

// Test inputs (must match values in CryptoTestVectors.kt)
const TEST_PASSWORD = "testPassword123!";
const TEST_SECRET_KEY = "A3-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX";
const TEST_EMAIL = "test@example.com";

async function generateKeyDerivationVectors() {
  console.log("=== Key Derivation Test Vectors ===");
  console.log("Input password:", TEST_PASSWORD);
  console.log("Input secretKey:", TEST_SECRET_KEY);
  console.log("Input email:", TEST_EMAIL);
  console.log("");

  const result = await deriveKeys(TEST_PASSWORD, TEST_SECRET_KEY, TEST_EMAIL);

  const authKeyBase64 = arrayBufferToBase64(result.authKey);
  const mukBase64 = arrayBufferToBase64(result.masterUnlockKey);

  console.log("Auth key (Base64):", authKeyBase64);
  console.log("MUK (Base64):", mukBase64);
  console.log("");

  console.log("Kotlin test constants:");
  console.log(`const val EXPECTED_AUTH_KEY_BASE64 = "${authKeyBase64}"`);
  console.log(`const val EXPECTED_MUK_BASE64 = "${mukBase64}"`);
  console.log("");

  return { authKey: result.authKey, masterUnlockKey: result.masterUnlockKey };
}

async function generateAesGcmVectors(key: Uint8Array) {
  console.log("=== AES-GCM Test Vectors ===");
  console.log("Key (Base64):", arrayBufferToBase64(key));
  console.log("");

  const plaintext = "Hello, this is a test message for cross-platform verification!";
  console.log("Plaintext:", plaintext);

  const encrypted = await encrypt(plaintext, key);
  console.log("Ciphertext (Base64):", encrypted.ciphertext);
  console.log("IV (Base64):", encrypted.iv);
  console.log("Algorithm:", encrypted.algorithm);
  console.log("");

  // Verify decryption works
  const decrypted = await decrypt(encrypted, key);
  console.log("Decrypted:", decrypted);
  console.log("Match:", decrypted === plaintext ? "YES" : "NO");
  console.log("");

  console.log("Kotlin test constants:");
  console.log(`const val TEST_PLAINTEXT = "${plaintext}"`);
  console.log(`const val TEST_CIPHERTEXT_BASE64 = "${encrypted.ciphertext}"`);
  console.log(`const val TEST_IV_BASE64 = "${encrypted.iv}"`);
  console.log("");

  return encrypted;
}

async function generateVaultDecryptionVectors(muk: Uint8Array) {
  console.log("=== Vault Decryption Test Vectors ===");

  // Simulate a vault key (32 bytes)
  const vaultKey = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    vaultKey[i] = i + 1;
  }
  console.log("Vault key (Base64):", arrayBufferToBase64(vaultKey));

  // Encrypt vault key with MUK
  const vaultKeyBase64 = arrayBufferToBase64(vaultKey);
  const encryptedVaultKey = await encrypt(vaultKeyBase64, muk);
  console.log("Encrypted vault key (Base64):", encryptedVaultKey.ciphertext);
  console.log("Vault key IV (Base64):", encryptedVaultKey.iv);
  console.log("");

  // Simulate an item's encrypted data
  const itemData = JSON.stringify({
    username: "user@example.com",
    password: "secretPassword123",
    url: "https://example.com",
    notes: "Test notes",
  });
  console.log("Item data:", itemData);

  const encryptedItemData = await encrypt(itemData, vaultKey);
  console.log("Encrypted item data (Base64):", encryptedItemData.ciphertext);
  console.log("Item data IV (Base64):", encryptedItemData.iv);
  console.log("");

  console.log("Kotlin test constants:");
  console.log(`const val TEST_VAULT_KEY_BASE64 = "${vaultKeyBase64}"`);
  console.log(`const val TEST_ENCRYPTED_VAULT_KEY_BASE64 = "${encryptedVaultKey.ciphertext}"`);
  console.log(`const val TEST_VAULT_KEY_IV_BASE64 = "${encryptedVaultKey.iv}"`);
  console.log(`const val TEST_ENCRYPTED_ITEM_DATA_BASE64 = "${encryptedItemData.ciphertext}"`);
  console.log(`const val TEST_ITEM_DATA_IV_BASE64 = "${encryptedItemData.iv}"`);
  console.log("");
}

async function main() {
  console.log("============================================");
  console.log("Cross-Platform Crypto Test Vector Generator");
  console.log("============================================");
  console.log("");

  try {
    const { authKey, masterUnlockKey } = await generateKeyDerivationVectors();
    await generateAesGcmVectors(masterUnlockKey);
    await generateVaultDecryptionVectors(masterUnlockKey);

    console.log("============================================");
    console.log("Test vector generation complete!");
    console.log("");
    console.log("Next steps:");
    console.log("1. Copy the Kotlin test constants above");
    console.log("2. Update CryptoTestVectors.kt with the values");
    console.log("3. Run the Kotlin tests to verify cross-platform compatibility");
    console.log("============================================");
  } catch (error) {
    console.error("Error generating test vectors:", error);
    process.exit(1);
  }
}

main();
