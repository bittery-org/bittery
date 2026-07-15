/**
 * Shared one-time migration from email-keyed storage to accountId-keyed storage.
 */

import { ensureAccountIds } from "./account-id";
import {
	ACCOUNT_ID_MIGRATION_FLAG,
	ACCOUNT_STORAGE_SUFFIXES,
	getAccountKey,
	getLegacyAccountKey,
} from "./account-keys";
import type { AccountMetadata, ActiveAccount } from "./types";

export interface KeyValueStore {
	get<T>(key: string): Promise<T | undefined>;
	set(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<void>;
	save?(): Promise<void>;
}

export interface AccountIdMigrationContext {
	store: KeyValueStore;
	activeAccountKey: string;
	accountsListKey: string;
	getAccountsList(): Promise<AccountMetadata[]>;
	saveAccountsList(accounts: AccountMetadata[]): Promise<void>;
	copyKeychainKey?(
		fromAccountId: string,
		toAccountId: string,
		suffix: string,
	): Promise<void>;
	deleteLegacyKeychainKey?(
		fromAccountId: string,
		suffix: string,
	): Promise<void>;
}

function valuesEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	try {
		return JSON.stringify(left) === JSON.stringify(right);
	} catch {
		return false;
	}
}

/**
 * Migrate legacy email-keyed account storage to accountId keys.
 * Safe to call multiple times; no-ops after first successful run.
 */
export async function migrateEmailKeysToAccountIds(
	ctx: AccountIdMigrationContext,
): Promise<void> {
	const alreadyMigrated = await ctx.store.get<boolean>(
		ACCOUNT_ID_MIGRATION_FLAG,
	);
	if (alreadyMigrated) {
		return;
	}

	const storedActive = await ctx.store.get<string>(ctx.activeAccountKey);
	let accounts = await ctx.getAccountsList();
	accounts = ensureAccountIds(accounts);

	// Backfill immutable server identity before the account-ID checkpoint.
	for (const account of accounts) {
		if (account.serverUrl) continue;
		const legacyServerUrl = await ctx.store.get<string>(
			getLegacyAccountKey(account.email.toLowerCase(), "server_url"),
		);
		if (legacyServerUrl) {
			account.serverUrl = legacyServerUrl.replace(/\/$/, "");
		}
	}

	let convertedActive = storedActive;
	if (storedActive && storedActive !== "all") {
		const alreadyAccountId = accounts.some(
			(account) => account.accountId === storedActive,
		);
		if (!alreadyAccountId) {
			const matches = accounts.filter(
				(account) => account.email.toLowerCase() === storedActive.toLowerCase(),
			);
			if (matches.length > 1) {
				throw new Error(
					`Ambiguous legacy active account for email ${storedActive}`,
				);
			}
			const match = matches[0];
			if (match) {
				convertedActive = match.accountId;
			}
		}
	}

	// Durable identity checkpoint. No legacy source is touched before this save.
	await ctx.saveAccountsList(accounts);
	if (convertedActive !== undefined) {
		await ctx.store.set(ctx.activeAccountKey, convertedActive);
	}
	await ctx.store.save?.();

	// Legacy storage is keyed purely by email, so multiple accounts sharing the
	// same email (the same user signed in to different servers) all resolve to
	// the SAME legacy keys. That data was already blended in the legacy scheme
	// and cannot be disambiguated per-server. Copying the single shared legacy
	// value into every account would cross-contaminate secrets/sessions (M2), so
	// we skip the per-email copy for ambiguous accounts and let them
	// re-authenticate. The orphaned legacy keys are still cleaned up below.
	const accountsPerEmail = new Map<string, number>();
	for (const account of accounts) {
		const email = account.email.toLowerCase();
		accountsPerEmail.set(email, (accountsPerEmail.get(email) ?? 0) + 1);
	}

	// Copy all store and keychain values non-destructively.
	for (const account of accounts) {
		const legacyEmail = account.email.toLowerCase();
		if ((accountsPerEmail.get(legacyEmail) ?? 0) > 1) {
			// Ambiguous same-email account: do not inherit shared legacy secrets.
			continue;
		}
		for (const suffix of ACCOUNT_STORAGE_SUFFIXES) {
			const legacyKey = getLegacyAccountKey(legacyEmail, suffix);
			const newKey = getAccountKey(account.accountId, suffix);

			const value = await ctx.store.get<unknown>(legacyKey);
			if (value !== undefined) {
				await ctx.store.set(newKey, value);
				const copied = await ctx.store.get<unknown>(newKey);
				if (!valuesEqual(value, copied)) {
					throw new Error(`Failed to verify migrated value for ${newKey}`);
				}
			}

			if (suffix === "jwt_token" && ctx.copyKeychainKey) {
				await ctx.copyKeychainKey(legacyEmail, account.accountId, suffix);
			}
		}
	}

	// Cleanup is last. A crash here is safe because every destination exists.
	for (const account of accounts) {
		const legacyEmail = account.email.toLowerCase();
		for (const suffix of ACCOUNT_STORAGE_SUFFIXES) {
			const legacyKey = getLegacyAccountKey(legacyEmail, suffix);
			if ((await ctx.store.get(legacyKey)) !== undefined) {
				await ctx.store.delete(legacyKey);
			}
			if (suffix === "jwt_token" && ctx.deleteLegacyKeychainKey) {
				await ctx.deleteLegacyKeychainKey(legacyEmail, suffix);
			}
		}
	}

	await ctx.store.set(ACCOUNT_ID_MIGRATION_FLAG, true);
	if (ctx.store.save) {
		await ctx.store.save();
	}
}

/** Parse stored active account value into ActiveAccount type. */
export function parseStoredActiveAccount(
	stored: string | undefined | null,
): ActiveAccount {
	if (!stored) {
		return null;
	}
	if (stored === "all") {
		return { type: "all" };
	}
	return { type: "single", accountId: stored };
}

/** Serialize ActiveAccount for storage. */
export function serializeActiveAccount(account: ActiveAccount): string | null {
	if (!account) {
		return null;
	}
	if (account.type === "all") {
		return "all";
	}
	return account.accountId;
}
