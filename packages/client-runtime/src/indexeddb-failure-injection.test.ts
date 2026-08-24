import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { IDBFactory } from "fake-indexeddb";
import type {
	PreparedReplicaInstall,
	ReplicaPersistenceRequest,
	ReplicaPersistenceResponse,
} from "../generated/persistence/contract.ts";
import {
	createTestIndexedDbReplicaExecutor,
	type TestIndexedDbReplicaExecutor,
} from "./testing/index.ts";

const corpus = JSON.parse(
	readFileSync(
		new URL(
			"../generated/replica-conformance/history-corpus.json",
			import.meta.url,
		),
		"utf8",
	),
) as {
	histories: Array<{
		name: string;
		steps: Array<{ label: string; request: ReplicaPersistenceRequest }>;
	}>;
};

beforeEach(() => {
	Object.defineProperty(globalThis, "indexedDB", {
		configurable: true,
		value: new IDBFactory(),
	});
});

afterEach(() => {
	Reflect.deleteProperty(globalThis, "indexedDB");
});

function history(name: string) {
	const found = corpus.histories.find((candidate) => candidate.name === name);
	if (!found) throw new Error(`missing corpus history ${name}`);
	return found;
}

function requestWithLabel(
	historyName: string,
	label: string,
): ReplicaPersistenceRequest {
	const step = history(historyName).steps.find(
		(candidate) => candidate.label === label,
	);
	if (!step) throw new Error(`missing corpus step ${label}`);
	return structuredClone(step.request);
}

function executor(databaseName: string, failAfterWrite?: number) {
	return createTestIndexedDbReplicaExecutor({ databaseName, failAfterWrite });
}

async function invoke(
	target: TestIndexedDbReplicaExecutor,
	request: ReplicaPersistenceRequest,
): Promise<ReplicaPersistenceResponse> {
	return JSON.parse(await target.invoke(JSON.stringify(request)));
}

async function loaded(target: TestIndexedDbReplicaExecutor, accountId: string) {
	return invoke(target, { type: "load", accountId });
}

