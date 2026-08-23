import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
	createMemoryActiveAccountStorage,
	createRuntimeClient,
	LOADING_SESSION,
	type RuntimeSessionSnapshot,
} from "@bittery/client-runtime/client";
import { createFakeRuntimeTransport } from "@bittery/client-runtime/testing";
import {
	evaluateRuntimeSessionAccess,
	settledRuntimeSession,
} from "./runtime-session";

function session(
	partial: Partial<RuntimeSessionSnapshot>,
): RuntimeSessionSnapshot {
	return { ...LOADING_SESSION, ...partial } as RuntimeSessionSnapshot;
}

describe("the app route guard reads the Runtime, not a stored token", () => {
	test("lets an unlocked Account in", () => {
		expect(
			evaluateRuntimeSessionAccess(
				session({ state: "unlocked", accountId: "account-1" }),
			),
		).toBe(null);
	});

	test("sends a locked Account to the lock screen, not into an empty vault", () => {
		expect(
			evaluateRuntimeSessionAccess(
				session({ state: "locked", accountId: "account-1" }),
			),
		).toBe("/login");
	});

	test("sends every other state to the lock screen", () => {
		for (const state of [
			"loading",
			"unavailable",
			"missing",
			"signedOut",
		] as const) {
			expect(evaluateRuntimeSessionAccess(session({ state }))).toBe("/login");
		}
	});
});

describe("waiting for the Device to answer", () => {
	test("resolves on the first settled snapshot", async () => {
		const transport = createFakeRuntimeTransport();
		const client = createRuntimeClient({
			transport,
			activeAccount: createMemoryActiveAccountStorage("account-1"),
		});
		const store = client.session();
		const settling = settledRuntimeSession(store);
		await transport.settled();
		transport.publish({
			type: "runtimeStatus",
			value: {
				accountId: null,
				accounts: [
					{
						accountId: "account-1",
						access: "unlocked",
						failure: null,
						replicaRevision: "1",
					},
				],
				closed: false,
				revision: "1",
			},
		});

		expect(await settling).toMatchObject({
			state: "unlocked",
			accountId: "account-1",
		});
	});

	test("a broken transport settles as unavailable rather than hanging", async () => {
		const transport = createFakeRuntimeTransport();
		transport.failObservations({
			code: "RUNTIME_CLOSED",
			message: "worker gone at owner.ts:88",
		});
		const client = createRuntimeClient({ transport });
		const settled = await settledRuntimeSession(client.session());
		expect(settled).toMatchObject({
			state: "unavailable",
			code: "RUNTIME_CLOSED",
		});
		expect(evaluateRuntimeSessionAccess(settled)).toBe("/login");
	});
});

describe("the Runtime owns the session, and nothing mirrors it", () => {
	function source(relative: string): string {
		return readFileSync(new URL(relative, import.meta.url), "utf8");
	}

	test("the localStorage mirror is gone", () => {
		expect(existsSync(new URL("./runtime-auth.ts", import.meta.url))).toBe(
			false,
		);
	});

	test("Sign-in and Quick Unlock go through the typed client, and no sentinel", () => {
		const form = source("../components/sign-in-form.tsx");
		expect(form).toContain("runtimeClient.signIn");
		expect(form).toContain("runtimeClient.quickUnlock");
		// The Account the form offers, reconciled against the Runtime's catalog.
		expect(form).toContain(
			"runtimeClient.resolveAccount(quickUnlockAccountId)",
		);
		expect(form).not.toContain("getRuntimeAccountId");
		expect(form).not.toContain("runtime-session");
		expect(form).not.toContain("storeAuthToken");
		expect(form).not.toContain("performSRPLogin");
		expect(form).not.toContain("unlockAccountWithPassword");
	});

	test("no source writes the gate-bypass credential", () => {
		for (const relative of [
			"../components/sign-in-form.tsx",
			"../routes/_app.tsx",
			"../routes/index.tsx",
			"../router.tsx",
		]) {
			expect(source(relative)).not.toContain(
				'storeAuthToken("runtime-session")',
			);
		}
	});

	test("the app route guard reads the observed Runtime session", () => {
		const guard = source("../routes/_app.tsx");
		expect(guard).toContain("settledRuntimeSession(runtimeClient.session())");
		expect(guard).toContain("evaluateRuntimeSessionAccess");
		expect(guard).not.toContain("storage.isAuthenticated");
	});

	test("sign-out reaches the Runtime, not only the transitional store", () => {
		const sidebar = source("../components/layout/sidebar.tsx");
		expect(sidebar).toContain("runtimeClient.signOut");
		expect(sidebar).toContain("runtimeClient.selectAccount(null)");
	});

	test("the Worker gets a per-browser client id and the build's version", () => {
		const composition = source("./crypto.ts");
		expect(composition).toContain("getOrCreateClientId(window.localStorage)");
		expect(composition).toContain("import.meta.env.VITE_APP_VERSION");
		expect(composition).toContain("encodeRuntimeClientIdentity");
		expect(composition).not.toContain('"bittery-web"');

		const worker = source("./runtime.worker.ts");
		expect(worker).toContain("decodeRuntimeClientIdentity(self.name)");
		expect(worker).not.toContain('clientId: "bittery-web"');
		expect(worker).not.toContain('version: "0.5.2"');
	});

	test("one Device-wide observation is opened at the composition root", () => {
		const composition = source("./crypto.ts");
		expect(composition).toContain("runtimeClient.session().subscribe");
	});
});
