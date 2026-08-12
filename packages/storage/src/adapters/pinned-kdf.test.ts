/**
 * Pinned KDF profiles, at the level where the policy actually lives.
 *
 * Pinning is not a platform concern: `AccountStore` owns it, `parseStoredKdfProfile` is
 * called from exactly one place, and `pinned_kdf_params` is plain / device-bound on every
 * platform.
 *
 * So the suite runs against `AccountStore` over the in-memory port, parameterised over both
 * values of `sessionSurvivesRestart` — the only axis on which the four platforms differ.
 * Passing under both is the statement that all four behave identically here, restart
 * included.
 *
 * Why an account-scoped pin matters at all: an account keyed at an older iteration count
 * cannot decrypt its own data if a later login silently re-derives at the current default
 * (issue #32). A pin that leaks between accounts, or that survives as a single shared
 * device-wide value, reintroduces exactly that bug — hence the isolation tests below.
 */

import { describe, expect, it } from "bun:test";
import type { CryptoPort, KdfProfile } from "@bittery/crypto-port";
import { validateKdfProfileOrThrow } from "@bittery/shared/kdf-policy";
import { type AccountStore, createAccountStore } from "../account-store";
import { accountKey, globalKey } from "../keys";
import {
	createInMemoryPlatformPort,
	type InMemoryPlatformPort,
} from "../testing/in-memory-port";

/**
 * The pin is never encrypted — it is `plain` tier — so a port that throws on every call is
 * exactly the right double here: any crypto call at all is a bug. A proxy rather than 38
 * hand-written throwing members, so it cannot go stale as `CryptoPort` grows.
 */
const unusedCrypto = new Proxy({} as CryptoPort, {
	get: (_target, member) => () => {
		throw new Error(
			`pinned KDF profiles need no crypto; ${String(member)} was called`,
		);
	},
});

const profile600k: KdfProfile = {
	schemaVersion: 1,
	algorithm: "pbkdf2-sha256",
	iterations: 600_000,
};

/**
 * The obsolete device-wide pin key. Nothing writes or reads it any more, and there is no
 * legacy read path to preserve — local storage may be wiped.
 */
const OBSOLETE_SHARED_KEY = globalKey("pinned_kdf_params");

const pinKey = (accountId: string): string =>
	accountKey(accountId, "pinned_kdf_params");

interface Harness {
	port: InMemoryPlatformPort;
	store: AccountStore;
}

async function makeStore(sessionSurvivesRestart: boolean): Promise<Harness> {
	const port = createInMemoryPlatformPort({ sessionSurvivesRestart });
	const store = createAccountStore({ port, crypto: unusedCrypto });
	await store.initialize();
	return { port, store };
}

