/**
 * Hydrate extension local account material from desktop while desktop mode is active.
 * Storage and desktop IPC are both scoped by accountId.
 */

import type { VaultKeyData } from "../lib/storage";
import { storage } from "../lib/storage";
import { desktopClient } from "./desktop-client";
import { isDesktopUnlockedNow } from "./desktop-status";
import { handleNativeBiometricUnlockAll } from "./native-messaging";
import { resolveAccountIdFromEmail } from "./services/account-resolution";

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

async function hasLocalWriteCapability(accountId: string): Promise<boolean> {
	const [authToken, vaultKeys, muk] = await Promise.all([
		storage.getAuthToken(accountId),
		storage.getVaultKeys(accountId),
		storage.getMasterUnlockKey(accountId),
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
	const accountId = await resolveAccountIdFromEmail(normalizedEmail);
	if (!accountId) {
		return;
	}

	if (!(await isDesktopUnlockedNow())) {
		return;
	}

	const localToken = await storage.getAuthToken(accountId);
	if (!localToken) {
		const desktopToken = await desktopClient.getAuthToken(accountId);
		if (desktopToken) {
			await storage.storeAuthToken(desktopToken, accountId);
		}
	}

	const localVaultKeys = await storage.getVaultKeys(accountId);
	if (!localVaultKeys || localVaultKeys.length === 0) {
		const vaultKeysResponse = await desktopClient.getVaultKeys(accountId);
		const rawVaultKeys = vaultKeysResponse?.vaultKeys;
		if (rawVaultKeys) {
			try {
				const parsed = JSON.parse(rawVaultKeys);
				if (isNonEmptyVaultKeys(parsed)) {
					await storage.storeVaultKeys(parsed, accountId);
				}
			} catch (error) {
				console.warn(
					`[desktop-key-material] Failed to parse vault keys for ${normalizedEmail}:`,
					error,
				);
			}
		}
	}

	try {
		await storage.tryRestoreSession(false, accountId);
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
	options?: {
		allowBiometricPrompt?: boolean;
	},
): Promise<boolean> {
	const normalizedEmail = email.toLowerCase();
	const accountId = await resolveAccountIdFromEmail(normalizedEmail);
	if (!accountId) {
		return false;
	}

	const allowBiometricPrompt = options?.allowBiometricPrompt ?? true;

	await hydrateDesktopAccountMaterial(normalizedEmail);
	if (await hasLocalWriteCapability(accountId)) {
		return true;
	}

	if (!(await isDesktopUnlockedNow())) {
		return false;
	}

	if (!allowBiometricPrompt) {
		return false;
	}

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
	return hasLocalWriteCapability(accountId);
}
