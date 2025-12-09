/**
 * RSA Key Pair Generation and Operations
 * For encrypting vault keys when sharing with team members
 */

const RSA_KEY_SIZE = 4096;
const RSA_ALGORITHM = "RSA-OAEP";
const HASH_ALGORITHM = "SHA-256";

export interface RSAKeyPair {
	publicKey: string; // PEM format
	privateKey: string; // PEM format
}

/**
 * Generate RSA-4096 key pair for vault sharing
 */
export async function generateRSAKeyPair(): Promise<RSAKeyPair> {
	const keyPair = await crypto.subtle.generateKey(
		{
			name: RSA_ALGORITHM,
			modulusLength: RSA_KEY_SIZE,
			publicExponent: new Uint8Array([1, 0, 1]), // 65537
			hash: HASH_ALGORITHM,
		},
		true,
		["encrypt", "decrypt"],
	);

	// Export public key
	const publicKeyBuffer = await crypto.subtle.exportKey(
		"spki",
		keyPair.publicKey,
	);
	const publicKeyBase64 = arrayBufferToBase64(new Uint8Array(publicKeyBuffer));
	const publicKeyPEM = `-----BEGIN PUBLIC KEY-----\n${publicKeyBase64}\n-----END PUBLIC KEY-----`;

	// Export private key
	const privateKeyBuffer = await crypto.subtle.exportKey(
		"pkcs8",
		keyPair.privateKey,
	);
	const privateKeyBase64 = arrayBufferToBase64(
		new Uint8Array(privateKeyBuffer),
	);
	const privateKeyPEM = `-----BEGIN PRIVATE KEY-----\n${privateKeyBase64}\n-----END PRIVATE KEY-----`;

	return {
		publicKey: publicKeyPEM,
		privateKey: privateKeyPEM,
	};
}

/**
 * Encrypt data with RSA public key (for sharing vault keys)
 */
export async function rsaEncrypt(
	plaintext: string,
	publicKeyPEM: string,
): Promise<string> {
	// Import public key
	const publicKeyBase64 = publicKeyPEM
		.replace("-----BEGIN PUBLIC KEY-----", "")
		.replace("-----END PUBLIC KEY-----", "")
		.replace(/\n/g, "");
	const publicKeyBuffer = base64ToArrayBuffer(publicKeyBase64);

	const publicKey = await crypto.subtle.importKey(
		"spki",
		publicKeyBuffer,
		{
			name: RSA_ALGORITHM,
			hash: HASH_ALGORITHM,
		},
		false,
		["encrypt"],
	);

	// Encrypt
	const plaintextBytes = new TextEncoder().encode(plaintext);
	const ciphertextBuffer = await crypto.subtle.encrypt(
		{ name: RSA_ALGORITHM },
		publicKey,
		plaintextBytes,
	);

	return arrayBufferToBase64(new Uint8Array(ciphertextBuffer));
}

/**
 * Decrypt data with RSA private key
 */
export async function rsaDecrypt(
	ciphertext: string,
	privateKeyPEM: string,
): Promise<string> {
	// Import private key
	const privateKeyBase64 = privateKeyPEM
		.replace("-----BEGIN PRIVATE KEY-----", "")
		.replace("-----END PRIVATE KEY-----", "")
		.replace(/\n/g, "");
	const privateKeyBuffer = base64ToArrayBuffer(privateKeyBase64);

	const privateKey = await crypto.subtle.importKey(
		"pkcs8",
		privateKeyBuffer,
		{
			name: RSA_ALGORITHM,
			hash: HASH_ALGORITHM,
		},
		false,
		["decrypt"],
	);

	// Decrypt
	const ciphertextBytes = base64ToArrayBuffer(ciphertext);
	const plaintextBuffer = await crypto.subtle.decrypt(
		{ name: RSA_ALGORITHM },
		privateKey,
		ciphertextBytes,
	);

	return new TextDecoder().decode(plaintextBuffer);
}

/**
 * Convert ArrayBuffer to base64
 */
function arrayBufferToBase64(buffer: Uint8Array): string {
	const binary = String.fromCharCode(...buffer);
	return btoa(binary);
}

/**
 * Convert base64 to ArrayBuffer
 */
function base64ToArrayBuffer(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}
