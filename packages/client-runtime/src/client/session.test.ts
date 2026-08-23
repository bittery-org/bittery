import { describe, expect, test } from "bun:test";
import type { RuntimeStatusProjection } from "../../generated/runtime-protocol/contract";
import { createFakeRuntimeTransport } from "../testing";
import { createRuntimeClient } from "./index";
import {
	createMemoryActiveAccountStorage,
	createWebActiveAccountStorage,
} from "./session";

function status(
	accounts: RuntimeStatusProjection["accounts"],
	revision = "1",
): { type: "runtimeStatus"; value: RuntimeStatusProjection } {
	return {
		type: "runtimeStatus",
		value: { accountId: null, accounts, closed: false, revision },
	};
}

function account(
	accountId: string,
	access: "signedOut" | "locked" | "unlocked",
	extra: Partial<RuntimeStatusProjection["accounts"][number]> = {},
): RuntimeStatusProjection["accounts"][number] {
	return {
		accountId,
		access,
		failure: null,
		replicaRevision: "1",
		...extra,
	};
}

async function openSession(
	storage = createMemoryActiveAccountStorage(),
	accounts: RuntimeStatusProjection["accounts"] = [],
) {
	const transport = createFakeRuntimeTransport();
	const client = createRuntimeClient({ transport, activeAccount: storage });
	const session = client.session();
	const release = session.subscribe(() => undefined);
	await transport.settled();
	if (accounts.length > 0) transport.publish(status(accounts));
	return { transport, client, session, release };
}

describe("active Account reconciliation", () => {
	test("Quick Unlock targets the Account the form offers, not a stale stored id", async () => {
		// The Device signed in as `account-stale` once; that pointer outlived the Account
		// the login form is now offering to unlock.
		const storage = createMemoryActiveAccountStorage("account-stale");
		const { client, transport, release } = await openSession(storage, [
			account("account-stale", "locked"),
			account("account-offered", "locked"),
		]);

		expect(client.resolveAccount("account-offered")).toBe("account-offered");

		void client.quickUnlock({
			accountId: client.resolveAccount("account-offered") ?? "",
			masterPassword: "password",
		});
		await transport.settled();
		expect(transport.pendingRequests()[0]?.request).toEqual({
			type: "quickUnlock",
			accountId: "account-offered",
			masterPassword: "password",
		});
		release();
	});

	test("a stored pointer the catalog denies never wins", async () => {
		const storage = createMemoryActiveAccountStorage("account-removed");
		const { client, session, release } = await openSession(storage, [
			account("account-1", "locked"),
			account("account-2", "locked"),
		]);

		expect(client.resolveAccount()).toBe(null);
		expect(session.getSnapshot()).toMatchObject({
			state: "missing",
			accountId: null,
		});
		release();
	});

	test("adopts the only installed Account when no pointer was stored", async () => {
		const { client, release } = await openSession(
			createMemoryActiveAccountStorage(),
			[account("account-1", "locked")],
		);
		expect(client.resolveAccount()).toBe("account-1");
		release();
	});

	test("keeps the stored pointer the catalog confirms", async () => {
		const { client, release } = await openSession(
			createMemoryActiveAccountStorage("account-2"),
			[account("account-1", "unlocked"), account("account-2", "locked")],
		);
		expect(client.resolveAccount()).toBe("account-2");
		release();
	});

	test("trusts an explicit offer while the catalog is still unknown", async () => {
		const { client, release } = await openSession(
			createMemoryActiveAccountStorage("account-stale"),
		);
		expect(client.resolveAccount("account-offered")).toBe("account-offered");
		release();
	});

	test("a successful Sign-in moves the pointer and persists it", async () => {
		const storage = createMemoryActiveAccountStorage();
		const { client, transport, release } = await openSession(storage);

		const signingIn = client.signIn({
			serverUrl: "https://server.test",
			email: "a@b.test",
			masterPassword: "password",
			secretKey: "A3-ABCDEF-GHIJKL-MNOPQ-RSTUV-WXYZ2",
			insecureTransportConfirmed: false,
		});
		await transport.settled();
		transport.answer({
			type: "succeeded",
			value: { type: "signedIn", accountId: "account-new", userId: "user-1" },
		});
		await signingIn;

		expect(storage.read()).toBe("account-new");
		release();
	});
});

