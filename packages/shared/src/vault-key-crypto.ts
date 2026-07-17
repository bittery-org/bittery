import { base64ToArrayBuffer } from "./crypto";

interface EncryptedDataLike {
	ciphertext: string;
	iv: string;
	algorithm: string;
}

export interface VaultKeyCryptoProvider {
	decrypt(
		encryptedData: EncryptedDataLike,
		key: Uint8Array,
		context?: VaultKeyEncryptionContext,
	): Promise<string>;
	rsaDecrypt?(ciphertext: string, privateKeyPem: string): Promise<string>;
}

export interface VaultKeyEncryptionContext {
	vaultId: string;
	entityId: string;
	entityType: "vault_key";
	version: number;
	userId: string;
}

export const VAULT_KEY_WRAP_PURPOSE = "vault-key-wrap";

export interface VaultKeyWrapContext {
	vaultId: string;
	userId: string;
	keyVersion: number;
	purpose: typeof VAULT_KEY_WRAP_PURPOSE;
}

export interface WrappedVaultKeyLike extends EncryptedDataLike {
	context?: VaultKeyWrapContext;
}

export function buildVaultKeyEncryptionContext(input: {
	vaultId: string;
	userId: string;
	keyVersion: number;
}): VaultKeyEncryptionContext {
	return {
		vaultId: input.vaultId,
		entityId: VAULT_KEY_WRAP_PURPOSE,
		entityType: "vault_key",
		version: input.keyVersion,
		userId: input.userId,
	};
}

export function buildVaultKeyWrapContext(input: {
	vaultId: string;
	userId: string;
	keyVersion: number;
}): VaultKeyWrapContext {
	return {
		vaultId: input.vaultId,
		userId: input.userId,
		keyVersion: input.keyVersion,
		purpose: VAULT_KEY_WRAP_PURPOSE,
	};
}

export function attachVaultKeyWrapContext<T extends EncryptedDataLike>(
	encryptedData: T,
	input: {
		vaultId: string;
		userId: string;
		keyVersion: number;
	},
): T & { context: VaultKeyWrapContext } {
	return {
		...encryptedData,
		context: buildVaultKeyWrapContext(input),
	};
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
	expectedVaultId?: string;
	expectedUserId?: string;
	crypto: VaultKeyCryptoProvider;
}

export interface VaultKeyStorageLike {
	getVaultKeys(
		accountId?: string,
	): Promise<Array<{ vaultId: string; encryptedVaultKey: string }> | null>;
	getMasterUnlockKey(accountId?: string): Promise<Uint8Array | null>;
	getEncryptedPrivateKey(accountId?: string): Promise<string | null>;
	getStoredSessionData?(accountId?: string): Promise<{ userId: string } | null>;
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
	expectedVaultId,
	expectedUserId,
	crypto,
}: DecryptVaultKeyInput): Promise<Uint8Array> {
	if (isAesEncryptedVaultKey(encryptedVaultKey)) {
		const wrapped = JSON.parse(encryptedVaultKey) as WrappedVaultKeyLike;
		const encryptedData: EncryptedDataLike = {
			ciphertext: wrapped.ciphertext,
			iv: wrapped.iv,
			algorithm: wrapped.algorithm,
		};
		const wrapContext = wrapped.context;
		if (!wrapContext) {
			throw new Error("Missing vault key wrap context");
		}
		if (wrapContext.purpose !== VAULT_KEY_WRAP_PURPOSE) {
			throw new Error("Invalid vault key wrap purpose");
		}
		if (
			!Number.isInteger(wrapContext.keyVersion) ||
			wrapContext.keyVersion < 1
		) {
			throw new Error("Invalid vault key wrap version");
		}
		if (expectedVaultId && wrapContext.vaultId !== expectedVaultId) {
			throw new Error("Vault key wrap vault mismatch");
		}
		if (expectedUserId && wrapContext.userId !== expectedUserId) {
			throw new Error("Vault key wrap user mismatch");
		}
		const encryptionContext = buildVaultKeyEncryptionContext({
			vaultId: wrapContext.vaultId,
			userId: wrapContext.userId,
			keyVersion: wrapContext.keyVersion,
		});
		const decryptedBase64 = await crypto.decrypt(
			encryptedData,
			masterUnlockKey,
			encryptionContext,
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
	vaultId?: string;
	userId?: string;
	accountId?: string;
	storage: VaultKeyStorageLike;
	crypto: VaultKeyCryptoProvider;
}

export async function decryptStoredVaultKey({
	encryptedVaultKey,
	vaultId,
	userId,
	accountId,
	storage,
	crypto,
}: DecryptStoredVaultKeyInput): Promise<Uint8Array> {
	const masterUnlockKey = await storage.getMasterUnlockKey(accountId);
	if (!masterUnlockKey) {
		throw new Error("Master Unlock Key not available. Please log in again.");
	}

	const encryptedPrivateKey = await storage.getEncryptedPrivateKey(accountId);
	const resolvedUserId =
		userId ??
		(await storage.getStoredSessionData?.(accountId))?.userId ??
		undefined;
	return decryptVaultKey({
		encryptedVaultKey,
		masterUnlockKey,
		encryptedPrivateKey,
		expectedVaultId: vaultId,
		expectedUserId: resolvedUserId,
		crypto,
	});
}

export interface GetDecryptedVaultKeyInput {
	vaultId: string;
	userId?: string;
	accountId?: string;
	storage: VaultKeyStorageLike;
	crypto: VaultKeyCryptoProvider;
}

export async function getDecryptedVaultKey({
	vaultId,
	userId,
	accountId,
	storage,
	crypto,
}: GetDecryptedVaultKeyInput): Promise<Uint8Array | null> {
	const vaultKeys = await storage.getVaultKeys(accountId);
	if (!vaultKeys) {
		return null;
	}

	const entry = vaultKeys.find((vaultKey) => vaultKey.vaultId === vaultId);
	if (!entry) {
		return null;
	}

	return decryptStoredVaultKey({
		encryptedVaultKey: entry.encryptedVaultKey,
		vaultId,
		userId,
		accountId,
		storage,
		crypto,
	});
}