describe("IndexedDB Replica transaction failure injection", () => {
	test("rejects cross-Account Put and Delete without changing either Account", async () => {
		const databaseName = "cross-account-write-scope";
		const target = executor(databaseName);
		const accountA = requestWithLabel(
			"installation-guards-account-isolation-and-incarnation",
			"install account-a first incarnation",
		);
		const accountB = requestWithLabel(
			"installation-guards-account-isolation-and-incarnation",
			"install isolated account-b",
		);
		const accepted = requestWithLabel(
			"installation-guards-account-isolation-and-incarnation",
			"accept Account-scoped encrypted Operation and overlay",
		);
		if (
			accountA.type !== "install" ||
			accountB.type !== "install" ||
			accepted.type !== "commit"
		) {
			throw new Error("corpus representatives have unexpected request types");
		}
		const representativePut = accepted.prepared.writes[0];
		if (representativePut?.type !== "put") {
			throw new Error("expected representative Put");
		}
		await invoke(target, accountB);
		const seedAccountB = structuredClone(accepted);
		seedAccountB.prepared.expected = {
			accountId: "account-b",
			userId: "user-account-b",
			incarnation: "incarnation-account-b-first",
			replicaRevision: "0",
			lockEpoch: "0",
		};
		seedAccountB.prepared.nextHead = {
			...seedAccountB.prepared.nextHead,
			accountId: "account-b",
			userId: "user-account-b",
			incarnation: "incarnation-account-b-first",
			replicaRevision: "1",
		};
		seedAccountB.prepared.writes = [
			{
				type: "put",
				row: {
					...representativePut.row,
					key: { accountId: "account-b", recordId: "operation-b" },
				},
			},
		];
		await invoke(target, seedAccountB);
		const accountBBefore = await loaded(target, "account-b");
		expect(accountBBefore).toMatchObject({
			rows: [
				expect.objectContaining({
					store: "operations",
					key: { accountId: "account-b", recordId: "operation-b" },
				}),
			],
		});
		const crossAccountPut: ReplicaPersistenceRequest = {
			type: "install",
			prepared: {
				...accountA.prepared,
				writes: [
					{
						type: "put",
						row: {
							...representativePut.row,
							key: {
								accountId: "account-b",
								recordId: "cross-account-put",
							},
						},
					},
				],
			},
		};
		await expect(invoke(target, crossAccountPut)).rejects.toThrow(
			"Account scope",
		);
		expect(await loaded(target, "account-a")).toEqual({
			type: "loaded",
			head: null,
			rows: [],
		});
		expect(await loaded(target, "account-b")).toEqual(accountBBefore);

		await invoke(target, accountA);
		const accountABefore = await loaded(target, "account-a");
		const crossAccountDelete = structuredClone(accepted);
		crossAccountDelete.prepared.writes = [
			{
				type: "delete",
				store: "operations",
				key: { accountId: "account-b", recordId: "operation-b" },
			},
		];
		await expect(invoke(target, crossAccountDelete)).rejects.toThrow(
			"Account scope",
		);
		expect(await loaded(target, "account-a")).toEqual(accountABefore);
		expect(await loaded(target, "account-b")).toEqual(accountBBefore);
	});

	test("leaves old state at every Install, Commit, and lock write boundary", async () => {
		const install = requestWithLabel(
			"installation-guards-account-isolation-and-incarnation",
			"install account-a first incarnation",
		);
		const accepted = requestWithLabel(
			"installation-guards-account-isolation-and-incarnation",
			"accept Account-scoped encrypted Operation and overlay",
		);
		if (install.type !== "install" || accepted.type !== "commit") {
			throw new Error("corpus representatives have unexpected request types");
		}
		const multiWriteInstall: ReplicaPersistenceRequest = {
			type: "install",
			prepared: {
				...install.prepared,
				writes: structuredClone(accepted.prepared.writes),
			} satisfies PreparedReplicaInstall,
		};
		for (let boundary = 1; boundary <= 3; boundary += 1) {
			const databaseName = `failure-install-${boundary}`;
			const normal = executor(databaseName);
			const oldState = await loaded(normal, "account-a");
			await expect(
				invoke(executor(databaseName, boundary), multiWriteInstall),
			).rejects.toThrow(`injected IndexedDB failure after write ${boundary}`);
			expect(await loaded(normal, "account-a")).toEqual(oldState);
		}

		const operationHistory = history(
			"operation-retry-outcome-and-receipt-reconciliation",
		);
		const reconciliationIndex = operationHistory.steps.findIndex(
			(step) =>
				step.label === "reconcile applied outcome receipt authority and Cursor",
		);
		if (reconciliationIndex < 0) throw new Error("missing reconciliation step");
		const reconciliation = operationHistory.steps[reconciliationIndex]?.request;
		if (reconciliation?.type !== "commit") {
			throw new Error("reconciliation representative must be a Commit");
		}
		for (
			let boundary = 1;
			boundary <= reconciliation.prepared.writes.length + 1;
			boundary += 1
		) {
			const databaseName = `failure-commit-${boundary}`;
			const normal = executor(databaseName);
			for (const step of operationHistory.steps.slice(0, reconciliationIndex)) {
				await invoke(normal, step.request);
			}
			const oldState = await loaded(normal, "account-operations");
			expect(oldState).toMatchObject({
				head: { accountId: "account-operations" },
			});
			await expect(
				invoke(executor(databaseName, boundary), reconciliation),
			).rejects.toThrow(`injected IndexedDB failure after write ${boundary}`);
			expect(await loaded(normal, "account-operations")).toEqual(oldState);
		}

		const databaseName = "failure-lock-1";
		const normal = executor(databaseName);
		const guardHistory = history(
			"installation-guards-account-isolation-and-incarnation",
		);
		const lockIndex = guardHistory.steps.findIndex(
			(step) =>
				step.label === "advance exact lock epoch without changing revision",
		);
		if (lockIndex < 0) throw new Error("missing lock step");
		for (const step of guardHistory.steps.slice(0, lockIndex)) {
			await invoke(normal, step.request);
		}
		const oldState = await loaded(normal, "account-a");
		const lock = guardHistory.steps[lockIndex]?.request;
		if (!lock) throw new Error("missing lock request");
		await expect(invoke(executor(databaseName, 1), lock)).rejects.toThrow(
			"injected IndexedDB failure after write 1",
		);
		expect(await loaded(normal, "account-a")).toEqual(oldState);
	});
});
