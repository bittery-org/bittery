import { expect, test } from "bun:test";
import {
	IDBObjectStore as FakeStore,
	IDBFactory,
	IDBKeyRange,
} from "fake-indexeddb";
import type {
	RecoveryRecord,
	ReplicaStore,
} from "../generated/recovery-control/contract";
import { openAttachmentArtifactDatabase } from "./indexeddb-attachment-artifact-executor-internal";
import {
	openReplicaDatabase,
	REPLICA_STORE_MAP,
} from "./indexeddb-executor-internal";
import { addRecoveryArtifact } from "./indexeddb-recovery-artifacts";
import { RecoveryRepairStage } from "./indexeddb-recovery-stage";
import { openVaultImageArtifactDatabase } from "./indexeddb-vault-image-artifact-executor";

const head = {
	accountId: "a",
	userId: "u",
	incarnation: "i",
	replicaRevision: "5",
	lockEpoch: "2",
	failure: null,
};
const nextHead = { ...head, replicaRevision: "6", lockEpoch: "3" };
const stores = Object.entries(REPLICA_STORE_MAP) as [ReplicaStore, string][];
const original = '{"accepted":"opaque original bytes 🌐"}';
const candidate = '{"candidate":"distinct replacement bytes 🔐"}';
const methods = ["add", "put", "delete", "clear"] as const;
type Fault = "throw" | "abortAfterWrite";

function freshDatabaseFamily() {
	Object.defineProperty(globalThis, "indexedDB", {
		configurable: true,
		value: new IDBFactory(),
	});
	Object.defineProperty(globalThis, "IDBKeyRange", {
		configurable: true,
		value: IDBKeyRange,
	});
}
function done(tx: IDBTransaction) {
	return new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
	});
}
async function seed() {
	freshDatabaseFamily();
	const db = await openReplicaDatabase();
	const tx = db.transaction(
		["heads", ...stores.map(([, physical]) => physical)],
		"readwrite",
	);
	for (const accountId of ["a", "b"]) {
		tx.objectStore("heads").put({ ...head, accountId });
		for (const [, physical] of stores)
			tx.objectStore(physical).put({
				accountId,
				recordId: "row",
				payloadJson: original,
			});
	}
	await done(tx);
	db.close();
	// Physical fixtures deliberately remain opaque; Core accepted-work validation is tested separately.
	for (const [record, bytes] of artifactEntries("b"))
		await addRecoveryArtifact("b", record, bytes);
}
async function snapshot(open: () => Promise<IDBDatabase>, includeStage = true) {
	const db = await open();
	const names = Array.from(db.objectStoreNames).filter(
		(name) => includeStage || name !== "recovery_input",
	);
	const tx = db.transaction(names, "readonly");
	const completion = done(tx);
	const rows = await Promise.all(
		names.map(
			(name) =>
				new Promise<[string, unknown[]]>((resolve, reject) => {
					const request = tx.objectStore(name).getAll();
					request.onsuccess = () => resolve([name, request.result]);
					request.onerror = () => reject(request.error);
				}),
		),
	);
	await completion;
	db.close();
	return Object.fromEntries(rows);
}
const replica = (includeStage = true) =>
	snapshot(openReplicaDatabase, includeStage);
const artifacts = async () => [
	await snapshot(openAttachmentArtifactDatabase),
	await snapshot(openVaultImageArtifactDatabase),
];

/** Enumerate real adapter writes; abort only after the chosen request has actually succeeded. */
async function observeWrites<T>(
	action: () => Promise<T>,
	failAt = 0,
	fault: Fault = "throw",
) {
	const originals = new Map(
		methods.map((method) => [
			method,
			Object.getOwnPropertyDescriptor(FakeStore.prototype, method)!,
		]),
	);
	const writes: string[] = [];
	for (const method of methods) {
		const originalMethod = originals.get(method)!.value;
		Object.defineProperty(FakeStore.prototype, method, {
			...originals.get(method),
			value(this: IDBObjectStore, ...args: unknown[]) {
				const identity = `${this.transaction.db.name}/${this.name}/${method}`;
				const fail = writes.length + 1 === failAt;
				if (fail && fault === "throw") {
					writes.push(identity);
					throw new DOMException(
						"Injected write refusal",
						"QuotaExceededError",
					);
				}
				const request: IDBRequest = Reflect.apply(originalMethod, this, args);
				// Calls rejected because the transaction already aborted create no further request.
				writes.push(identity);
				if (fail)
					request.addEventListener("success", () => this.transaction.abort(), {
						once: true,
					});
				return request;
			},
		});
	}
	try {
		return { result: await action(), writes, error: undefined };
	} catch (error) {
		return { result: undefined, writes, error };
	} finally {
		for (const [method, descriptor] of originals)
			Object.defineProperty(FakeStore.prototype, method, descriptor);
	}
}
async function fillStage(stage: RecoveryRepairStage) {
	await stage.begin("r", "a");
	const hash = Buffer.from(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(original)),
	).toString("hex");
	for (const [store] of stores) {
		await stage.expected("r", "a", {
			store,
			recordId: "row",
			payloadSha256: hash,
		});
		const bytes = new TextEncoder().encode(candidate);
		await stage.start("r", "a", store, "row", bytes.length);
		await stage.chunk("r", "a", bytes.subarray(0, 7));
		await stage.chunk("r", "a", bytes.subarray(7));
		await stage.end("r", "a");
	}
}
const commit = (stage: RecoveryRepairStage) =>
	stage.commit({
		type: "commitRepair",
		recoveryId: "r",
		accountId: "a",
		expectedHeadJson: JSON.stringify(head),
		nextHead,
		expectedRowCount: stores.length,
		stagedRowCount: stores.length,
	});

