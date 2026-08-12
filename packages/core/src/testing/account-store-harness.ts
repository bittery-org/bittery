/**
 * Test-only harness: a **real** `AccountStore` running on the in-memory `PlatformPort`.
 *
 * Not exported from the package (`package.json` has no `./testing` subpath); it exists for
 * co-located `*.test.ts` files only.
 */

import type { KeyRef } from "@bittery/crypto-port";
import {
	createInMemoryCryptoPort,
	type InMemoryCryptoPort,
} from "@bittery/crypto-port/testing";
import {
	type AccountStore,
	createAccountStore,
	createItemCache,
	type ItemCache,
} from "@bittery/storage";
import {
	createInMemoryPlatformPort,
	createInMemoryRecordPort,
	type InMemoryPlatformPort,
	type InMemoryRecordPort,
} from "@bittery/storage/testing";
import type { AccountMetadata } from "@bittery/storage/types";

export interface TestAccountStore {
	store: AccountStore;
	port: InMemoryPlatformPort;
	/**
	 * The store's own crypto port. Every `KeyRef` a test hands to the store has to come from
	 * here — a ref minted anywhere else is rejected, which is the whole point of the type.
	 */
	crypto: InMemoryCryptoPort;
}

export async function createTestAccountStore(opts?: {
	sessionSurvivesRestart?: boolean;
	crypto?: InMemoryCryptoPort;
}): Promise<TestAccountStore> {
	const port = createInMemoryPlatformPort({
		sessionSurvivesRestart: opts?.sessionSurvivesRestart ?? true,
	});
	const crypto = opts?.crypto ?? createInMemoryCryptoPort();
	const store = createAccountStore({ port, crypto });
	await store.initialize();
	return { store, port, crypto };
}

export interface TestItemCache {
	cache: ItemCache;
	port: InMemoryRecordPort;
}

/**
 * A **real** `ItemCache` over the in-memory `RecordPort`.
 *
 * `port.calls.recordPut` is the point of exposing the port: it is how a test proves the
 * O(1) upsert property from the caller's side rather than from inside `packages/storage`.
 */
export async function createTestItemCache(): Promise<TestItemCache> {
	const port = createInMemoryRecordPort();
	const cache = createItemCache({ port });
	await cache.initialize();
	return { cache, port };
}

export function accountMetadata(
	overrides: Partial<AccountMetadata> & { accountId: string },
): AccountMetadata {
	return {
		email: `${overrides.accountId}@test.com`,
		userId: `user-${overrides.accountId}`,
		name: overrides.accountId,
		serverUrl: "https://app.bittery.io",
		secretKeyHint: "ABCD••••",
		addedAt: 1,
		lastActiveAt: 1,
		biometricEnabled: false,
		...overrides,
		insecureTransportConfirmed: overrides.insecureTransportConfirmed ?? false,
	};
}

/** A distinct 32-byte master unlock key per account id. */
export function mukFor(accountId: string): Uint8Array {
	const bytes = new Uint8Array(32);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = (accountId.charCodeAt(i % accountId.length) + i) % 256;
	}
	return bytes;
}

/** The same key behind a `KeyRef`, which is the only form the store now accepts. */
export function mukRefFor(
	crypto: InMemoryCryptoPort,
	accountId: string,
): Promise<KeyRef> {
	return crypto.importKey(mukFor(accountId));
}

/**
 * Seed an account that has a valid, restorable session: metadata in the list, a stored
 * secret key and `session_data` carrying the MUK encrypted under the device key.
 *
 * `unlocked: false` then drops the in-memory MUK, which is exactly the "locked but
 * quick-unlockable" state — `tryRestoreSession` will bring it back.
 *
 * Takes the whole harness rather than just the store: the MUK is a `KeyRef` now, and only
 * the store's own crypto port can mint one it will accept.
 */
export async function seedAccountWithSession(
	{ store, crypto }: Pick<TestAccountStore, "store" | "crypto">,
	metadata: AccountMetadata,
	{ unlocked = true }: { unlocked?: boolean } = {},
): Promise<void> {
	await store.addAccount(metadata);
	await store.storeSecretKey(
		`secret-${metadata.accountId}`,
		metadata.accountId,
	);
	await store.storeAuthToken(`token-${metadata.accountId}`, metadata.accountId);

	const sessionKey = await mukRefFor(crypto, metadata.accountId);
	await store.storeSessionData(
		sessionKey,
		metadata.accountId,
		metadata.email,
		metadata.userId,
	);
	await crypto.destroyKey(sessionKey);

	if (unlocked) {
		await store.setMasterUnlockKey(
			await mukRefFor(crypto, metadata.accountId),
			metadata.accountId,
		);
	}
}
