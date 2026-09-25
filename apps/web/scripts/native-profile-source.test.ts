import { expect, spyOn, test } from "bun:test";
import type { KeyRef } from "@bittery/crypto-port";
import { createWasmCryptoPort } from "@bittery/crypto-port/adapters/wasm";
import {
	accountKey,
	createAccountStore,
	DEFAULT_SESSION_EXPIRY_MS,
	globalKey,
} from "@bittery/storage";
import { createTauriPlatformPort } from "@bittery/storage/adapters/tauri";
import { createTauriDoubles } from "../../../packages/storage/src/adapters/tauri-test-doubles";
import {
	createLockedDesktopProfileSource,
	type DesktopProfileSourceBytes,
} from "../tests/fixtures/native-profile-source";

test("legacy Desktop source reloads locked with the original real wrapped MUK and no Session or pending work", async () => {
	const originalFetch = globalThis.fetch;
	let httpCalls = 0;
	const offlineFetch = (
		input: Parameters<typeof globalThis.fetch>[0],
		init?: Parameters<typeof globalThis.fetch>[1],
	) => {
		const url = input instanceof Request ? input.url : String(input);
		if (!url.startsWith("file:")) {
			httpCalls += 1;
			throw new Error("The offline source fixture may only load local Wasm");
		}
		return originalFetch(input, init);
	};
	const fetch = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(offlineFetch, {
			preconnect() {
				httpCalls += 1;
				throw new Error("The offline source fixture cannot preconnect");
			},
		}),
	);
	let source: DesktopProfileSourceBytes | undefined;
	const primitives = createTauriDoubles();
	const crypto = createWasmCryptoPort();
	const storage = createAccountStore({
		port: createTauriPlatformPort(primitives.deps),
		crypto,
	});
	const handles: KeyRef[] = [];
	const secretBytes: Uint8Array[] = [];
	try {
		const started = Date.now();
		const password = "Only this offline fixture uses this passphrase";
		source = await createLockedDesktopProfileSource(password);
		const finished = Date.now();
		const plain: Record<string, unknown> = JSON.parse(
			new TextDecoder().decode(source.storeJson),
		);
		const protectedValues: Record<string, string> = JSON.parse(
			new TextDecoder().decode(source.protectedEntry),
		);
		expect(Object.keys(plain).every((key) => !key.startsWith("record:"))).toBe(
			true,
		);
		expect(
			Object.values(plain).every((value) => typeof value === "string"),
		).toBe(true);
		expect(new TextDecoder().decode(source.syncStoreJson)).toBe("{}");
		const nativeView = JSON.parse(String(plain[globalKey("native_view")]));
		expect(nativeView.unlockedAccountIds).toEqual([]);
		expect(Object.keys(protectedValues).sort()).toEqual(
			[
				globalKey("device_key"),
				accountKey(source.accountId, "secret_key"),
				accountKey(source.accountId, "session_data"),
			].sort(),
		);
		for (const key of Object.keys(protectedValues)) {
			expect(Object.hasOwn(plain, key)).toBe(false);
		}
		for (const [key, value] of Object.entries(plain)) {
			await primitives.store.set(key, value);
		}
		await primitives.store.save();
		for (const [key, value] of Object.entries(protectedValues)) {
			await primitives.keychain.invoke("keychain_set", { key, value });
		}
		await storage.initialize();
		const account = await storage.getAccountMetadata(source.accountId);
		const session = await storage.getStoredSessionData(source.accountId);
		const profile = await storage.getPinnedKdfProfile(source.accountId);
		const secretKey = await storage.getStoredSecretKey(source.accountId);
		if (!account || !session || !profile || !secretKey) {
			throw new Error("Generated legacy QuickUnlock inputs did not reload");
		}
		expect(await storage.getActiveAccount()).toBe(source.accountId);
		expect((await storage.getAccountsList()).length).toBe(1);
		expect(await storage.getMasterUnlockKey(source.accountId)).toBeNull();
		expect(await storage.canQuickUnlock(source.accountId)).toBe(true);
		expect(await storage.isSessionValid(source.accountId)).toBe(false);
		expect(await storage.getAuthToken(source.accountId)).toBeNull();
		expect(await storage.getVaultKeys(source.accountId)).toBeNull();
		expect(await storage.getEncryptedPrivateKey(source.accountId)).toBeNull();
		expect(await storage.getAutoLockTimeout(source.accountId)).toBe(0);
		expect(await storage.getMasterPasswordReentryPeriodMs()).toBe(-1);
		expect(session.createdAt >= started && session.createdAt <= finished).toBe(
			true,
		);
		expect(session.lastMasterPasswordEntry).toBe(session.createdAt);
		expect(session.sessionId).toBeUndefined();
		expect(session.serverExpiresAt).toBe(session.expiresAt);
		expect(session.expiresAt - session.createdAt).toBe(
			DEFAULT_SESSION_EXPIRY_MS,
		);
		expect(
			session.email === account.email && session.userId === account.userId,
		).toBe(true);
		expect(session.encryptedMasterUnlockKey.algorithm).toBe("AES-GCM-AAD-V1");
		// Compare through booleans so assertion failures never dump protected values.
		expect(
			JSON.stringify(session) ===
				protectedValues[accountKey(source.accountId, "session_data")],
		).toBe(true);
		const deviceBytes = Buffer.from(
			protectedValues[globalKey("device_key")] ?? "",
			"base64",
		);
		secretBytes.push(deviceBytes);
		const deviceKey = await crypto.importKey(deviceBytes);
		handles.push(deviceKey);
		const unwrapped = await crypto.unwrapKey(
			session.encryptedMasterUnlockKey,
			deviceKey,
			null,
		);
		handles.push(unwrapped);
		const derived = await crypto.deriveKeys(
			password,
			secretKey,
			account.email,
			profile,
		);
		handles.push(derived.authKey, derived.masterUnlockKey);
		const original = await crypto.exportKey(derived.masterUnlockKey);
		secretBytes.push(original);
		const restored = await crypto.exportKey(unwrapped);
		secretBytes.push(restored);
		expect(original.length).toBe(32);
		expect(restored.length).toBe(32);
		expect(original.every((byte, index) => byte === restored[index])).toBe(
			true,
		);
		expect(await storage.getMasterUnlockKey(source.accountId)).toBeNull();
		expect(httpCalls).toBe(0);
	} finally {
		try {
			await Promise.all(handles.map((handle) => crypto.destroyKey(handle)));
		} finally {
			try {
				await storage.clearAllStoredData(source?.accountId);
			} finally {
				for (const bytes of secretBytes) bytes.fill(0);
				source?.storeJson.fill(0);
				source?.syncStoreJson.fill(0);
				source?.protectedEntry.fill(0);
				primitives.keychain.entries.clear();
				primitives.keychain.calls.length = 0;
				primitives.keychain.recordCalls.length = 0;
				primitives.store.contents.clear();
				primitives.store.resetCallLog();
				fetch.mockRestore();
			}
		}
	}
}, 20_000);
