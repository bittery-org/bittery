import { describe, expect, it } from "bun:test";
import type { KeyRef } from "@bittery/crypto-port";
import {
	createInMemoryCryptoPort,
	type InMemoryCryptoPort,
} from "@bittery/crypto-port/testing";
import { arrayBufferToBase64 } from "@bittery/shared/crypto";
import {
	type AccountStore,
	createAccountStore,
	NATIVE_VIEW_VERSION,
	type NativeHostView,
} from "./account-store";
import { accountKey, globalKey, metaCollection } from "./keys";
import {
	createInMemoryPlatformPort,
	type InMemoryPlatformPort,
} from "./testing/in-memory-port";
import {
	type AccountMetadata,
	BIOMETRIC_GRACE_PERIOD_MS,
	DEFAULT_AUTO_LOCK_TIMEOUT_MS,
	DEFAULT_SESSION_EXPIRY_MS,
	MASTER_PASSWORD_REENTRY_PERIOD_MS,
} from "./types";

// ============================================================================
// Harness
// ============================================================================

interface Harness {
	port: InMemoryPlatformPort;
	crypto: InMemoryCryptoPort;
	store: AccountStore;
	/**
	 * Live refs over the two fixed key values, minted by the same crypto port the store
	 * holds — a ref from anywhere else would be rejected, which is the point of `KeyRef`.
	 */
	muk: KeyRef;
	otherMuk: KeyRef;
}

async function makeStore(opts?: {
	sessionSurvivesRestart?: boolean;
	crypto?: InMemoryCryptoPort;
}): Promise<Harness> {
	const port = createInMemoryPlatformPort({
		sessionSurvivesRestart: opts?.sessionSurvivesRestart ?? false,
	});
	const crypto = opts?.crypto ?? createInMemoryCryptoPort();
	const store = createAccountStore({ port, crypto });
	await store.initialize();
	return {
		port,
		crypto,
		store,
		muk: await crypto.importKey(MUK_BYTES),
		otherMuk: await crypto.importKey(OTHER_MUK_BYTES),
	};
}

function metadataFor(accountId: string): AccountMetadata {
	return {
		accountId,
		email: `${accountId}@example.com`,
		userId: `user-${accountId}`,
		name: accountId,
		serverUrl: "https://api.example.com",
		secretKeyHint: "hint",
		addedAt: 1,
		lastActiveAt: 1,
		biometricEnabled: false,
	};
}

async function seedAccount(
	store: AccountStore,
	accountId: string,
	{ active = false }: { active?: boolean } = {},
): Promise<void> {
	await store.addAccount(metadataFor(accountId));
	if (active) {
		await store.setActiveAccount(accountId);
	}
}

function nativeView(port: InMemoryPlatformPort): NativeHostView {
	const raw = port.snapshot().device.bittery_native_view;
	if (raw === undefined) {
		throw new Error("native view has not been published");
	}
	return JSON.parse(raw) as NativeHostView;
}

const MUK_BYTES = new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1));
const OTHER_MUK_BYTES = new Uint8Array(
	Array.from({ length: 32 }, (_, i) => 200 - i),
);

/** Advance the wall clock far enough that a zero-length period has provably elapsed. */
const tick = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 5));

/**
 * The store speaks `KeyRef`, so a test that wants to compare key *material* has to ask the
 * crypto port to export it. This is the only place these tests look behind a ref.
 */
async function bytesOf(
	crypto: InMemoryCryptoPort,
	key: KeyRef | null,
): Promise<number[]> {
	return key === null ? [] : Array.from(await crypto.exportKey(key));
}

const bytes = (key: Uint8Array): number[] => Array.from(key);

// ============================================================================
// accountId namespacing
// ============================================================================

describe("AccountStore — accountId namespacing", () => {
	it("migrates legacy account metadata to denied insecure transport", async () => {
		const port = createInMemoryPlatformPort();
		const legacyAccount = metadataFor("legacy");
		await port.kvSet(
			globalKey("accounts_list"),
			JSON.stringify({ accounts: [legacyAccount] }),
			"device",
		);
		const store = createAccountStore({
			port,
			crypto: createInMemoryCryptoPort(),
		});
		await store.initialize();

		expect((await store.getAccountsList())[0]?.insecureTransportConfirmed).toBe(
			false,
		);
		const persisted = JSON.parse(
			port.snapshot().device[globalKey("accounts_list")] ?? "null",
		) as { version: number; accounts: AccountMetadata[] };
		expect(persisted.version).toBe(2);
		expect(persisted.accounts[0]?.insecureTransportConfirmed).toBe(false);
	});

	it("never lets two accounts see each other's values", async () => {
		const { store } = await makeStore();
		await seedAccount(store, "a");
		await seedAccount(store, "b");

		await store.storeServerUrl("https://a.example.com", "a");
		await store.storeServerUrl("https://b.example.com", "b");
		await store.storeSecretKey("secret-a", "a");
		await store.storeSecretKey("secret-b", "b");

		expect(await store.getServerUrl("a")).toBe("https://a.example.com");
		expect(await store.getServerUrl("b")).toBe("https://b.example.com");
		expect(await store.getStoredSecretKey("a")).toBe("secret-a");
		expect(await store.getStoredSecretKey("b")).toBe("secret-b");
	});

	it("resolves the active account when accountId is omitted", async () => {
		const { store } = await makeStore();
		await seedAccount(store, "a");
		await seedAccount(store, "b", { active: true });

		await store.storeServerUrl("https://active.example.com");

		expect(await store.getServerUrl("b")).toBe("https://active.example.com");
		expect(await store.getServerUrl("a")).toBeNull();
		expect(await store.getServerUrl()).toBe("https://active.example.com");
	});

	it("follows the active account when it changes", async () => {
		const { store } = await makeStore();
		await seedAccount(store, "a", { active: true });
		await seedAccount(store, "b");
		await store.storeServerUrl("https://a.example.com");

		await store.setActiveAccount("b");
		await store.storeServerUrl("https://b.example.com");

		expect(await store.getServerUrl()).toBe("https://b.example.com");
		expect(await store.getServerUrl("a")).toBe("https://a.example.com");
	});

	it("throws a clear error when a write needs an account and there is none", async () => {
		const { store, muk } = await makeStore();

		expect(store.storeServerUrl("https://nobody.example.com")).rejects.toThrow(
			/No account specified/,
		);
		expect(store.storeSecretKey("secret")).rejects.toThrow(
			/No account specified/,
		);
		expect(store.setMasterUnlockKey(muk)).rejects.toThrow(
			/No account specified/,
		);
	});

	it("returns null from reads when there is no account, rather than throwing", async () => {
		const { store } = await makeStore();

		expect(await store.getServerUrl()).toBeNull();
		expect(await store.getStoredSecretKey()).toBeNull();
		expect(await store.getMasterUnlockKey()).toBeNull();
		expect(await store.getStoredSessionData()).toBeNull();
		expect(await store.isSessionValid()).toBe(false);
	});
});

