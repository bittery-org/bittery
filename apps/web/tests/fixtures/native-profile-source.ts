import type { DerivedKeyRefs, KdfProfile } from "@bittery/crypto-port";
import { createWasmCryptoPort } from "@bittery/crypto-port/adapters/wasm";
import { createAccountStore } from "@bittery/storage";
import { createTauriPlatformPort } from "@bittery/storage/adapters/tauri";
import { createTauriDoubles } from "../../../../packages/storage/src/adapters/tauri-test-doubles";

export interface DesktopProfileSourceBytes {
	accountId: string;
	storeJson: Uint8Array;
	syncStoreJson: Uint8Array;
	/** Secret-bearing JSON map for a later isolated OS entry; never write it to a plain file. */
	protectedEntry: Uint8Array;
}

function encode(entries: Iterable<[string, unknown]>, pretty: boolean) {
	return new TextEncoder().encode(
		JSON.stringify(Object.fromEntries(entries), null, pretty ? 2 : undefined),
	);
}

/**
 * Offline ticket91 source input: real AccountStore/Tauri routing and existing Wasm crypto,
 * with only the Tauri storage primitives replaced by memory. This is not OS capture acceptance.
 * Account strings are retained exactly as the legacy writer generated them; the outer file JSON
 * uses plugin-store's pretty-object format and the protected entry uses its compact map format.
 * The caller owns the returned bytes and must clear them after use. No live key handles escape.
 */
export async function createLockedDesktopProfileSource(
	password: string,
): Promise<DesktopProfileSourceBytes> {
	const primitives = createTauriDoubles();
	const crypto = createWasmCryptoPort();
	const storage = createAccountStore({
		port: createTauriPlatformPort(primitives.deps),
		crypto,
	});
	let accountId: string | undefined;
	let keys: DerivedKeyRefs | undefined;
	try {
		await crypto.initialize();
		await storage.initialize();
		accountId = await crypto.generateUuid();
		const userId = await crypto.generateUuid();
		const email = `admission-${accountId}@example.test`;
		const secretKey = await crypto.generateSecretKey();
		const profile: KdfProfile = {
			schemaVersion: 1,
			algorithm: "pbkdf2-sha256",
			iterations: 600_000,
		};
		keys = await crypto.deriveKeys(password, secretKey, email, profile);
		const addedAt = Date.now();
		const serverUrl = "https://admission.example.test";
		await storage.addAccount({
			accountId,
			userId,
			email,
			name: "Legacy admission fixture",
			serverUrl,
			secretKeyHint: `${secretKey.slice(0, 4)}••••`,
			addedAt,
			lastActiveAt: addedAt,
			biometricEnabled: false,
			insecureTransportConfirmed: false,
		});
		await storage.storeServerUrl(serverUrl, accountId);
		await storage.storePinnedKdfProfile(profile, accountId);
		await storage.storeSecretKey(secretKey, accountId);
		await storage.storeSessionData(
			keys.masterUnlockKey,
			accountId,
			email,
			userId,
		);
		await storage.setActiveAccount(accountId);
		await storage.storeAutoLockTimeout(0, accountId);
		await storage.storeMasterPasswordReentryPeriodMs(-1);
		await storage.clearSession(accountId);

		// Sync never ran: save an empty source file, with no invented client/cursor/queue.
		const syncStore = await primitives.deps.loadStore("sync-store.json");
		await syncStore.save();
		return {
			accountId,
			storeJson: encode(await primitives.store.entries(), true),
			syncStoreJson: encode(await syncStore.entries(), true),
			protectedEntry: encode(primitives.keychain.entries, false),
		};
	} finally {
		try {
			if (keys) {
				await Promise.all([
					crypto.destroyKey(keys.authKey),
					crypto.destroyKey(keys.masterUnlockKey),
				]);
			}
		} finally {
			try {
				await storage.clearAllStoredData(accountId);
			} finally {
				primitives.keychain.entries.clear();
				primitives.keychain.calls.length = 0;
				primitives.keychain.recordCalls.length = 0;
				primitives.store.contents.clear();
				primitives.store.resetCallLog();
			}
		}
	}
}
