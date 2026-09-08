import { beforeEach, expect, test } from "bun:test";
import {
	IDBDatabase as FakeDatabase,
	IDBObjectStore as FakeObjectStore,
	IDBRequest as FakeRequest,
	IDBFactory,
	IDBKeyRange,
} from "fake-indexeddb";
import { openReplicaDatabase } from "./indexeddb-executor-internal";
import { RecoveryRepairStage } from "./indexeddb-recovery-stage";

const head = {
	accountId: "a",
	userId: "u",
	incarnation: "i",
	replicaRevision: "5",
	lockEpoch: "2",
	failure: null,
};
const nextHead = { ...head, replicaRevision: "6", lockEpoch: "3" };
beforeEach(() => {
	Object.defineProperty(globalThis, "indexedDB", {
		configurable: true,
		value: new IDBFactory(),
	});
	Object.defineProperty(globalThis, "IDBKeyRange", {
		configurable: true,
		value: IDBKeyRange,
	});
});
async function setup() {
	const db = await openReplicaDatabase();
	const tx = db.transaction(["heads", "operations"], "readwrite");
	tx.objectStore("heads").put(head);
	for (const accountId of ["a", "b"])
		tx.objectStore("operations").put({
			accountId,
			recordId: "op",
			payloadJson: '{"accepted":true}',
		});
	await done(tx);
	db.close();
}
function done(tx: IDBTransaction) {
	return new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onabort = () => reject(tx.error);
	});
}
async function rows() {
	const db = await openReplicaDatabase();
	const tx = db.transaction(
		["heads", "operations", "recovery_input"],
		"readonly",
	);
	const read = (name: string) =>
		new Promise<unknown[]>((resolve, reject) => {
			const req = tx.objectStore(name).getAll();
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
	const result = await Promise.all([
		read("heads"),
		read("operations"),
		read("recovery_input"),
	]);
	await done(tx);
	db.close();
	return result;
}
async function staged(signal?: () => AbortSignal | undefined) {
	const stage = new RecoveryRepairStage(signal);
	await stage.begin("r", "a");
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode('{"accepted":true}'),
	);
	await stage.expected("r", "a", {
		store: "operations",
		recordId: "op",
		payloadSha256: Buffer.from(digest).toString("hex"),
	});
	const bytes = new TextEncoder().encode('{"accepted":true,"repaired":true}');
	await stage.start("r", "a", "operations", "op", bytes.length);
	await stage.chunk("r", "a", bytes.subarray(0, 5));
	await stage.chunk("r", "a", bytes.subarray(5));
	await stage.end("r", "a");
	return stage;
}
test("staged repair is unreachable until exact guarded commit and preserves the other Account", async () => {
	await setup();
	const before = await rows();
	const stage = await staged();
	expect((await rows()).slice(0, 2)).toEqual(before.slice(0, 2));
	expect(
		await stage.commit({
			type: "commitRepair",
			recoveryId: "r",
			accountId: "a",
			expectedHeadJson: JSON.stringify(head),
			nextHead,
			expectedRowCount: 1,
			stagedRowCount: 1,
		}),
	).toBe("repaired");
	const after = await rows();
	expect(after[0]).toEqual([nextHead]);
	expect(after[1]).toEqual([
		{
			accountId: "a",
			recordId: "op",
			payloadJson: '{"accepted":true,"repaired":true}',
		},
		{ accountId: "b", recordId: "op", payloadJson: '{"accepted":true}' },
	]);
	expect(after[2]).toEqual([]);
});
test("hash completion resumes cursor work from an IndexedDB event in the same transaction", async () => {
	await setup();
	const stage = await staged();
	const descriptor = Object.getOwnPropertyDescriptor(crypto.subtle, "digest");
	const digest = crypto.subtle.digest.bind(crypto.subtle);
	const dispatch = FakeRequest.prototype.dispatchEvent;
	const advance = FakeObjectStore.prototype.openCursor;
	let externalHashTask = false;
	let resumedEvents = 0;
	// Firefox keeps the transaction alive but inactive in the external WebCrypto task.
	// fake-indexeddb otherwise permits this, so reproduce that boundary explicitly.
	Object.defineProperty(crypto.subtle, "digest", {
		configurable: true,
		value: async (...args: Parameters<SubtleCrypto["digest"]>) => {
			const result = await digest(...args);
			externalHashTask = true;
			return result;
		},
	});
	FakeRequest.prototype.dispatchEvent = function (
		...args: Parameters<IDBRequest["dispatchEvent"]>
	) {
		if (externalHashTask && args[0].type === "success") {
			externalHashTask = false;
			resumedEvents++;
		}
		return dispatch.apply(this, args);
	};
	FakeObjectStore.prototype.openCursor = function (
		...args: Parameters<IDBObjectStore["openCursor"]>
	) {
		if (externalHashTask)
			throw new DOMException(
				"External hash task is not an active IDB callback",
				"TransactionInactiveError",
			);
		return advance.apply(this, args);
	};
	try {
		expect(
			await stage.commit({
				type: "commitRepair",
				recoveryId: "r",
				accountId: "a",
				expectedHeadJson: JSON.stringify(head),
				nextHead,
				expectedRowCount: 1,
				stagedRowCount: 1,
			}),
		).toBe("repaired");
		expect(resumedEvents).toBe(1);
		const after = await rows();
		expect(after[0]).toEqual([nextHead]);
		expect(after[1]).toEqual([
			{
				accountId: "a",
				recordId: "op",
				payloadJson: '{"accepted":true,"repaired":true}',
			},
			{ accountId: "b", recordId: "op", payloadJson: '{"accepted":true}' },
		]);
		expect(after[2]).toEqual([]);
	} finally {
		FakeRequest.prototype.dispatchEvent = dispatch;
		FakeObjectStore.prototype.openCursor = advance;
		if (descriptor) Object.defineProperty(crypto.subtle, "digest", descriptor);
		else Reflect.deleteProperty(crypto.subtle, "digest");
	}
});

test("cancellation while awaiting the next active IDB event aborts and drains the guarded transaction", async () => {
	await setup();
	const controller = new AbortController();
	const stage = await staged(() => controller.signal);
	const before = await rows();
	const listen = FakeRequest.prototype.addEventListener;
	let enteredGate = false;
	FakeRequest.prototype.addEventListener = function (
		...args: Parameters<IDBRequest["addEventListener"]>
	) {
		const result = listen.apply(this, args);
		if (args[0] === "success" && !enteredGate) {
			enteredGate = true;
			controller.abort(
				new DOMException("Injected active-task cancellation", "AbortError"),
			);
		}
		return result;
	};
	try {
		await expect(
			stage.commit({
				type: "commitRepair",
				recoveryId: "r",
				accountId: "a",
				expectedHeadJson: JSON.stringify(head),
				nextHead,
				expectedRowCount: 1,
				stagedRowCount: 1,
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(enteredGate).toBe(true);
		expect(await rows()).toEqual(before);
	} finally {
		FakeRequest.prototype.addEventListener = listen;
	}
});

test("live tampering after staging refuses atomically and retains original accepted bytes", async () => {
	await setup();
	const stage = await staged();
	const db = await openReplicaDatabase();
	const tx = db.transaction("operations", "readwrite");
	tx.objectStore("operations").put({
		accountId: "a",
		recordId: "op",
		payloadJson: '{"accepted":"changed"}',
	});
	await done(tx);
	db.close();
	const before = (await rows()).slice(0, 2);
	expect(
		await stage.commit({
			type: "commitRepair",
			recoveryId: "r",
			accountId: "a",
			expectedHeadJson: JSON.stringify(head),
			nextHead,
			expectedRowCount: 1,
			stagedRowCount: 1,
		}),
	).toBe("stale");
	expect((await rows()).slice(0, 2)).toEqual(before);
});
test("hash awaits retain the same transaction and competing writes cannot slip between guard and commit", async () => {
	await setup();
	const stage = await staged();
	const descriptor = Object.getOwnPropertyDescriptor(crypto.subtle, "digest");
	const digest = crypto.subtle.digest.bind(crypto.subtle);
	let release!: () => void;
	let entered!: () => void;
	const waiting = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	Object.defineProperty(crypto.subtle, "digest", {
		configurable: true,
		value: async (...args: Parameters<SubtleCrypto["digest"]>) => {
			entered();
			await gate;
			return digest(...args);
		},
	});
	try {
		const committing = stage.commit({
			type: "commitRepair",
			recoveryId: "r",
			accountId: "a",
			expectedHeadJson: JSON.stringify(head),
			nextHead,
			expectedRowCount: 1,
			stagedRowCount: 1,
		});
		await waiting;
		const db = await openReplicaDatabase();
		const tx = db.transaction("operations", "readwrite");
		let competitorFinished = false;
		const competing = done(tx).then(() => {
			competitorFinished = true;
		});
		tx.objectStore("operations").put({
			accountId: "b",
			recordId: "late",
			payloadJson: '{"other":true}',
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(competitorFinished).toBe(false);
		release();
		expect(await committing).toBe("repaired");
		await competing;
		db.close();
		expect((await rows())[0]).toEqual([nextHead]);
	} finally {
		release();
		if (descriptor) Object.defineProperty(crypto.subtle, "digest", descriptor);
		else Reflect.deleteProperty(crypto.subtle, "digest");
	}
});
test("malformed staged bytes abort after row deletion without changing the source or head", async () => {
	await setup();
	const stage = await staged();
	const before = (await rows()).slice(0, 2);
	const db = await openReplicaDatabase();
	const tx = db.transaction("recovery_input", "readwrite");
	tx.objectStore("recovery_input").delete([
		"a",
		"r",
		"chunk",
		"operations",
		"op",
		1,
	]);
	await done(tx);
	db.close();
	await expect(
		stage.commit({
			type: "commitRepair",
			recoveryId: "r",
			accountId: "a",
			expectedHeadJson: JSON.stringify(head),
			nextHead,
			expectedRowCount: 1,
			stagedRowCount: 1,
		}),
	).rejects.toThrow();
	expect((await rows()).slice(0, 2)).toEqual(before);
});
test("unpaired UTF-16 corruption cannot collide with a valid UTF-8 source guard", async () => {
	await setup();
	const stage = new RecoveryRepairStage();
	await stage.begin("r", "a");
	const valid = '{"value":"�"}';
	const hash = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(valid),
	);
	await stage.expected("r", "a", {
		store: "operations",
		recordId: "op",
		payloadSha256: Buffer.from(hash).toString("hex"),
	});
	const db = await openReplicaDatabase();
	const tx = db.transaction("operations", "readwrite");
	tx.objectStore("operations").put({
		accountId: "a",
		recordId: "op",
		payloadJson: '{"value":"\ud800"}',
	});
	await done(tx);
	db.close();
	const before = (await rows()).slice(0, 2);
	await expect(
		stage.commit({
			type: "commitRepair",
			recoveryId: "r",
			accountId: "a",
			expectedHeadJson: JSON.stringify(head),
			nextHead,
			expectedRowCount: 1,
			stagedRowCount: 0,
		}),
	).rejects.toThrow();
	expect((await rows()).slice(0, 2)).toEqual(before);
});

test("cancellation during the guarded transaction aborts and preserves accepted rows before a late hash returns", async () => {
	await setup();
	const controller = new AbortController();
	let signal: AbortSignal | undefined = controller.signal;
	const stage = await staged(() => signal);
	const before = (await rows()).slice(0, 2);
	const descriptor = Object.getOwnPropertyDescriptor(crypto.subtle, "digest");
	const digest = crypto.subtle.digest.bind(crypto.subtle);
	let enter!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	Object.defineProperty(crypto.subtle, "digest", {
		configurable: true,
		value: async (...args: Parameters<SubtleCrypto["digest"]>) => {
			enter();
			await gate;
			return digest(...args);
		},
	});
	try {
		const pending = stage.commit({
			type: "commitRepair",
			recoveryId: "r",
			accountId: "a",
			expectedHeadJson: JSON.stringify(head),
			nextHead,
			expectedRowCount: 1,
			stagedRowCount: 1,
		});
		await entered;
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect((await rows()).slice(0, 2)).toEqual(before);
		signal = undefined;
		await stage.close();
		expect((await rows())[2]).toEqual([]);
		release();
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect((await rows()).slice(0, 2)).toEqual(before);
	} finally {
		release();
		if (descriptor) Object.defineProperty(crypto.subtle, "digest", descriptor);
		else Reflect.deleteProperty(crypto.subtle, "digest");
	}
});

test("cancellation after transaction completion reports the committed repair truth", async () => {
	await setup();
	const controller = new AbortController();
	const stage = await staged(() => controller.signal);
	const transaction = FakeDatabase.prototype.transaction;
	FakeDatabase.prototype.transaction = function (
		...args: Parameters<IDBDatabase["transaction"]>
	) {
		const tx = transaction.apply(this, args);
		if (
			Array.from(tx.objectStoreNames).includes("heads") &&
			tx.mode === "readwrite"
		)
			tx.addEventListener("complete", () => controller.abort(), { once: true });
		return tx;
	};
	try {
		expect(
			await stage.commit({
				type: "commitRepair",
				recoveryId: "r",
				accountId: "a",
				expectedHeadJson: JSON.stringify(head),
				nextHead,
				expectedRowCount: 1,
				stagedRowCount: 1,
			}),
		).toBe("repaired");
		expect(controller.signal.aborted).toBe(true);
		expect((await rows())[0]).toEqual([nextHead]);
		expect((await rows())[2]).toEqual([]);
	} finally {
		FakeDatabase.prototype.transaction = transaction;
	}
});