// ============================================================================
// The routing rule
// ============================================================================

describe("AccountStore — tier routing", () => {
	it("puts a session-bound secret in session scope where sessions die, and drops it on restart", async () => {
		const { port, store } = await makeStore({ sessionSurvivesRestart: false });
		await seedAccount(store, "a", { active: true });

		await store.storeAuthToken("jwt-value");

		const snapshot = port.snapshot();
		const key = accountKey("a", "jwt_token");
		expect(snapshot.session[key]).toBe("jwt-value");
		expect(snapshot.device[key]).toBeUndefined();
		expect(snapshot.secrets[key]).toBeUndefined();

		port.simulateRestart();

		expect(await store.getAuthToken("a")).toBeNull();
	});

	it("puts the same value in the secret store where sessions survive, and keeps it", async () => {
		const { port, store } = await makeStore({ sessionSurvivesRestart: true });
		await seedAccount(store, "a", { active: true });

		await store.storeAuthToken("jwt-value");

		const snapshot = port.snapshot();
		const key = accountKey("a", "jwt_token");
		expect(snapshot.secrets[key]).toBe("jwt-value");
		expect(snapshot.session[key]).toBeUndefined();
		expect(snapshot.device[key]).toBeUndefined();

		port.simulateRestart();

		expect(await store.getAuthToken("a")).toBe("jwt-value");
	});

	it("routes vault_keys the same way jwt_token is routed", async () => {
		const ephemeral = await makeStore({ sessionSurvivesRestart: false });
		await seedAccount(ephemeral.store, "a", { active: true });
		await ephemeral.store.storeVaultKeys([]);

		const durable = await makeStore({ sessionSurvivesRestart: true });
		await seedAccount(durable.store, "a", { active: true });
		await durable.store.storeVaultKeys([]);

		const key = accountKey("a", "vault_keys");
		expect(ephemeral.port.snapshot().session[key]).toBe("[]");
		expect(durable.port.snapshot().secrets[key]).toBe("[]");
	});

	it("keeps device-bound plain settings in device kv on every platform", async () => {
		const { port, store } = await makeStore({ sessionSurvivesRestart: false });
		await seedAccount(store, "a", { active: true });

		await store.storeServerUrl("https://a.example.com");

		const key = accountKey("a", "server_url");
		expect(port.snapshot().device[key]).toBe("https://a.example.com");

		port.simulateRestart();

		expect(await store.getServerUrl("a")).toBe("https://a.example.com");
	});

	it("keeps device-bound secrets in the secret store even on ephemeral platforms", async () => {
		const { port, store } = await makeStore({ sessionSurvivesRestart: false });
		await seedAccount(store, "a", { active: true });

		await store.storeSecretKey("secret-a");

		expect(port.snapshot().secrets[accountKey("a", "secret_key")]).toBe(
			"secret-a",
		);
	});
});

// ============================================================================
// Session expiry
// ============================================================================

describe("AccountStore — session expiry", () => {
	async function withSession(expiresAt?: number | string | Date) {
		const harness = await makeStore();
		await seedAccount(harness.store, "a", { active: true });
		await harness.store.storeAuthToken("jwt-value");
		await harness.store.storeSessionData(
			harness.muk,
			"a",
			"A@Example.com",
			"user-a",
			expiresAt,
			"session-1",
		);
		return harness;
	}

	it("prefers serverExpiresAt over expiresAt", async () => {
		const { store } = await withSession(-1000);

		const session = await store.getStoredSessionData();
		expect(session).not.toBeNull();
		// The device-local expiry is still 14 days out...
		expect(session?.expiresAt).toBeGreaterThan(Date.now());
		// ...but the server's opinion, which is in the past, wins.
		expect(session?.serverExpiresAt).toBeLessThan(Date.now());
		expect(await store.isSessionValid()).toBe(false);
	});

	it("treats a live server expiry as valid", async () => {
		const { store } = await withSession(60_000);

		const session = await store.getStoredSessionData();
		expect(session?.serverExpiresAt).toBeGreaterThan(Date.now());
		expect(await store.isSessionValid()).toBe(true);
	});

	it("falls back to DEFAULT_SESSION_EXPIRY_MS when no expiry is supplied", async () => {
		const { store } = await withSession(undefined);

		const session = await store.getStoredSessionData();
		expect(session).not.toBeNull();
		const createdAt = session?.createdAt ?? 0;
		expect(session?.expiresAt).toBe(createdAt + DEFAULT_SESSION_EXPIRY_MS);
		expect(session?.serverExpiresAt).toBe(
			createdAt + DEFAULT_SESSION_EXPIRY_MS,
		);
		expect(await store.isSessionValid()).toBe(true);
	});

	it("treats a small number as a relative duration", async () => {
		const { store } = await withSession(60_000);

		const session = await store.getStoredSessionData();
		expect(session?.serverExpiresAt).toBe((session?.createdAt ?? 0) + 60_000);
	});

	it("treats a large number as an absolute timestamp", async () => {
		const absolute = Date.now() + 5 * 60 * 1000;
		const { store } = await withSession(absolute);

		const session = await store.getStoredSessionData();
		expect(session?.serverExpiresAt).toBe(absolute);
	});

	it("accepts ISO strings and Dates", async () => {
		const target = new Date(Date.now() + 3 * 60 * 1000);

		const iso = await withSession(target.toISOString());
		expect((await iso.store.getStoredSessionData())?.serverExpiresAt).toBe(
			target.getTime(),
		);

		const date = await withSession(target);
		expect((await date.store.getStoredSessionData())?.serverExpiresAt).toBe(
			target.getTime(),
		);
	});

	it("is invalid without an auth token even when unexpired", async () => {
		const { store, muk } = await makeStore();
		await seedAccount(store, "a", { active: true });
		await store.storeSessionData(muk, "a", "a@example.com", "user-a");

		expect(await store.isSessionValid()).toBe(false);
		expect(await store.isAuthenticated()).toBe(false);
	});

	it("moves the server expiry on updateStoredSessionMetadata", async () => {
		const { store } = await withSession(-1000);

		await store.updateStoredSessionMetadata("a", {
			sessionId: "session-2",
			expiresAt: 60_000,
		});

		const session = await store.getStoredSessionData("a");
		expect(session?.sessionId).toBe("session-2");
		expect(await store.isSessionValid("a")).toBe(true);
	});

	it("restores a session into the MUK cache", async () => {
		const { crypto, store } = await withSession(60_000);
		await store.clearMasterUnlockKey("a");

		expect(await store.tryRestoreSession(false, "a")).toBe(true);
		expect(await bytesOf(crypto, await store.getMasterUnlockKey("a"))).toEqual(
			bytes(MUK_BYTES),
		);
		expect(await store.getUnlockedAccounts()).toEqual(["a"]);
	});

	it("restores without a prompt where biometric unlock is off", async () => {
		const { store } = await withSession(60_000);
		await store.clearMasterUnlockKey("a");

		expect(await store.tryRestoreSessionWithoutPrompt("a")).toBe(true);
		expect(await store.getUnlockedAccounts()).toEqual(["a"]);
	});

	it("lowercases the stored email", async () => {
		const { store } = await withSession(60_000);

		expect((await store.getStoredSessionData())?.email).toBe("a@example.com");
	});
});

