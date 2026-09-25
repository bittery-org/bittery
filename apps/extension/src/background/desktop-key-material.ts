/**
 * Hydrate extension local account material from desktop while desktop mode is active.
 * Storage and desktop IPC are both scoped by accountId.
 */

import type { VaultKeyData } from "../lib/storage";
import { storage } from "../lib/storage";
import { desktopClient } from "./desktop-client";
import { isDesktopUnlockedNow } from "./desktop-status";
import { handleNativeBiometricUnlockAll } from "./native-messaging";
import {
	nativeMessagingClient,
	RetiredNativeDeliveryError,
} from "./native-messaging-client";

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
	accountId: string,
): Promise<void> {
	const generation = await nativeMessagingClient.captureDeliveryGeneration();
	const account = await storage.getAccountMetadata(accountId);
	nativeMessagingClient.assertCurrentDelivery(generation);
	if (!account) {
		return;
	}

	if (!(await isDesktopUnlockedNow())) {
		return;
	}
	nativeMessagingClient.assertCurrentDelivery(generation);

	const localToken = await storage.getAuthToken(accountId);
	if (!localToken) {
		const desktopToken = await desktopClient.getAuthToken(accountId);
		if (desktopToken) {
			await nativeMessagingClient.withMaterialMutation(
				generation,
				accountId,
				async (check, markMaterialWrite) => {
					markMaterialWrite();
					await storage.storeAuthToken(desktopToken, accountId);
					check();
				},
			);
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
					await nativeMessagingClient.withMaterialMutation(
						generation,
						accountId,
						async (check, markMaterialWrite) => {
							markMaterialWrite();
							await storage.storeVaultKeys(parsed, accountId);
							check();
						},
					);
				}
			} catch (error) {
				if (error instanceof RetiredNativeDeliveryError) return;
				console.warn(
					`[desktop-key-material] Failed to parse vault keys for ${accountId}:`,
					error,
				);
			}
		}
	}

	try {
		await nativeMessagingClient.withMaterialMutation(
			generation,
			accountId,
			async (check, markMaterialWrite) => {
				const alreadyUnlocked = !!(await storage.getMasterUnlockKey(accountId));
				if (!alreadyUnlocked) markMaterialWrite();
				const restored = await storage.tryRestoreSession(false, accountId);
				check();
				return restored && !alreadyUnlocked;
			},
			undefined,
			(restoredNewMaterial) => restoredNewMaterial,
		);
	} catch (error) {
		if (error instanceof RetiredNativeDeliveryError) return;
		console.warn(
			`[desktop-key-material] Session restore failed for ${accountId}:`,
			error,
		);
	}
}

/**
 * Ensure the extension has local key material needed for write operations.
 * In desktop mode this may require a native biometric unlock to hydrate MUK.
 */
export async function ensureDesktopWriteCapability(
	accountId: string,
	options?: {
		allowBiometricPrompt?: boolean;
	},
): Promise<boolean> {
	if (!(await storage.getAccountMetadata(accountId))) {
		return false;
	}

	const allowBiometricPrompt = options?.allowBiometricPrompt ?? true;

	await hydrateDesktopAccountMaterial(accountId);
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
			`[desktop-key-material] Native hydration failed for ${accountId}:`,
			unlockResult.error,
		);
		return false;
	}

	await hydrateDesktopAccountMaterial(accountId);
	return hasLocalWriteCapability(accountId);
}
