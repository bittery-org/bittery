/**
 * Test-only harness: a **real** `AccountStore` running on the in-memory `PlatformPort`.
 *
 * Not exported from the package (`package.json` has no `./testing` subpath); it exists for
 * co-located `*.test.ts` files only.
 */

import {
	arrayBufferToBase64,
	base64ToArrayBuffer,
} from "@bittery/shared/crypto";
import {
	type AccountStore,
	type CryptoProvider,
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

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Identifies which key a ciphertext was produced under, so decrypt can reject others. */
const keyId = (key: Uint8Array): string => arrayBufferToBase64(key);

/**
 * Reversible, deliberately not-real crypto. Mirrors the fake in
 * `packages/storage/src/account-store.test.ts` so both packages exercise the store the
 * same way.
 */
export function createTestCryptoProvider(): CryptoProvider {
	return {
		encrypt: async (plaintext, key) => ({
			ciphertext: arrayBufferToBase64(textEncoder.encode(plaintext)),
			iv: keyId(key),
			algorithm: "fake",
		}),
		decrypt: async (data, key) => {
			if (data.algorithm !== "fake") {
				throw new Error(`unsupported algorithm ${data.algorithm}`);
			}
			if (data.iv !== keyId(key)) {
				throw new Error("wrong key");
			}
			return textDecoder.decode(base64ToArrayBuffer(data.ciphertext));
		},
		rsaDecrypt: async () => {
			throw new Error("not used in core tests");
		},
	};
}

export interface TestAccountStore {
	store: AccountStore;
	port: InMemoryPlatformPort;
}

export async function createTestAccountStore(opts?: {
	sessionSurvivesRestart?: boolean;
	crypto?: CryptoProvider;
}): Promise<TestAccountStore> {
	const port = createInMemoryPlatformPort({
		sessionSurvivesRestart: opts?.sessionSurvivesRestart ?? true,
	});
	const store = createAccountStore({
		port,
		crypto: opts?.crypto ?? createTestCryptoProvider(),
	});
	await store.initialize();
	return { store, port };
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

/**
 * Seed an account that has a valid, restorable session: metadata in the list, a stored
 * secret key and `session_data` carrying the MUK encrypted under the device key.
 *
 * `unlocked: false` then drops the in-memory MUK, which is exactly the "locked but
 * quick-unlockable" state — `tryRestoreSession` will bring it back.
 */
export async function seedAccountWithSession(
	store: AccountStore,
	metadata: AccountMetadata,
	{ unlocked = true }: { unlocked?: boolean } = {},
): Promise<void> {
	await store.addAccount(metadata);
	await store.storeSecretKey(
		`secret-${metadata.accountId}`,
		metadata.accountId,
	);
	await store.storeAuthToken(`token-${metadata.accountId}`, metadata.accountId);
	await store.storeSessionData(
		mukFor(metadata.accountId),
		metadata.accountId,
		metadata.email,
		metadata.userId,
	);
	await store.setMasterUnlockKey(
		mukFor(metadata.accountId),
		metadata.accountId,
	);
	if (!unlocked) {
		await store.clearMasterUnlockKey(metadata.accountId);
	}
}