// ============================================================================
// MUK cache
// ============================================================================

describe("AccountStore — master unlock key cache", () => {
	it("sets, gets and clears per account", async () => {
		const { crypto, store, muk, otherMuk } = await makeStore();
		await seedAccount(store, "a", { active: true });
		await seedAccount(store, "b");

		await store.setMasterUnlockKey(muk);
		await store.setMasterUnlockKey(otherMuk, "b");

		expect(await bytesOf(crypto, await store.getMasterUnlockKey())).toEqual(
			bytes(MUK_BYTES),
		);
		expect(await bytesOf(crypto, await store.getMasterUnlockKey("b"))).toEqual(
			bytes(OTHER_MUK_BYTES),
		);
		expect((await store.getUnlockedAccounts()).sort()).toEqual(["a", "b"]);

		await store.clearMasterUnlockKey("a");

		expect(await store.getMasterUnlockKey("a")).toBeNull();
		expect(await store.getUnlockedAccounts()).toEqual(["b"]);
	});

	it("never persists the plaintext master unlock key", async () => {
		const { port, store, muk } = await makeStore();
		await seedAccount(store, "a", { active: true });

		await store.setMasterUnlockKey(muk);

		const dumped = JSON.stringify(port.snapshot());
		expect(dumped).not.toContain(arrayBufferToBase64(MUK_BYTES));
		expect(dumped).not.toContain("master_unlock");
		expect(Object.keys(port.snapshot().secrets)).not.toContain(
			accountKey("a", "master_unlock_key"),
		);
	});

	/**
	 * Dropping the map entry is not enough now that the entry is a handle: the material
	 * behind it lives in the crypto backend, so a lock that forgot to destroy the ref would
	 * leave the vault openable by anything still holding it.
	 */
	it("destroys the key material on clear, not just the cache entry", async () => {
		const { crypto, store, muk } = await makeStore();
		await seedAccount(store, "a", { active: true });
		await store.setMasterUnlockKey(muk);
		const live = crypto.liveKeyCount;

		await store.clearMasterUnlockKey("a");

		expect(crypto.liveKeyCount).toBe(live - 1);
		await expect(crypto.exportKey(muk)).rejects.toThrow(/destroyed/);
	});

	it("locks every account at once", async () => {
		const { crypto, store, muk, otherMuk } = await makeStore();
		await seedAccount(store, "a", { active: true });
		await seedAccount(store, "b");
		await store.setMasterUnlockKey(muk, "a");
		await store.setMasterUnlockKey(otherMuk, "b");

		await store.lockAllAccounts();

		expect(await store.getUnlockedAccounts()).toEqual([]);
		expect(await store.getMasterUnlockKey("a")).toBeNull();
		expect(await store.getMasterUnlockKey("b")).toBeNull();
		await expect(crypto.exportKey(muk)).rejects.toThrow(/destroyed/);
		await expect(crypto.exportKey(otherMuk)).rejects.toThrow(/destroyed/);
	});

	it("drops the unlocked account when it is removed", async () => {
		const { crypto, store, muk } = await makeStore();
		await seedAccount(store, "a", { active: true });
		await store.setMasterUnlockKey(muk);

		await store.removeAccount("a");

		expect(await store.getUnlockedAccounts()).toEqual([]);
		expect(await store.getAccountsList()).toEqual([]);
		expect(await store.getActiveAccount()).toBeNull();
		await expect(crypto.exportKey(muk)).rejects.toThrow(/destroyed/);
	});

	/**
	 * `setUnlockEntry` destroys whatever it is replacing. Re-setting the identical ref must
	 * not destroy the key it is about to cache.
	 */
	it("survives being handed the same key twice", async () => {
		const { crypto, store, muk } = await makeStore();
		await seedAccount(store, "a", { active: true });

		await store.setMasterUnlockKey(muk);
		await store.setMasterUnlockKey(muk);

		expect(await bytesOf(crypto, await store.getMasterUnlockKey())).toEqual(
			bytes(MUK_BYTES),
		);
	});

	it("does not take ownership when publishing the unlocked view fails", async () => {
		const { crypto, port, store, muk } = await makeStore();
		await seedAccount(store, "a", { active: true });
		const kvSet = port.kvSet.bind(port);
		port.kvSet = async (key, value, scope) => {
			if (key === "bittery_native_view") {
				throw new Error("native view write failed");
			}
			await kvSet(key, value, scope);
		};

		await expect(store.setMasterUnlockKey(muk, "a")).rejects.toThrow(
			"native view write failed",
		);

		expect(await store.getUnlockedAccounts()).toEqual([]);
		expect(await crypto.exportKey(muk)).toEqual(MUK_BYTES);
	});
});

describe("AccountStore — device key failure cleanup", () => {
	it("destroys a generated device key when export fails", async () => {
		const { crypto, store, muk } = await makeStore();
		await seedAccount(store, "a", { active: true });
		const before = crypto.liveKeyCount;
		crypto.exportKey = async () => {
			throw new Error("device key export failed");
		};

		await expect(
			store.storeSessionData(muk, "a", "a@example.com", "user-a"),
		).rejects.toThrow("device key export failed");

		expect(crypto.liveKeyCount).toBe(before);
	});

	it("destroys a generated device key when persistence fails", async () => {
		const { crypto, port, store, muk } = await makeStore();
		await seedAccount(store, "a", { active: true });
		const before = crypto.liveKeyCount;
		const secretSet = port.secretSet.bind(port);
		port.secretSet = async (key, value) => {
			if (key === "bittery_device_key") {
				throw new Error("device key persistence failed");
			}
			await secretSet(key, value);
		};

		await expect(
			store.storeSessionData(muk, "a", "a@example.com", "user-a"),
		).rejects.toThrow("device key persistence failed");

		expect(crypto.liveKeyCount).toBe(before);
	});
});

