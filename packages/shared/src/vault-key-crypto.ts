import { base64ToArrayBuffer } from "./crypto";

interface EncryptedDataLike {
	ciphertext: string;
	iv: string;
	algorithm: string;
}

export interface VaultKeyCryptoProvider {
	decrypt(encryptedData: EncryptedDataLike, key: Uint8Array): Promise<string>;
	rsaDecrypt?(ciphertext: string, privateKeyPem: string): Promise<string>;
}

/**
 * Detects AES-GCM wrapped vault keys (JSON payload) vs RSA-encrypted base64 strings.
 */
export function isAesEncryptedVaultKey(encryptedVaultKey: string): boolean {
	try {
		const parsed = JSON.parse(encryptedVaultKey) as {
			ciphertext?: unknown;
			iv?: unknown;
		};
		return (
			typeof parsed === "object" &&
			parsed !== null &&
			typeof parsed.ciphertext === "string" &&
			typeof parsed.iv === "string"
		);
	} catch {
		return false;
	}
}

export interface DecryptVaultKeyInput {
	encryptedVaultKey: string;
	masterUnlockKey: Uint8Array;
	encryptedPrivateKey?: string | null;
	crypto: VaultKeyCryptoProvider;
}

export interface VaultKeyStorageLike {
	getVaultKeys(
		email?: string,
	): Promise<Array<{ vaultId: string; encryptedVaultKey: string }> | null>;
	getMasterUnlockKey(email?: string): Promise<Uint8Array | null>;
	getEncryptedPrivateKey(email?: string): Promise<string | null>;
}

/**
 * Decrypts a vault key with either:
 * - AES-GCM(MUK) for owner keys
 * - RSA(privateKey) for shared keys
 */
export async function decryptVaultKey({
	encryptedVaultKey,
	masterUnlockKey,
	encryptedPrivateKey,
	crypto,
}: DecryptVaultKeyInput): Promise<Uint8Array> {
	if (isAesEncryptedVaultKey(encryptedVaultKey)) {
		const encryptedData = JSON.parse(encryptedVaultKey) as EncryptedDataLike;
		const decryptedBase64 = await crypto.decrypt(
			encryptedData,
			masterUnlockKey,
		);
		return base64ToArrayBuffer(decryptedBase64);
	}

	if (!encryptedPrivateKey) {
		throw new Error(
			"Encrypted private key not available. Please log in again.",
		);
	}
	if (!crypto.rsaDecrypt) {
		throw new Error("RSA decrypt is not available in the provided crypto API.");
	}

	const privateKeyEncryptedData = JSON.parse(
		encryptedPrivateKey,
	) as EncryptedDataLike;
	const privateKeyPem = await crypto.decrypt(
		privateKeyEncryptedData,
		masterUnlockKey,
	);
	const vaultKeyBase64 = await crypto.rsaDecrypt(
		encryptedVaultKey,
		privateKeyPem,
	);
	return base64ToArrayBuffer(vaultKeyBase64);
}

export interface DecryptStoredVaultKeyInput {
	encryptedVaultKey: string;
	email?: string;
	storage: VaultKeyStorageLike;
	crypto: VaultKeyCryptoProvider;
}

export async function decryptStoredVaultKey({
	encryptedVaultKey,
	email,
	storage,
	crypto,
}: DecryptStoredVaultKeyInput): Promise<Uint8Array> {
	const masterUnlockKey = await storage.getMasterUnlockKey(email);
	if (!masterUnlockKey) {
		throw new Error("Master Unlock Key not available. Please log in again.");
	}

	const encryptedPrivateKey = await storage.getEncryptedPrivateKey(email);
	return decryptVaultKey({
		encryptedVaultKey,
		masterUnlockKey,
		encryptedPrivateKey,
		crypto,
	});
}

export interface GetDecryptedVaultKeyInput {
	vaultId: string;
	email?: string;
	storage: VaultKeyStorageLike;
	crypto: VaultKeyCryptoProvider;
}

export async function getDecryptedVaultKey({
	vaultId,
	email,
	storage,
	crypto,
}: GetDecryptedVaultKeyInput): Promise<Uint8Array | null> {
	const vaultKeys = await storage.getVaultKeys(email);
	if (!vaultKeys) {
		return null;
	}

	const entry = vaultKeys.find((vaultKey) => vaultKey.vaultId === vaultId);
	if (!entry) {
		return null;
	}

	return decryptStoredVaultKey({
		encryptedVaultKey: entry.encryptedVaultKey,
		email,
		storage,
		crypto,
	});
}
