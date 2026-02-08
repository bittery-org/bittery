import type { VaultKeyData } from "../lib/storage";
import { storage } from "../lib/storage";
import { desktopClient } from "./desktop-client";
import { desktopSync } from "./desktop-sync";
import { handleNativeBiometricUnlockAll } from "./native-messaging";

function isNonEmptyVaultKeys(value: unknown): value is VaultKeyData[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every(
			(item) =>
				typeof item === "object" &&
				item !== null &&
				"vaultId" in item &&
				"encryptedVaultKey" in item,
		)
	);
}

async function isDesktopUnlockedNow(): Promise<boolean> {
	const status =
		desktopSync.getLastStatus() ?? (await desktopSync.checkDesktopStatus());
	return !!(
		status?.available &&
		!status.locked &&
		(status.unlockedAccounts?.length ?? 0) > 0
	);
}

async function hasLocalWriteCapability(email: string): Promise<boolean> {
	const [authToken, vaultKeys, muk] = await Promise.all([
		storage.getAuthToken(email),
		storage.getVaultKeys(email),
		storage.getMasterUnlockKey(email),
	]);

	return !!(
		authToken &&
		muk &&
		Array.isArray(vaultKeys) &&
		vaultKeys.length > 0
	);
}

/**
 * Ensure local extension state has enough account material for write operations
 * while desktop mode is active:
 * - auth token
 * - vault keys
 * - best-effort session/MUK restore from local encrypted session
 */
export async function hydrateDesktopAccountMaterial(
	email: string,
): Promise<void> {
	const normalizedEmail = email.toLowerCase();

	if (!(await isDesktopUnlockedNow())) {
		return;
	}

	// Keep local token in sync (used for account-scoped tRPC clients).
	const localToken = await storage.getAuthToken(normalizedEmail);
	if (!localToken) {
		const desktopToken = await desktopClient.getAuthToken(normalizedEmail);
		if (desktopToken) {
			await storage.storeAuthToken(desktopToken, normalizedEmail);
		}
	}

	// Hydrate vault keys from desktop if missing locally.
	const localVaultKeys = await storage.getVaultKeys(normalizedEmail);
	if (!localVaultKeys || localVaultKeys.length === 0) {
		const vaultKeysResponse = await desktopClient.getVaultKeys(normalizedEmail);
		const rawVaultKeys = vaultKeysResponse?.vault_keys;
		if (rawVaultKeys) {
			try {
				const parsed = JSON.parse(rawVaultKeys);
				if (isNonEmptyVaultKeys(parsed)) {
					await storage.storeVaultKeys(parsed, normalizedEmail);
				}
			} catch (error) {
				console.warn(
					`[desktop-key-material] Failed to parse vault keys for ${normalizedEmail}:`,
					error,
				);
			}
		}
	}

	// Best-effort MUK restore for account-scoped encryption/decryption operations.
	try {
		await storage.tryRestoreSession?.(false, normalizedEmail);
	} catch (error) {
		console.warn(
			`[desktop-key-material] Session restore failed for ${normalizedEmail}:`,
			error,
		);
	}
}

/**
 * Ensure the extension has local key material needed for write operations.
 * In desktop mode this may require a native biometric unlock to hydrate MUK.
 */
export async function ensureDesktopWriteCapability(
	email: string,
): Promise<boolean> {
	const normalizedEmail = email.toLowerCase();

	await hydrateDesktopAccountMaterial(normalizedEmail);
	if (await hasLocalWriteCapability(normalizedEmail)) {
		return true;
	}

	if (!(await isDesktopUnlockedNow())) {
		return false;
	}

	console.log(
		`[desktop-key-material] Local write capability missing for ${normalizedEmail}, forcing native hydration`,
	);

	const unlockResult = await handleNativeBiometricUnlockAll({
		forceLocalUnlock: true,
		preserveActiveAccount: true,
	});
	if (!unlockResult.success) {
		console.warn(
			`[desktop-key-material] Native hydration failed for ${normalizedEmail}:`,
			unlockResult.error,
		);
		return false;
	}

	await hydrateDesktopAccountMaterial(normalizedEmail);
	return hasLocalWriteCapability(normalizedEmail);
}