// ============================================================================
// Biometric
// ============================================================================

describe("AccountStore — biometric", () => {
	async function biometricHarness() {
		const harness = await makeStore({ sessionSurvivesRestart: true });
		harness.port.biometricState.hasHardware = true;
		harness.port.biometricState.isEnrolled = true;
		harness.port.biometricState.authenticates = true;
		harness.port.biometricState.type = "face";

		await seedAccount(harness.store, "a", { active: true });
		await harness.store.setBiometricEnabled("a", true);
		await harness.store.storeAuthToken("jwt-value");
		await harness.store.storeSessionData(
			harness.muk,
			"a",
			"a@example.com",
			"user-a",
			60_000,
		);
		return harness;
	}

	it("reports availability, details and type from the port", async () => {
		const { port, store } = await makeStore();
		expect(await store.isBiometricAvailable()).toBe(false);
		expect(await store.getBiometricAvailabilityDetails()).toEqual({
			hasHardware: false,
			isEnrolled: false,
		});
		expect(await store.getBiometricType()).toBeNull();

		port.biometricState.hasHardware = true;
		port.biometricState.isEnrolled = true;
		port.biometricState.type = "fingerprint";

		expect(await store.isBiometricAvailable()).toBe(true);
		expect(await store.getBiometricType()).toBe("fingerprint");
	});

	it("keeps AccountMetadata.biometricEnabled in sync with the stored value", async () => {
		const { store } = await makeStore();
		await seedAccount(store, "a", { active: true });

		await store.setBiometricEnabled("a", true);

		expect(await store.isBiometricEnabled("a")).toBe(true);
		expect((await store.getAccountMetadata("a"))?.biometricEnabled).toBe(true);

		await store.setBiometricEnabled("a", false);

		expect(await store.isBiometricEnabled("a")).toBe(false);
		expect((await store.getAccountMetadata("a"))?.biometricEnabled).toBe(false);
	});

	it("is a no-op for enableBiometric where there is no biometric hardware", async () => {
		const { store } = await makeStore();
		await seedAccount(store, "a", { active: true });

		await store.enableBiometric();

		expect(await store.isBiometricEnabled("a")).toBe(false);
	});

	it("enables and disables where hardware exists", async () => {
		const { port, store } = await makeStore();
		port.biometricState.hasHardware = true;
		port.biometricState.isEnrolled = true;
		await seedAccount(store, "a", { active: true });

		await store.enableBiometric();
		expect(await store.isBiometricEnabled()).toBe(true);

		await store.disableBiometric();
		expect(await store.isBiometricEnabled()).toBe(false);
	});

	it("honours the grace period against BIOMETRIC_GRACE_PERIOD_MS", async () => {
		const { crypto, port, store } = await biometricHarness();

		expect(
			await bytesOf(crypto, await store.decryptStoredMasterUnlockKey("a")),
		).toEqual(bytes(MUK_BYTES));
		expect(port.calls.biometricAuthenticate).toBe(1);

		// Inside the grace period: no second prompt.
		expect(
			await bytesOf(crypto, await store.decryptStoredMasterUnlockKey("a")),
		).toEqual(bytes(MUK_BYTES));
		expect(port.calls.biometricAuthenticate).toBe(1);

		// Push the last authentication just outside the grace period.
		await port.kvSet(
			accountKey("a", "last_biometric_auth"),
			String(Date.now() - BIOMETRIC_GRACE_PERIOD_MS - 1),
			"device",
		);

		expect(
			await bytesOf(crypto, await store.decryptStoredMasterUnlockKey("a")),
		).toEqual(bytes(MUK_BYTES));
		expect(port.calls.biometricAuthenticate).toBe(2);
	});

	it("requires a fresh prompt after lockAllAccounts clears the grace marker", async () => {
		const { port, store } = await biometricHarness();
		await store.decryptStoredMasterUnlockKey("a");
		expect(port.calls.biometricAuthenticate).toBe(1);

		await store.lockAllAccounts();

		await store.decryptStoredMasterUnlockKey("a");
		expect(port.calls.biometricAuthenticate).toBe(2);
	});

	it("skips the prompt when skipBiometric is set", async () => {
		const { crypto, port, store } = await biometricHarness();

		expect(
			await bytesOf(
				crypto,
				await store.decryptStoredMasterUnlockKey("a", true),
			),
		).toEqual(bytes(MUK_BYTES));
		expect(port.calls.biometricAuthenticate).toBe(0);
	});

	it("returns null when biometric authentication is refused", async () => {
		const { port, store } = await biometricHarness();
		port.biometricState.authenticates = false;

		expect(await store.decryptStoredMasterUnlockKey("a")).toBeNull();
	});

	/**
	 * Reading the key is not an unlock. Every cached item's vault-key unwrap reads it,
	 * so a read that could restore the session raised one OS prompt per item on a
	 * locked account — and answered them all with "not available" anyway.
	 */
	it("never prompts, and never unlocks, when the key is only read", async () => {
		const { port, store } = await biometricHarness();
		await store.lockAllAccounts();
		port.resetCalls();

		expect(await store.getMasterUnlockKey("a")).toBeNull();
		expect(await store.getMasterUnlockKey("a")).toBeNull();

		expect(port.calls.biometricAuthenticate).toBe(0);
		expect(await store.getUnlockedAccounts()).toEqual([]);
	});

	it("restores inside the grace period without a prompt, and refuses once one is due", async () => {
		const { port, store } = await biometricHarness();
		expect(await store.unlockWithBiometric("a")).toBe(true);
		await store.clearMasterUnlockKey("a");
		port.resetCalls();

		expect(await store.tryRestoreSessionWithoutPrompt("a")).toBe(true);
		expect(await store.getUnlockedAccounts()).toEqual(["a"]);
		expect(port.calls.biometricAuthenticate).toBe(0);

		// A lock drops the grace marker, so restoring now needs a prompt — which this
		// entry point never shows. The account stays locked until an unlock flow runs.
		await store.lockAllAccounts();

		expect(await store.tryRestoreSessionWithoutPrompt("a")).toBe(false);
		expect(await store.getUnlockedAccounts()).toEqual([]);
		expect(port.calls.biometricAuthenticate).toBe(0);
	});

	it("unlocks a single account with biometric", async () => {
		const { store } = await biometricHarness();

		expect(await store.canBiometricUnlock("a")).toBe(true);
		expect(await store.unlockWithBiometric("a")).toBe(true);
		expect(await store.getUnlockedAccounts()).toEqual(["a"]);
	});

	it("unlocks every account behind one prompt", async () => {
		const { port, store, otherMuk } = await biometricHarness();
		await seedAccount(store, "b");
		await store.setBiometricEnabled("b", true);
		await store.storeAuthToken("jwt-b", "b");
		await store.storeSessionData(
			otherMuk,
			"b",
			"b@example.com",
			"user-b",
			60_000,
		);
		port.resetCalls();

		const result = await store.unlockAllAccountsWithBiometric();

		expect(result.unlocked.sort()).toEqual(["a", "b"]);
		expect(result.failed).toEqual([]);
		expect(port.calls.biometricAuthenticate).toBe(1);
	});

	// The prompt reason is the one piece of user-facing copy that reaches the OS dialog, so
	// every prompting method has to let the caller supply an already-translated one. These
	// three cover the whole prompting surface; `canBiometricUnlock` is a pure probe and
	// shows no dialog, so it deliberately takes no reason.
	it("forwards a caller-supplied prompt reason to the OS dialog", async () => {
		const { port, store } = await biometricHarness();

		await store.decryptStoredMasterUnlockKey(
			"a",
			false,
			"Entsperre deinen Tresor",
		);
		expect(port.biometricState.lastReason).toBe("Entsperre deinen Tresor");

		await store.lockAllAccounts();
		await store.unlockWithBiometric("a", "Bittery entsperren");
		expect(port.biometricState.lastReason).toBe("Bittery entsperren");

		await store.lockAllAccounts();
		await store.unlockAllAccountsWithBiometric("Alle Konten entsperren");
		expect(port.biometricState.lastReason).toBe("Alle Konten entsperren");
	});

	it("falls back to the English default when no reason is supplied", async () => {
		const { port, store } = await biometricHarness();

		await store.unlockAllAccountsWithBiometric();
		expect(port.biometricState.lastReason).toBe("Unlock all accounts");
	});

	it("reports every account as failed when no account can use biometric", async () => {
		const { store } = await makeStore();
		await seedAccount(store, "a", { active: true });

		const result = await store.unlockAllAccountsWithBiometric();

		expect(result.unlocked).toEqual([]);
		expect(result.failed).toEqual([
			{ accountId: "a", error: "Biometric authentication not available" },
		]);
	});

	it("reports enhanced errors in order", async () => {
		const { port, store } = await makeStore();
		await seedAccount(store, "a", { active: true });

		expect((await store.authenticateWithBiometricEnhanced()).error).toBe(
			"not_available",
		);

		port.biometricState.hasHardware = true;
		expect((await store.authenticateWithBiometricEnhanced()).error).toBe(
			"not_enrolled",
		);

		port.biometricState.isEnrolled = true;
		expect((await store.authenticateWithBiometricEnhanced()).error).toBe(
			"not_enabled",
		);

		await store.setBiometricEnabled("a", true);
		expect((await store.authenticateWithBiometricEnhanced()).error).toBe(
			"session_expired",
		);
	});

	it("succeeds and records the grace marker on an enhanced authentication", async () => {
		const { port, store } = await biometricHarness();

		const result = await store.authenticateWithBiometricEnhanced("Unlock", "a");

		expect(result).toEqual({ success: true });
		expect(port.biometricState.lastReason).toBe("Unlock");
		expect(
			port.snapshot().device[accountKey("a", "last_biometric_auth")],
		).toBeDefined();
	});

	/**
	 * Mobile autolock decides whether to re-prompt from how long the app was backgrounded;
	 * leaving a stale timestamp behind after a successful unlock makes it demand
	 * authentication again immediately.
	 */
	it("clears the background timestamp on a successful enhanced authentication", async () => {
		const { store } = await biometricHarness();
		await store.storeBackgroundTimestamp("a");
		expect(await store.getBackgroundTimestamp("a")).toBeGreaterThan(0);

		expect(
			await store.authenticateWithBiometricEnhanced("Unlock", "a"),
		).toEqual({ success: true });

		expect(await store.getBackgroundTimestamp("a")).toBeNull();
	});

	it("leaves the background timestamp alone when authentication fails", async () => {
		const { port, store } = await biometricHarness();
		await store.storeBackgroundTimestamp("a");
		port.biometricState.authenticates = false;

		await store.authenticateWithBiometricEnhanced("Unlock", "a");

		expect(await store.getBackgroundTimestamp("a")).toBeGreaterThan(0);
	});

	it("preserves the port's outcome instead of collapsing it into a generic failure", async () => {
		const { port, store } = await biometricHarness();
		port.biometricState.authenticates = false;

		port.biometricState.authenticateError = "user_cancelled";
		expect(
			await store.authenticateWithBiometricEnhanced(undefined, "a"),
		).toEqual({
			success: false,
			error: "user_cancelled",
			message: "Authentication was cancelled",
		});

		port.biometricState.authenticateError = "lockout";
		expect(
			(await store.authenticateWithBiometricEnhanced(undefined, "a")).error,
		).toBe("lockout");

		port.biometricState.authenticateError = "not_enrolled";
		expect(
			(await store.authenticateWithBiometricEnhanced(undefined, "a")).error,
		).toBe("not_enrolled");

		port.biometricState.authenticateError = "not_available";
		expect(
			(await store.authenticateWithBiometricEnhanced(undefined, "a")).error,
		).toBe("not_available");

		port.biometricState.authenticateError = "failed";
		expect(
			(await store.authenticateWithBiometricEnhanced(undefined, "a")).error,
		).toBe("authentication_failed");
	});

	it("prefers the port's own message when it supplies one", async () => {
		const { port, store } = await biometricHarness();
		port.biometricState.authenticates = false;
		port.biometricState.authenticateError = "lockout";
		port.biometricState.authenticateMessage = "Locked out for 30 seconds";

		expect(
			(await store.authenticateWithBiometricEnhanced(undefined, "a")).message,
		).toBe("Locked out for 30 seconds");
	});

	it("treats any unsuccessful port result as a failed plain authentication", async () => {
		const { port, store } = await biometricHarness();
		port.biometricState.authenticates = false;
		port.biometricState.authenticateError = "user_cancelled";

		expect(await store.authenticateWithBiometric(undefined, "a")).toBe(false);
		expect(await store.unlockWithBiometric("a")).toBe(false);
	});

	it("reports unknown when there is no account", async () => {
		const { store } = await makeStore();

		expect(await store.authenticateWithBiometricEnhanced()).toEqual({
			success: false,
			error: "unknown",
			message: "No account specified",
		});
	});
});

