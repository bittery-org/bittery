/**
 * After a password unlock, prepare Android autofill so "Unlock Bittery" in
 * Chrome can show a system biometric sheet instead of launching the app.
 *
 * Two native facts have to move with the password:
 *
 * 1. The last-password timestamp. `MukEscrowManager.canUseBiometricUnlock`
 *    treats a missing stamp as "re-entry required", so autofill would bounce
 *    to the app even with a valid escrow.
 * 2. A biometric escrow of the MUK. Auto-lock and a manual lock drop the
 *    in-memory key; the escrow is what AutofillAuthActivity unwraps.
 *
 * Wrap is silent (RSA public key). It runs whenever biometric unlock is on.
 * A failure must not fail the unlock — autofill then falls back to opening
 * the app.
 *
 * Escrow lifetime is the master-password re-entry period, not auto-lock.
 * Auto-lock only drops the in-memory key. The escrow has to survive a lock
 * so the keyboard bar can unlock again.
 */

import { credentialProvider as CredentialProvider } from "./credential-provider";
import type { EscrowMukParams } from "./credential-provider.types";
import { mirrorBorrowedMasterUnlockKeysToCredentialProvider } from "./credential-provider-master-unlock-key";
import type { StoredSessionData } from "./storage";
import { storage } from "./storage";

export interface PasswordUnlockCredentialProvider {
	updateLastMasterPasswordEntry(): Promise<boolean>;
	escrowMukWithBiometric(params: EscrowMukParams): Promise<boolean>;
}

export interface PasswordUnlockStorage {
	isBiometricEnabled(accountId: string): Promise<boolean>;
	getStoredSessionData(accountId: string): Promise<StoredSessionData | null>;
	getMasterPasswordReentryPeriodMs(): Promise<number>;
}

export function shouldEscrowAfterUnlock(input: {
	biometricEnabled: boolean;
	email: string | null | undefined;
	userId: string | null | undefined;
}): boolean {
	return (
		input.biometricEnabled && Boolean(input.email) && Boolean(input.userId)
	);
}

export async function prepareCredentialProviderAfterUnlock(
	accountIds: readonly string[],
	deps?: {
		mirror?: (accountIds: readonly string[]) => Promise<void>;
		provider?: PasswordUnlockCredentialProvider;
		storage?: PasswordUnlockStorage;
		recordPasswordEntry?: boolean;
	},
): Promise<void> {
	const mirror =
		deps?.mirror ?? mirrorBorrowedMasterUnlockKeysToCredentialProvider;
	const provider = deps?.provider ?? CredentialProvider;
	const store = deps?.storage ?? storage;
	const recordPasswordEntry = deps?.recordPasswordEntry ?? false;

	await mirror(accountIds);

	// Do not gate on `isAvailable()` — that is the Android 14 Credential
	// Manager probe. Autofill and MUK escrow both work from API 26. A
	// missing plugin rejects the mutating commands; that is the real stop.
	if (recordPasswordEntry) {
		try {
			await provider.updateLastMasterPasswordEntry();
		} catch (error) {
			console.warn(
				"[CredentialProvider] Failed to record the master-password stamp",
				error,
			);
		}
	}

	for (const accountId of accountIds) {
		const [biometricEnabled, session] = await Promise.all([
			store.isBiometricEnabled(accountId),
			store.getStoredSessionData(accountId),
		]);
		const email = session?.email;
		const userId = session?.userId;
		if (
			!shouldEscrowAfterUnlock({
				biometricEnabled,
				email,
				userId,
			}) ||
			!email ||
			!userId
		) {
			continue;
		}

		try {
			const timeoutMs = await store.getMasterPasswordReentryPeriodMs();
			await provider.escrowMukWithBiometric({
				email,
				accountId,
				userId,
				timeoutMs,
			});
		} catch (error) {
			console.warn(
				"[CredentialProvider] Escrow after unlock did not complete",
				error,
			);
		}
		// Native escrow is a single slot. The first account that qualifies owns it.
		break;
	}
}

/** Password unlock: stamp the native clock, then wrap the MUK. */
export function prepareCredentialProviderAfterPasswordUnlock(
	accountIds: readonly string[],
	deps?: {
		mirror?: (accountIds: readonly string[]) => Promise<void>;
		provider?: PasswordUnlockCredentialProvider;
		storage?: PasswordUnlockStorage;
	},
): Promise<void> {
	return prepareCredentialProviderAfterUnlock(accountIds, {
		...deps,
		recordPasswordEntry: true,
	});
}