describe("Device session states", () => {
	test("a restored but locked Account reports a lock, not an empty vault", async () => {
		const { transport, session, release } = await openSession(
			createMemoryActiveAccountStorage("account-1"),
		);

		transport.publish(status([account("account-1", "locked")]));
		expect(session.getSnapshot()).toMatchObject({
			state: "locked",
			accountId: "account-1",
			code: null,
		});
		release();
	});

	test("carries the waiting reason a reauthentication needs", async () => {
		const { transport, session, release } = await openSession(
			createMemoryActiveAccountStorage("account-1"),
		);
		transport.publish(
			status([
				account("account-1", "locked", {
					waitingReason: "reauthenticationRequired",
					failure: "AUTHENTICATION_REQUIRED",
				}),
			]),
		);
		expect(session.getSnapshot()).toMatchObject({
			state: "locked",
			waitingReason: "reauthenticationRequired",
			code: "AUTHENTICATION_REQUIRED",
		});
		release();
	});

	test("an unlocked Account reports the Account the host may observe", async () => {
		const { transport, session, release } = await openSession(
			createMemoryActiveAccountStorage("account-1"),
		);
		transport.publish(status([account("account-1", "unlocked")]));
		expect(session.getSnapshot()).toMatchObject({
			state: "unlocked",
			accountId: "account-1",
		});
		release();
	});

	test("an empty Device is signed out, not missing", async () => {
		const { transport, session, release } = await openSession();
		transport.publish(status([]));
		expect(session.getSnapshot()).toMatchObject({
			state: "signedOut",
			accountId: null,
		});
		release();
	});

	test("a closed Runtime is unavailable", async () => {
		const { transport, session, release } = await openSession();
		transport.publish({
			type: "runtimeStatus",
			value: {
				accountId: null,
				accounts: [],
				closed: true,
				revision: "9",
			},
		});
		expect(session.getSnapshot()).toMatchObject({
			state: "unavailable",
			code: "RUNTIME_CLOSED",
		});
		release();
	});

	test("a failed observation surfaces its code instead of an empty catalog", async () => {
		const transport = createFakeRuntimeTransport();
		transport.failObservations({
			code: "AUTHENTICATION_UNAVAILABLE",
			message: "no auth client configured at runtime.rs:700",
		});
		const client = createRuntimeClient({ transport });
		const session = client.session();
		const release = session.subscribe(() => undefined);
		await transport.settled();

		expect(session.getSnapshot()).toMatchObject({
			state: "unavailable",
			code: "AUTHENTICATION_UNAVAILABLE",
		});
		release();
	});

	test("returns the same snapshot object until something changes", async () => {
		const { transport, session, release } = await openSession(
			createMemoryActiveAccountStorage("account-1"),
		);
		transport.publish(status([account("account-1", "unlocked")]));
		expect(session.getSnapshot()).toBe(session.getSnapshot());
		release();
	});

	test("observes the Device, not one Account, so no Account can make it fail", async () => {
		const { transport, release } = await openSession();
		expect(transport.openObservations()[0]?.request).toEqual({
			type: "runtimeStatus",
			accountId: null,
		});
		release();
	});
});

describe("selection persistence", () => {
	test("is injected, and the web form reads and clears one key", () => {
		const values = new Map<string, string>();
		const storage = createWebActiveAccountStorage({
			getItem: (key) => values.get(key) ?? null,
			setItem: (key, value) => {
				values.set(key, value);
			},
			removeItem: (key) => {
				values.delete(key);
			},
		});
		expect(storage.read()).toBe(null);
		storage.write("account-1");
		expect([...values.keys()]).toEqual(["bittery_runtime_account_id"]);
		expect(storage.read()).toBe("account-1");
		storage.write(null);
		expect(values.size).toBe(0);
	});

	test("notifies subscribers when the host picks another Account", async () => {
		const { client, transport, session, release } = await openSession(
			createMemoryActiveAccountStorage("account-1"),
			[account("account-1", "unlocked"), account("account-2", "locked")],
		);
		let notifications = 0;
		const stop = session.subscribe(() => {
			notifications += 1;
		});
		await transport.settled();

		client.selectAccount("account-2");
		expect(notifications).toBeGreaterThan(0);
		expect(session.getSnapshot()).toMatchObject({
			state: "locked",
			accountId: "account-2",
		});
		stop();
		release();
	});
});

describe("retiring access", () => {
	test("signs out over the generated request and answers the new access state", async () => {
		const { client, transport, release } = await openSession();
		const signingOut = client.signOut("account-1");
		await transport.settled();
		expect(transport.pendingRequests()[0]?.request).toEqual({
			type: "signOut",
			accountId: "account-1",
		});
		transport.answer({
			type: "succeeded",
			value: {
				type: "accessChanged",
				accountId: "account-1",
				access: "signedOut",
			},
		});
		expect(await signingOut).toEqual({
			accountId: "account-1",
			access: "signedOut",
		});
		release();
	});

	test("locks over the generated request", async () => {
		const { client, transport, release } = await openSession();
		const locking = client.lock("account-1");
		await transport.settled();
		expect(transport.pendingRequests()[0]?.request).toEqual({
			type: "lock",
			accountId: "account-1",
		});
		transport.answer({
			type: "succeeded",
			value: {
				type: "accessChanged",
				accountId: "account-1",
				access: "locked",
			},
		});
		expect(await locking).toEqual({
			accountId: "account-1",
			access: "locked",
		});
		release();
	});
});