// ============================================================================
// Master-password re-entry
// ============================================================================

describe("AccountStore — master password re-entry", () => {
	async function reentryHarness() {
		const harness = await makeStore({ sessionSurvivesRestart: true });
		harness.port.biometricState.hasHardware = true;
		harness.port.biometricState.isEnrolled = true;
		harness.port.biometricState.authenticates = true;
		await seedAccount(harness.store, "a", { active: true });
		await harness.store.setBiometricEnabled("a", true);
		await harness.store.storeAuthToken("jwt-value");
		await harness.store.storeSessionData(
			harness.muk,
			"a",
			"a@example.com",
			"user-a",
			60_000,
		);
		return harness;
	}

	it("defaults to MASTER_PASSWORD_REENTRY_PERIOD_MS", async () => {
		const { store } = await makeStore();

		expect(await store.getMasterPasswordReentryPeriodMs()).toBe(
			MASTER_PASSWORD_REENTRY_PERIOD_MS,
		);
	});

	it("reads back a stored custom period", async () => {
		const { store } = await makeStore();

		await store.storeMasterPasswordReentryPeriodMs(12_345);

		expect(await store.getMasterPasswordReentryPeriodMs()).toBe(12_345);
	});

	it("is not required inside the default period", async () => {
		const { store } = await reentryHarness();

		expect(await store.isMasterPasswordReentryRequired("a")).toBe(false);
	});

	it("is required once the stored custom period has elapsed", async () => {
		const { store } = await reentryHarness();

		await store.storeMasterPasswordReentryPeriodMs(0);
		await tick();

		expect(await store.isMasterPasswordReentryRequired("a")).toBe(true);
	});

	it("blocks the stored-MUK decrypt path when re-entry is due", async () => {
		const { store } = await reentryHarness();
		await store.storeMasterPasswordReentryPeriodMs(0);
		await tick();

		expect(await store.decryptStoredMasterUnlockKey("a", true)).toBeNull();
		expect(
			(await store.authenticateWithBiometricEnhanced(undefined, "a")).error,
		).toBe("master_password_required");
	});

	/**
	 * Storage must not format user-facing copy (`CLAUDE.md`). It reports the period as a
	 * number and the UI renders "every N days" in the user's own language and plural rules.
	 */
	it("reports the re-entry period as structured data, never as a formatted sentence", async () => {
		const { store } = await reentryHarness();
		await store.storeMasterPasswordReentryPeriodMs(0);
		await tick();

		const result = await store.authenticateWithBiometricEnhanced(
			undefined,
			"a",
		);

		expect(result).toEqual({
			success: false,
			error: "master_password_required",
			masterPasswordReentryPeriodMs: 0,
		});
		expect(result.message).toBeUndefined();
	});

	it("is never required with a negative period", async () => {
		const { store } = await reentryHarness();

		await store.storeMasterPasswordReentryPeriodMs(-1);

		expect(await store.isMasterPasswordReentryRequired("a")).toBe(false);
	});

	it("clears the requirement after updateLastMasterPasswordEntry", async () => {
		const { store } = await reentryHarness();
		await store.storeMasterPasswordReentryPeriodMs(60_000);

		await store.updateLastMasterPasswordEntry("a");

		expect(await store.isMasterPasswordReentryRequired("a")).toBe(false);
		expect(
			(await store.getStoredSessionData("a"))?.lastMasterPasswordEntry,
		).toBeGreaterThan(0);
	});

	it("is never required without biometric, matching web", async () => {
		const { store, muk } = await makeStore();
		await seedAccount(store, "a", { active: true });
		await store.storeAuthToken("jwt-value");
		await store.storeSessionData(muk, "a", "a@example.com", "user-a", 60_000);
		await store.storeMasterPasswordReentryPeriodMs(0);

		expect(await store.isMasterPasswordReentryRequired("a")).toBe(false);
	});
});