for (const sessionSurvivesRestart of [false, true]) {
	const label = sessionSurvivesRestart
		? "session survives restart (desktop, mobile)"
		: "session dies with the process (web, extension)";

	describe(`AccountStore — pinned KDF profiles — ${label}`, () => {
		it("returns the pin stored for the requested account", async () => {
			const { store } = await makeStore(sessionSurvivesRestart);

			await store.storePinnedKdfProfile(profile600k, "acct-a");

			expect(await store.getPinnedKdfProfile("acct-a")).toEqual(profile600k);
		});

		it("isolates pins between accounts", async () => {
			const { store } = await makeStore(sessionSurvivesRestart);

			await store.storePinnedKdfProfile(profile600k, "acct-a");

			expect(await store.getPinnedKdfProfile("acct-b")).toBeNull();
		});

		it("keeps a second account's differing pin intact", async () => {
			const { store } = await makeStore(sessionSurvivesRestart);
			const profile900k: KdfProfile = { ...profile600k, iterations: 900_000 };

			await store.storePinnedKdfProfile(profile600k, "acct-a");
			await store.storePinnedKdfProfile(profile900k, "acct-b");

			expect(await store.getPinnedKdfProfile("acct-a")).toEqual(profile600k);
			expect(await store.getPinnedKdfProfile("acct-b")).toEqual(profile900k);
		});

		it("never returns the obsolete shared pin", async () => {
			const { port, store } = await makeStore(sessionSurvivesRestart);
			await port.kvSet(
				OBSOLETE_SHARED_KEY,
				JSON.stringify(profile600k),
				"device",
			);

			expect(await store.getPinnedKdfProfile("acct-legacy")).toBeNull();
		});

		it("never writes the obsolete shared pin either", async () => {
			const { port, store } = await makeStore(sessionSurvivesRestart);

			await store.storePinnedKdfProfile(profile600k, "acct-a");

			// It cannot go stale, because nothing writes it — stronger than deleting it on
			// every scoped write.
			expect(port.snapshot().device[OBSOLETE_SHARED_KEY]).toBeUndefined();
			expect(port.snapshot().session[OBSOLETE_SHARED_KEY]).toBeUndefined();
		});

		it("fails safely when a scoped pin is malformed", async () => {
			const { port, store } = await makeStore(sessionSurvivesRestart);
			await port.kvSet(pinKey("acct-a"), "not json", "device");

			expect(await store.getPinnedKdfProfile("acct-a")).toBeNull();
		});

		it("fails safely when a scoped pin is valid JSON but not an object", async () => {
			const { port, store } = await makeStore(sessionSurvivesRestart);
			await port.kvSet(
				pinKey("acct-a"),
				JSON.stringify([profile600k]),
				"device",
			);

			expect(await store.getPinnedKdfProfile("acct-a")).toBeNull();
		});

		it("fails safely when a scoped pin violates KDF policy", async () => {
			const { port, store } = await makeStore(sessionSurvivesRestart);
			const rejected = {
				schemaVersion: 1,
				// Wrong case, and an iteration count below the policy minimum.
				algorithm: "PBKDF2-SHA256",
				iterations: 310_000,
			};
			// The rejection is the shared KDF policy's, not this test's opinion.
			expect(() => validateKdfProfileOrThrow(rejected)).toThrow();
			await port.kvSet(pinKey("acct-a"), JSON.stringify(rejected), "device");

			expect(await store.getPinnedKdfProfile("acct-a")).toBeNull();
		});

		it("returns null for an account that has never been pinned", async () => {
			const { store } = await makeStore(sessionSurvivesRestart);

			expect(await store.getPinnedKdfProfile("acct-a")).toBeNull();
		});

		it("survives a restart on every platform, because the pin is device-bound", async () => {
			const { port, store } = await makeStore(sessionSurvivesRestart);
			await store.storePinnedKdfProfile(profile600k, "acct-a");

			port.simulateRestart();

			// A pin routed to session scope would strand a web account on the wrong
			// iteration count after a browser restart. `pinned_kdf_params` is device-bound
			// precisely so that cannot happen.
			expect(await store.getPinnedKdfProfile("acct-a")).toEqual(profile600k);
		});

		it("stores the pin in the clear, never in the secret tier", async () => {
			const { port, store } = await makeStore(sessionSurvivesRestart);

			await store.storePinnedKdfProfile(profile600k, "acct-a");

			// Plain tier: KDF parameters are not a secret, and routing them to the keychain
			// would cost a keychain prompt on desktop for no benefit.
			expect(port.snapshot().device[pinKey("acct-a")]).toBe(
				JSON.stringify(profile600k),
			);
			expect(port.snapshot().secrets[pinKey("acct-a")]).toBeUndefined();
		});

		it("overwrites an existing pin rather than accumulating", async () => {
			const { port, store } = await makeStore(sessionSurvivesRestart);
			const profile900k: KdfProfile = { ...profile600k, iterations: 900_000 };

			await store.storePinnedKdfProfile(profile600k, "acct-a");
			await store.storePinnedKdfProfile(profile900k, "acct-a");

			expect(await store.getPinnedKdfProfile("acct-a")).toEqual(profile900k);
			expect(
				Object.keys(port.snapshot().device).filter((key) =>
					key.endsWith("pinned_kdf_params"),
				),
			).toEqual([pinKey("acct-a")]);
		});
	});
}
