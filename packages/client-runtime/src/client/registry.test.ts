import { describe, expect, test } from "bun:test";
import { createFakeRuntimeTransport, createManualClock } from "../testing";
import { createRuntimeClient } from "./index";

function itemsProjection(accountId: string, title: string) {
	return {
		type: "items" as const,
		value: {
			accountId,
			replicaRevision: "1",
			vaults: [],
			items: [
				{
					itemId: "item-1",
					accountId,
					vaultId: "vault-1",
					title,
					status: "authoritative" as const,
					favorite: false,
					createdAt: "2026-08-23T00:00:00Z",
					updatedAt: "2026-08-23T00:00:00Z",
				},
			],
		},
	};
}

describe("observation registry", () => {
	test("mints observation ids instead of deriving them from the Account", async () => {
		const transport = createFakeRuntimeTransport();
		const clock = createManualClock();
		const client = createRuntimeClient({ transport, schedule: clock.schedule });

		const items = client.items("account-1");
		const status = client.status("account-1");
		items.subscribe(() => undefined);
		status.subscribe(() => undefined);
		await transport.settled();

		const ids = transport.openObservations().map((open) => open.observationId);
		expect(ids).toHaveLength(2);
		expect(new Set(ids).size).toBe(2);
		for (const id of ids) {
			expect(id).not.toContain("account-1");
		}
	});

	test("returns one store per logical observation and one transport observation", async () => {
		const transport = createFakeRuntimeTransport();
		const clock = createManualClock();
		const client = createRuntimeClient({ transport, schedule: clock.schedule });

		expect(client.items("account-1")).toBe(client.items("account-1"));
		expect(client.items("account-1")).not.toBe(client.items("account-2"));

		const store = client.items("account-1");
		const first: string[] = [];
		const second: string[] = [];
		const stopFirst = store.subscribe(() => {
			const snapshot = store.getSnapshot();
			if (snapshot.state === "ready")
				first.push(snapshot.value.items[0]?.title ?? "");
		});
		const stopSecond = store.subscribe(() => {
			const snapshot = store.getSnapshot();
			if (snapshot.state === "ready")
				second.push(snapshot.value.items[0]?.title ?? "");
		});
		await transport.settled();

		expect(transport.openObservations()).toHaveLength(1);
		transport.publish(itemsProjection("account-1", "first"));
		expect(first).toEqual(["first"]);
		expect(second).toEqual(["first"]);

		stopSecond();
		await transport.settled();
		transport.publish(itemsProjection("account-1", "second"));
		expect(first).toEqual(["first", "second"]);
		expect(transport.openObservations()).toHaveLength(1);

		stopFirst();
	});

	test("caches a frozen snapshot between publishes", async () => {
		const transport = createFakeRuntimeTransport();
		const clock = createManualClock();
		const client = createRuntimeClient({ transport, schedule: clock.schedule });
		const store = client.items("account-1");

		expect(store.getSnapshot()).toBe(store.getSnapshot());
		expect(store.getSnapshot().state).toBe("idle");
		expect(Object.isFrozen(store.getSnapshot())).toBe(true);

		store.subscribe(() => undefined);
		expect(store.getSnapshot().state).toBe("loading");
		await transport.settled();

		transport.publish(itemsProjection("account-1", "first"));
		const ready = store.getSnapshot();
		expect(ready.state).toBe("ready");
		expect(store.getSnapshot()).toBe(ready);
		expect(Object.isFrozen(ready)).toBe(true);
	});

	test("keeps subscribe and getSnapshot stable across publishes", async () => {
		const transport = createFakeRuntimeTransport();
		const clock = createManualClock();
		const client = createRuntimeClient({ transport, schedule: clock.schedule });
		const store = client.items("account-1");
		const { subscribe, getSnapshot } = store;

		const stop = store.subscribe(() => undefined);
		await transport.settled();
		transport.publish(itemsProjection("account-1", "first"));

		expect(client.items("account-1").subscribe).toBe(subscribe);
		expect(client.items("account-1").getSnapshot).toBe(getSnapshot);
		stop();
	});

	test("defers and cancels teardown, so a release/retain pair posts nothing", async () => {
		const transport = createFakeRuntimeTransport();
		const clock = createManualClock();
		const client = createRuntimeClient({ transport, schedule: clock.schedule });
		const store = client.items("account-1");

		const stop = store.subscribe(() => undefined);
		await transport.settled();
		expect(
			transport.calls.filter((call) => call.type === "observe"),
		).toHaveLength(1);

		stop();
		const restart = store.subscribe(() => undefined);
		await transport.settled();
		clock.runPending();
		await transport.settled();

		expect(
			transport.calls.filter((call) => call.type === "observe"),
		).toHaveLength(1);
		expect(
			transport.calls.filter((call) => call.type === "unobserve"),
		).toHaveLength(0);
		expect(transport.openObservations()).toHaveLength(1);
		restart();
	});

	test("collapses a synchronous unsubscribe/resubscribe into no transport traffic", async () => {
		const transport = createFakeRuntimeTransport();
		const clock = createManualClock();
		const client = createRuntimeClient({ transport, schedule: clock.schedule });
		const store = client.items("account-1");

		const first = store.subscribe(() => undefined);
		first();
		const second = store.subscribe(() => undefined);
		await transport.settled();
		clock.runPending();
		await transport.settled();

		expect(transport.calls.map((call) => call.type)).toEqual(["observe"]);
		second();
	});

	test("serializes per-key work, so observe never overtakes a pending unobserve", async () => {
		const transport = createFakeRuntimeTransport({ deferUnobserve: true });
		const clock = createManualClock();
		const client = createRuntimeClient({ transport, schedule: clock.schedule });
		const store = client.items("account-1");

		const stop = store.subscribe(() => undefined);
		await transport.settled();
		stop();
		clock.runPending();
		await Promise.resolve();

		// The unobserve is in flight; a new consumer arrives before it answers.
		const restart = store.subscribe(() => undefined);
		await Promise.resolve();
		expect(transport.calls.map((call) => call.type)).toEqual([
			"observe",
			"unobserve",
		]);

		transport.resolveUnobserve();
		await transport.settled();

		expect(transport.calls.map((call) => call.type)).toEqual([
			"observe",
			"unobserve",
			"observe",
		]);
		expect(transport.openObservations()).toHaveLength(1);
		restart();
	});

	test("keeps the last snapshot through the grace window and drops it after", async () => {
		const transport = createFakeRuntimeTransport();
		const clock = createManualClock();
		const client = createRuntimeClient({ transport, schedule: clock.schedule });
		const store = client.items("account-1");

		const stop = store.subscribe(() => undefined);
		await transport.settled();
		transport.publish(itemsProjection("account-1", "first"));
		stop();

		const inside = store.getSnapshot();
		expect(inside.state).toBe("ready");

		clock.runPending();
		await transport.settled();
		expect(store.getSnapshot().state).toBe("idle");
		expect(transport.openObservations()).toHaveLength(0);
	});

	test("reports a failed observation with its Runtime error code", async () => {
		const transport = createFakeRuntimeTransport();
		transport.failObservations({
			code: "ACCOUNT_MISSING",
			message: "no account",
		});
		const clock = createManualClock();
		const client = createRuntimeClient({ transport, schedule: clock.schedule });
		const store = client.items("account-1");

		store.subscribe(() => undefined);
		await transport.settled();

		const snapshot = store.getSnapshot();
		expect(snapshot).toEqual({ state: "failed", code: "ACCOUNT_MISSING" });
	});

	test("drops a projection published after teardown", async () => {
		const transport = createFakeRuntimeTransport();
		const clock = createManualClock();
		const client = createRuntimeClient({ transport, schedule: clock.schedule });
		const store = client.items("account-1");

		const stop = store.subscribe(() => undefined);
		await transport.settled();
		const [open] = transport.openObservations();
		stop();
		clock.runPending();
		await transport.settled();

		transport.publish(
			itemsProjection("account-1", "late"),
			open?.observationId,
		);
		expect(store.getSnapshot().state).toBe("idle");
	});
});