// ============================================================================
// Unlock broadcast
// ============================================================================

describe("AccountStore — onUnlockStateChanged", () => {
	it("fires on set, clear and lockAll", async () => {
		const { store, muk, otherMuk } = await makeStore();
		await seedAccount(store, "a", { active: true });
		await seedAccount(store, "b");

		const seen: string[][] = [];
		store.onUnlockStateChanged((accounts) => seen.push(accounts));

		await store.setMasterUnlockKey(muk, "a");
		await store.setMasterUnlockKey(otherMuk, "b");
		await store.clearMasterUnlockKey("a");
		await store.lockAllAccounts();

		expect(seen).toEqual([["a"], ["a", "b"], ["b"], []]);
	});

	it("stops firing after unsubscribe", async () => {
		const { store, muk } = await makeStore();
		await seedAccount(store, "a", { active: true });

		const seen: string[][] = [];
		const unsubscribe = store.onUnlockStateChanged((a) => seen.push(a));

		await store.setMasterUnlockKey(muk);
		unsubscribe();
		await store.clearMasterUnlockKey();

		expect(seen).toEqual([["a"]]);
	});

	it("does not let a throwing listener break the operation", async () => {
		const { store, muk } = await makeStore();
		await seedAccount(store, "a", { active: true });

		const seen: string[][] = [];
		store.onUnlockStateChanged(() => {
			throw new Error("listener exploded");
		});
		store.onUnlockStateChanged((a) => seen.push(a));

		await store.setMasterUnlockKey(muk);

		expect(seen).toEqual([["a"]]);
		expect(await store.getUnlockedAccounts()).toEqual(["a"]);
	});

	it("hands each listener its own array", async () => {
		const { store, muk } = await makeStore();
		await seedAccount(store, "a", { active: true });

		let captured: string[] = [];
		store.onUnlockStateChanged((accounts) => {
			captured = accounts;
		});

		await store.setMasterUnlockKey(muk);
		captured.push("mutated-by-listener");

		expect(await store.getUnlockedAccounts()).toEqual(["a"]);
	});
});

// ============================================================================
// Native-host projection
// ============================================================================