function artifactEntries(accountId: string): [RecoveryRecord, Uint8Array?][] {
	const published = { accountId, artifactId: "artifact" };
	const provisional = {
		accountId,
		operationId: "op",
		attachmentId: "attachment",
		generation: "generation",
	};
	const image = { accountId, operationId: "image-op" };
	return [
		[
			{
				type: "artifactMetadata",
				...published,
				metadataJson: JSON.stringify(published),
			},
		],
		[
			{
				type: "artifactChunk",
				...published,
				chunkIndex: 0,
				chunkSha256: "a".repeat(64),
			},
			new Uint8Array([0, 255, 4]),
		],
		[
			{
				type: "provisionalMetadata",
				...provisional,
				metadataJson: JSON.stringify(provisional),
			},
		],
		[
			{
				type: "provisionalChunk",
				...provisional,
				chunkIndex: 0,
				chunkSha256: "b".repeat(64),
			},
			new Uint8Array([9, 0, 255]),
		],
		[
			{
				type: "vaultImageMetadata",
				...image,
				metadataJson: JSON.stringify(image),
			},
		],
		[
			{ type: "vaultImageChunk", ...image, chunkIndex: 0 },
			new Uint8Array([137, 80, 78, 71]),
		],
	];
}

test("every unreachable input write can fail without changing either Account, and a fresh retry succeeds", async () => {
	await seed();
	const baselineStage = new RecoveryRepairStage();
	const baseline = await observeWrites(() => fillStage(baselineStage));
	expect(baseline.error).toBeUndefined();
	expect(baseline.writes).toHaveLength(1 + stores.length * 5);
	for (const fault of ["throw", "abortAfterWrite"] as const) {
		for (let failAt = 1; failAt <= baseline.writes.length; failAt++) {
			await seed();
			const before = await replica(false);
			const beforeArtifacts = await artifacts();
			const stage = new RecoveryRepairStage();
			const failed = await observeWrites(() => fillStage(stage), failAt, fault);
			expect(failed.error).toBeDefined();
			expect(failed.writes).toEqual(baseline.writes.slice(0, failAt));
			expect(await replica(false)).toEqual(before);
			expect(await artifacts()).toEqual(beforeArtifacts);
			// begin clears only unreachable input from the interrupted attempt.
			const retry = new RecoveryRepairStage();
			await fillStage(retry);
			expect(await commit(retry)).toBe("repaired");
			assertRepaired(await replica());
		}
	}
}, 30_000);

test("every final replacement delete, row copy, head write and input cleanup abort restores the exact transaction", async () => {
	await seed();
	const baselineStage = new RecoveryRepairStage();
	await fillStage(baselineStage);
	const baseline = await observeWrites(() => commit(baselineStage));
	expect(baseline.result).toBe("repaired");
	expect(baseline.writes).toHaveLength(stores.length * 2 + 2);
	expect(baseline.writes.at(-2)).toBe("bittery_replica/heads/put");
	expect(baseline.writes.at(-1)).toBe("bittery_replica/recovery_input/delete");
	for (const fault of ["throw", "abortAfterWrite"] as const) {
		for (let failAt = 1; failAt <= baseline.writes.length; failAt++) {
			await seed();
			const stage = new RecoveryRepairStage();
			await fillStage(stage);
			const before = await replica();
			const beforeArtifacts = await artifacts();
			const failed = await observeWrites(() => commit(stage), failAt, fault);
			expect(failed.error).toBeDefined();
			expect(failed.writes).toEqual(baseline.writes.slice(0, failAt));
			expect(await replica()).toEqual(before);
			expect(await artifacts()).toEqual(beforeArtifacts);
			expect(await commit(stage)).toBe("repaired");
			assertRepaired(await replica());
		}
	}
}, 30_000);

test("every artifact addition fault retains only earlier immutable additions and never publishes Replica repair", async () => {
	const entries = artifactEntries("a");
	for (const fault of ["throw", "abortAfterWrite"] as const) {
		for (let failAt = 1; failAt <= entries.length; failAt++) {
			await seed();
			const beforeReplica = await replica();
			for (const [record, bytes] of entries.slice(0, failAt - 1))
				await addRecoveryArtifact("a", record, bytes);
			const committedPrefix = await artifacts();
			const [record, bytes] = entries[failAt - 1]!;
			const failed = await observeWrites(
				() => addRecoveryArtifact("a", record, bytes),
				1,
				fault,
			);
			expect(failed.error).toBeDefined();
			expect(failed.writes).toHaveLength(1);
			expect(await artifacts()).toEqual(committedPrefix);
			expect(await replica()).toEqual(beforeReplica);
			// Replaying the complete stream preserves earlier entries exactly and fills the missing suffix.
			for (const [retryRecord, retryBytes] of entries)
				await addRecoveryArtifact("a", retryRecord, retryBytes);
			const complete = await artifacts();
			for (const database of complete)
				for (const rows of Object.values(database))
					expect(rows).toHaveLength(2);
			expect(await replica()).toEqual(beforeReplica);
		}
	}
});

function assertRepaired(after: Record<string, unknown[]>) {
	expect(after.heads).toEqual([nextHead, { ...head, accountId: "b" }]);
	expect(after.recovery_input).toEqual([]);
	for (const [, physical] of stores)
		expect(after[physical]).toEqual([
			{ accountId: "a", recordId: "row", payloadJson: candidate },
			{ accountId: "b", recordId: "row", payloadJson: original },
		]);
}
