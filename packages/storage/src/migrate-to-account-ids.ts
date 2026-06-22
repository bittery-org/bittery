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
	migrateKeychainKey?(
		fromAccountId: string,
		toAccountId: string,
		suffix: string,
	): Promise<void>;
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

	let accounts = await ctx.getAccountsList();
	accounts = ensureAccountIds(accounts);

	// Rewrite per-account storage keys from email namespace to accountId namespace
	for (const account of accounts) {
		const legacyEmail = account.email.toLowerCase();
		for (const suffix of ACCOUNT_STORAGE_SUFFIXES) {
			const legacyKey = getLegacyAccountKey(legacyEmail, suffix);
			const newKey = getAccountKey(account.accountId, suffix);

			const value = await ctx.store.get<unknown>(legacyKey);
			if (value !== undefined) {
				await ctx.store.set(newKey, value);
				await ctx.store.delete(legacyKey);
			}

			if (suffix === "jwt_token" && ctx.migrateKeychainKey) {
				await ctx.migrateKeychainKey(legacyEmail, account.accountId, suffix);
			}
		}
	}

	await ctx.saveAccountsList(accounts);

	// Migrate active account pointer
	const storedActive = await ctx.store.get<string>(ctx.activeAccountKey);
	if (storedActive && storedActive !== "all") {
		const match = accounts.find(
			(a) => a.email.toLowerCase() === storedActive.toLowerCase(),
		);
		if (match) {
			await ctx.store.set(ctx.activeAccountKey, match.accountId);
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