describe("AccountStore — native host projection", () => {
	it("is written at initialize with a resolved auto-lock timeout", async () => {
		const { port } = await makeStore();

		const view = nativeView(port);
		expect(view.v).toBe(NATIVE_VIEW_VERSION);
		expect(view.accounts).toEqual([]);
		expect(view.activeAccountId).toBeNull();
		expect(view.unlockedAccountIds).toEqual([]);
		expect(view.autoLockTimeoutMs).toBe(DEFAULT_AUTO_LOCK_TIMEOUT_MS);
	});

	it("refreshes when the accounts list changes", async () => {
		const { port, store } = await makeStore();

		await seedAccount(store, "a");

		expect(nativeView(port).accounts.map((a) => a.accountId)).toEqual(["a"]);

		await store.removeAccount("a");

		expect(nativeView(port).accounts).toEqual([]);
	});

	it("republishes the displayable account metadata the native host has to hand on", async () => {
		const { port, store } = await makeStore();

		await store.addAccount({
			...metadataFor("a"),
			name: "Alice Example",
			secretKeyHint: "A3-XXXXXX",
			teamName: "Acme",
			teamAvatarUrl: "https://cdn.example.com/acme.png",
		});

		const account = nativeView(port).accounts[0];
		expect(account?.userId).toBe("user-a");
		expect(account?.name).toBe("Alice Example");
		expect(account?.secretKeyHint).toBe("A3-XXXXXX");
		expect(account?.teamName).toBe("Acme");
		expect(account?.teamAvatarUrl).toBe("https://cdn.example.com/acme.png");
		expect(account?.addedAt).toBe(1);
		expect(account?.lastActiveAt).toBe(1);
	});

	it("keeps an absent optional absent rather than defaulting it", async () => {
		const { port, store } = await makeStore();

		// metadataFor sets neither team field.
		await seedAccount(store, "a");

		const account = nativeView(port).accounts[0];
		const keys = Object.keys(account ?? {});
		expect(keys).not.toContain("teamName");
		expect(keys).not.toContain("teamAvatarUrl");
	});

	it("refreshes when the active account changes", async () => {
		const { port, store } = await makeStore();
		await seedAccount(store, "a");

		await store.setActiveAccount("a");
		expect(nativeView(port).activeAccountId).toBe("a");

		await store.setActiveAccount(null);
		expect(nativeView(port).activeAccountId).toBeNull();
	});

	it("refreshes when biometric-enabled changes, and always writes it resolved", async () => {
		const { port, store } = await makeStore();
		await seedAccount(store, "a", { active: true });

		expect(nativeView(port).accounts[0]?.biometricEnabled).toBe(false);

		await store.setBiometricEnabled("a", true);

		const account = nativeView(port).accounts[0];
		expect(account?.biometricEnabled).toBe(true);
		// Written resolved, never absent: no `unwrap_or(true)` is needed downstream.
		expect(Object.keys(account ?? {})).toContain("biometricEnabled");
		expect(typeof account?.biometricEnabled).toBe("boolean");
	});

	it("refreshes when the unlocked set changes", async () => {
		const { port, store, muk } = await makeStore();
		await seedAccount(store, "a", { active: true });

		await store.setMasterUnlockKey(muk);
		expect(nativeView(port).unlockedAccountIds).toEqual(["a"]);

		await store.lockAllAccounts();
		expect(nativeView(port).unlockedAccountIds).toEqual([]);
	});

	it("refreshes when the auto-lock timeout changes", async () => {
		const { port, store } = await makeStore();
		await seedAccount(store, "a", { active: true });

		await store.storeAutoLockTimeout(90_000);

		expect(nativeView(port).autoLockTimeoutMs).toBe(90_000);
		expect(await store.getAutoLockTimeout()).toBe(90_000);
		expect(await store.getAutoLockTimeoutOrDefault()).toBe(90_000);
	});

	it("publishes a store for every key so Rust never decides placement", async () => {
		const durable = await makeStore({ sessionSurvivesRestart: true });
		await seedAccount(durable.store, "a", { active: true });
		const durableView = nativeView(durable.port);
		const durableAccount = durableView.accounts[0];

		expect(durableView.deviceKey).toEqual({
			key: "bittery_device_key",
			store: "secret",
		});
		expect(durableAccount?.token).toEqual({
			key: accountKey("a", "jwt_token"),
			store: "secret",
		});
		expect(durableAccount?.sessionData.store).toBe("secret");
		expect(durableAccount?.vaultKeys.store).toBe("secret");
		expect(durableAccount?.encryptedPrivateKey.store).toBe("secret");
		// AccountStore names only the fixed metadata record. ItemCache owns the active
		// generation and publishes the opaque item/vault prefixes in that one record.
		expect(durableAccount?.itemCacheState).toEqual({
			key: `${metaCollection("a")}:meta`,
			store: "plain",
		});

		// The port owns the record key prefix; the projection resolves it in. Desktop is the
		// only platform where it is non-empty, and the only platform with a native reader.
		const prefixed: InMemoryPlatformPort = {
			...createInMemoryPlatformPort({ sessionSurvivesRestart: true }),
			recordKeyPrefix: "record:",
		};
		const prefixedStore = createAccountStore({
			port: prefixed,
			crypto: createInMemoryCryptoPort(),
		});
		await prefixedStore.initialize();
		await seedAccount(prefixedStore, "a", { active: true });
		const prefixedAccount = nativeView(prefixed).accounts[0];
		expect(prefixedAccount?.itemCacheState).toEqual({
			key: "record:a:meta:meta",
			store: "plain",
		});

		const ephemeral = await makeStore({ sessionSurvivesRestart: false });
		await seedAccount(ephemeral.store, "a", { active: true });
		const ephemeralAccount = nativeView(ephemeral.port).accounts[0];

		// Session-bound values land in the ephemeral kv store on web/extension.
		expect(ephemeralAccount?.token.store).toBe("plain");
		expect(ephemeralAccount?.sessionData.store).toBe("secret");
	});
});

// ============================================================================
// Accounts, settings and teardown
// ============================================================================

describe("AccountStore — accounts and settings", () => {
	it("upserts an existing account rather than duplicating it", async () => {
		const { store } = await makeStore();
		await seedAccount(store, "a");

		await store.addAccount({ ...metadataFor("a"), name: "renamed" });

		const accounts = await store.getAccountsList();
		expect(accounts).toHaveLength(1);
		expect(accounts[0]?.name).toBe("renamed");
	});

	it("dedupes by serverUrl + userId when the accountId is new", async () => {
		const { store } = await makeStore();
		await seedAccount(store, "a");

		await store.addAccount({ ...metadataFor("a"), accountId: "different" });

		const accounts = await store.getAccountsList();
		expect(accounts).toHaveLength(1);
		expect(accounts[0]?.accountId).toBe("a");
	});

	it("mints an accountId when none is supplied", async () => {
		const { store } = await makeStore();

		await store.addAccount({ ...metadataFor("a"), accountId: "" });

		const accounts = await store.getAccountsList();
		expect(accounts).toHaveLength(1);
		expect(accounts[0]?.accountId).not.toBe("");
	});

	it("stamps lastActiveAt when an account is activated", async () => {
		const { store } = await makeStore();
		await seedAccount(store, "a");

		await store.setActiveAccount("a");

		expect((await store.getAccountMetadata("a"))?.lastActiveAt).toBeGreaterThan(
			1,
		);
	});

	it("resolves the active account's userId", async () => {
		const { store } = await makeStore();
		await seedAccount(store, "a", { active: true });

		expect(await store.getActiveAccountUserId()).toBe("user-a");
	});

	it("round-trips travel mode cache and pinned kdf profiles per account", async () => {
		const { store } = await makeStore();
		await seedAccount(store, "a", { active: true });
		await seedAccount(store, "b");

		await store.storeTravelModeCache({ enabled: true, hiddenVaultIds: ["v1"] });
		await store.storePinnedKdfProfile(
			{ schemaVersion: 1, algorithm: "pbkdf2-sha256", iterations: 600_000 },
			"a",
		);

		expect(await store.getTravelModeCache("a")).toEqual({
			enabled: true,
			hiddenVaultIds: ["v1"],
		});
		expect(await store.getTravelModeCache("b")).toBeNull();
		expect(await store.getPinnedKdfProfile("a")).toEqual({
			schemaVersion: 1,
			algorithm: "pbkdf2-sha256",
			iterations: 600_000,
		});
		expect(await store.getPinnedKdfProfile("b")).toBeNull();
	});

	it("rejects a malformed pinned kdf profile", async () => {
		const { port, store } = await makeStore();
		await seedAccount(store, "a", { active: true });

		await port.kvSet(accountKey("a", "pinned_kdf_params"), "{oops", "device");

		expect(await store.getPinnedKdfProfile("a")).toBeNull();
	});

	it("round-trips the background timestamp and no-ops without an account", async () => {
		const { store } = await makeStore();

		await store.storeBackgroundTimestamp();
		expect(await store.getBackgroundTimestamp()).toBeNull();

		await seedAccount(store, "a", { active: true });
		await store.storeBackgroundTimestamp();
		expect(await store.getBackgroundTimestamp()).toBeGreaterThan(0);

		await store.clearBackgroundTimestamp();
		expect(await store.getBackgroundTimestamp()).toBeNull();
	});

	it("reports quick unlock only with a secret key and an unexpired session", async () => {
		const { store, muk } = await makeStore();
		await seedAccount(store, "a", { active: true });
		await store.storeAuthToken("jwt-value");
		await store.storeSessionData(muk, "a", "a@example.com", "user-a", 60_000);

		expect(await store.canQuickUnlock()).toBe(false);

		await store.storeSecretKey("secret-a");

		expect(await store.canQuickUnlock()).toBe(true);
		expect(await store.hasStoredSecretKey()).toBe(true);
	});

	it("keeps offering quick unlock after a restart drops the auth token", async () => {
		const { port, store, muk } = await makeStore({
			sessionSurvivesRestart: false,
		});
		await seedAccount(store, "a", { active: true });
		await store.storeAuthToken("jwt-value");
		await store.storeSecretKey("secret-a");
		await store.storeSessionData(muk, "a", "a@example.com", "user-a", 60_000);

		port.simulateRestart();

		// Web keeps the token in `sessionStorage`, so it dies with the tab. That is exactly
		// the state quick unlock exists for — never a reason to demand the secret key again.
		expect(await store.getAuthToken("a")).toBeNull();
		expect(await store.canQuickUnlock("a")).toBe(true);
	});

	it("stops offering quick unlock once the stored session has expired", async () => {
		const { store, muk } = await makeStore();
		await seedAccount(store, "a", { active: true });
		await store.storeAuthToken("jwt-value");
		await store.storeSecretKey("secret-a");
		await store.storeSessionData(muk, "a", "a@example.com", "user-a", -1);

		expect(await store.canQuickUnlock()).toBe(false);
	});

	async function signedInHarness() {
		const harness = await makeStore({ sessionSurvivesRestart: true });
		await seedAccount(harness.store, "a", { active: true });
		await harness.store.storeAuthToken("jwt-value");
		await harness.store.storeSecretKey("secret-a");
		await harness.store.storeVaultKeys([]);
		await harness.store.storeEncryptedPrivateKey("pk");
		await harness.store.storeSessionData(
			harness.muk,
			"a",
			"a@example.com",
			"user-a",
			60_000,
		);
		await harness.store.setMasterUnlockKey(harness.muk);
		return harness;
	}

	it("clearSession locks: drops credentials and the in-memory MUK, keeps the account", async () => {
		const { store } = await signedInHarness();

		await store.clearSession();

		expect(await store.getAuthToken("a")).toBeNull();
		expect(await store.getVaultKeys("a")).toBeNull();
		expect(await store.getEncryptedPrivateKey("a")).toBeNull();
		expect(await store.getUnlockedAccounts()).toEqual([]);
		expect(await store.getAccountsList()).toHaveLength(1);
	});

	it("clearSession leaves quick-unlock working", async () => {
		const { crypto, store } = await signedInHarness();

		await store.clearSession();

		// The quick-unlock material — session_data, which carries the MUK encrypted under
		// the device key — deliberately survives a lock.
		expect(await store.getStoredSessionData("a")).not.toBeNull();
		expect(
			await bytesOf(crypto, await store.decryptStoredMasterUnlockKey("a")),
		).toEqual(bytes(MUK_BYTES));

		expect(await store.canQuickUnlock()).toBe(true);

		// Restoring the session in place, unlike the quick-unlock offer, does need a token.
		await store.storeAuthToken("jwt-value-2");
		expect(await store.tryRestoreSession()).toBe(true);
		expect(await store.getUnlockedAccounts()).toEqual(["a"]);
	});

	it("forgetSession signs out: quick-unlock is gone", async () => {
		const { store } = await signedInHarness();

		await store.forgetSession();

		expect(await store.getAuthToken("a")).toBeNull();
		expect(await store.getVaultKeys("a")).toBeNull();
		expect(await store.getEncryptedPrivateKey("a")).toBeNull();
		expect(await store.getUnlockedAccounts()).toEqual([]);
		expect(await store.getStoredSessionData("a")).toBeNull();
		expect(await store.decryptStoredMasterUnlockKey("a")).toBeNull();

		await store.storeAuthToken("jwt-value-2");
		expect(await store.canQuickUnlock()).toBe(false);
		expect(await store.tryRestoreSession()).toBe(false);

		// The account itself is still known; only its session is gone.
		expect(await store.getAccountsList()).toHaveLength(1);
	});

	it("both are no-ops without an account", async () => {
		const { store } = await makeStore();

		await store.clearSession();
		await store.forgetSession();

		expect(await store.getUnlockedAccounts()).toEqual([]);
	});

	it("clearAllStoredData wipes the account and the device key once nothing is left", async () => {
		const { port, store, muk } = await makeStore({
			sessionSurvivesRestart: true,
		});
		await seedAccount(store, "a", { active: true });
		await store.storeAuthToken("jwt-value");
		await store.storeSessionData(muk, "a", "a@example.com", "user-a", 60_000);

		await store.clearAllStoredData();

		expect(await store.getAccountsList()).toEqual([]);
		expect(await store.getActiveAccount()).toBeNull();
		expect(port.snapshot().secrets.bittery_device_key).toBeUndefined();
		expect(nativeView(port).accounts).toEqual([]);
	});
});
