import { beforeEach, expect, test } from "bun:test";
import {
	IDBObjectStore as FakeStore,
	IDBFactory,
	IDBKeyRange,
} from "fake-indexeddb";
import { openAttachmentArtifactDatabase } from "./indexeddb-attachment-artifact-executor-internal";
import { openReplicaDatabase } from "./indexeddb-executor-internal";
import {
	RecoveryAccountReader,
	RecoveryRecordReader,
} from "./indexeddb-recovery-records";
import { openVaultImageArtifactDatabase } from "./indexeddb-vault-image-artifact-executor";
import { assertRecoveryTextBound } from "./recovery-json";

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
test("one-entry recovery scan preserves opaque payloads and never enumerates another Account", async () => {
	const db = await openReplicaDatabase();
	const tx = db.transaction(["heads", "operations"], "readwrite");
	for (const accountId of ["a", "b"]) {
		tx.objectStore("heads").put({ accountId, opaque: "rawhead" });
		tx.objectStore("operations").put({
			accountId,
			recordId: "op",
			payloadJson: '{ "immutable": [2, 1] }',
		});
	}
	await new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onabort = () => reject(tx.error);
	});
	db.close();
	const reader = new RecoveryRecordReader();
	const first = await reader.read("a");
	if (first.control.type !== "entry") throw new Error("expected first row");
	expect(first.control.record).toEqual({
		type: "rawReplicaHead",
		accountId: "a",
		payloadJson: '{"accountId":"a","opaque":"rawhead"}',
	});
	const second = await reader.read("a", first.control.nextCursor);
	if (second.control.type !== "entry") throw new Error("expected second row");
	expect(second.control.record).toEqual({
		type: "rawReplicaRow",
		accountId: "a",
		store: "operations",
		recordId: "op",
		payloadJson: '{ "immutable": [2, 1] }',
	});
	await expect(reader.read("b", second.control.nextCursor)).rejects.toThrow();
	const end = await reader.read("a", second.control.nextCursor);
	expect(end.control.type).toBe("end");
});
test("raw recovery text limit counts UTF-8 and rejects unpaired surrogates", () => {
	for (const text of ["abc", "é", "€", "😀", "\\ud800"]) {
		const bytes = new TextEncoder().encode(text).byteLength;
		expect(() => assertRecoveryTextBound(text, bytes)).not.toThrow();
		expect(() => assertRecoveryTextBound(text, bytes - 1)).toThrow();
	}
});
test("forged or reused continuation cannot select a store or rewind a recovery scan", async () => {
	const reader = new RecoveryRecordReader();
	await expect(reader.read("a", "heads/other-account")).rejects.toThrow();
	const end = await reader.read("a");
	expect(end.control.type).toBe("end");
});

test("unpaired physical UTF-16 is refused rather than replaced during recovery", () => {
	for (const text of ["\ud800", "\udc00"])
		expect(() => assertRecoveryTextBound(text)).toThrow();
});
test("capture refuses unpaired stored text without mutation and preserves supplementary Unicode exactly", async () => {
	const db = await openReplicaDatabase();
	const payload = '{"value":"😀"}';
	let tx = db.transaction("operations", "readwrite");
	tx.objectStore("operations").put({
		accountId: "a",
		recordId: "op",
		payloadJson: payload,
	});
	await new Promise<void>((resolve) => {
		tx.oncomplete = () => resolve();
	});
	const valid = await new RecoveryRecordReader().read("a");
	expect(valid.control.type).toBe("entry");
	if (
		valid.control.type !== "entry" ||
		valid.control.record.type !== "rawReplicaRow"
	)
		throw new Error("expected row");
	expect(valid.control.record.payloadJson).toBe(payload);
	const malformed = '{"value":"\ud800"}';
	tx = db.transaction("operations", "readwrite");
	tx.objectStore("operations").put({
		accountId: "a",
		recordId: "op",
		payloadJson: malformed,
	});
	await new Promise<void>((resolve) => {
		tx.oncomplete = () => resolve();
	});
	await expect(new RecoveryRecordReader().read("a")).rejects.toThrow();
	const request = db
		.transaction("operations", "readonly")
		.objectStore("operations")
		.get(["a", "op"]);
	const after = await new Promise<{ payloadJson: string }>((resolve) => {
		request.onsuccess = () => resolve(request.result);
	});
	expect(after.payloadJson).toBe(malformed);
	db.close();
});
test("a failed middle entry never consumes its valid continuation", async () => {
	const db = await openReplicaDatabase();
	const tx = db.transaction(["heads", "operations"], "readwrite");
	tx.objectStore("heads").put({ accountId: "a" });
	tx.objectStore("operations").put({
		accountId: "a",
		recordId: "op",
		payloadJson: "\ud800",
	});
	await new Promise<void>((resolve) => {
		tx.oncomplete = () => resolve();
	});
	db.close();
	const reader = new RecoveryRecordReader();
	const first = await reader.read("a");
	if (first.control.type !== "entry") throw new Error("expected head");
	for (let attempt = 0; attempt < 2; attempt++)
		await expect(reader.read("a", first.control.nextCursor)).rejects.toThrow();
});

test("oversized physical artifact bytes refuse capture repeatedly without altering the stored evidence", async () => {
	const db = await openAttachmentArtifactDatabase();
	const bytes = new Uint8Array(262145);
	bytes[262144] = 231;
	const tx = db.transaction("chunks", "readwrite");
	tx.objectStore("chunks").put({
		accountId: "a",
		artifactId: "artifact",
		chunkIndex: 0,
		chunkSha256: "a".repeat(64),
		bytes: bytes.buffer,
	});
	await new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onabort = () => reject(tx.error);
	});
	for (let attempt = 0; attempt < 2; attempt++)
		await expect(new RecoveryRecordReader().read("a")).rejects.toMatchObject({
			code: "SIZE_REJECTED",
			recoveryBound: "chunkBytes",
		});
	const get = db
		.transaction("chunks")
		.objectStore("chunks")
		.get(["a", "artifact", 0]);
	const after = await new Promise<{ bytes: ArrayBuffer }>((resolve) => {
		get.onsuccess = () => resolve(get.result);
	});
	expect(new Uint8Array(after.bytes)).toEqual(bytes);
	db.close();
});
test("physical Account inventory discovers orphaned scopes across all three databases without inventing metadata", async () => {
	const stores = [
		{
			open: openReplicaDatabase,
			name: "operations",
			value: {
				accountId: "replica-only",
				recordId: "op",
				payloadJson: "broken",
			},
		},
		{
			open: openAttachmentArtifactDatabase,
			name: "artifacts",
			value: { accountId: "attachment-only", artifactId: "artifact" },
		},
		{
			open: openVaultImageArtifactDatabase,
			name: "artifacts",
			value: { accountId: "image-only", operationId: "op", publicationId: "" },
		},
	];
	for (const entry of stores) {
		const db = await entry.open();
		const tx = db.transaction(entry.name, "readwrite");
		tx.objectStore(entry.name).put(entry.value);
		await new Promise<void>((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onabort = () => reject(tx.error);
		});
		db.close();
	}
	const reader = new RecoveryAccountReader();
	const found: string[] = [];
	let cursor: string | null | undefined;
	for (let i = 0; i < 10; i++) {
		const result = await reader.read(cursor);
		if (result.control.type === "end") break;
		if (result.control.type !== "accountEntry")
			throw new Error("expected account");
		found.push(result.control.accountId);
		cursor = result.control.nextCursor;
	}
	expect(found.sort()).toEqual([
		"attachment-only",
		"image-only",
		"replica-only",
	]);
	await expect(reader.read("foreign-continuation")).rejects.toThrow();
});

test("capture cancellation aborts the active readonly transaction without consuming stored evidence", async () => {
	const db = await openReplicaDatabase();
	const tx = db.transaction("operations", "readwrite");
	const row = {
		accountId: "a",
		recordId: "op",
		payloadJson: '{"accepted":true}',
	};
	tx.objectStore("operations").put(row);
	await new Promise<void>((resolve) => {
		tx.oncomplete = () => resolve();
	});
	db.close();
	const controller = new AbortController();
	const open = FakeStore.prototype.openCursor;
	FakeStore.prototype.openCursor = function (
		...args: Parameters<IDBObjectStore["openCursor"]>
	) {
		const request = open.apply(this, args);
		if (this.name === "operations") controller.abort();
		return request;
	};
	try {
		await expect(
			new RecoveryRecordReader().read("a", undefined, controller.signal),
		).rejects.toMatchObject({ name: "AbortError" });
	} finally {
		FakeStore.prototype.openCursor = open;
	}
	const result = await new RecoveryRecordReader().read("a");
	expect(result.control).toMatchObject({
		type: "entry",
		record: {
			type: "rawReplicaRow",
			accountId: "a",
			recordId: "op",
			payloadJson: row.payloadJson,
		},
	});
});

test("image recovery captures raw and protected siblings without losing publication identity", async () => {
	const db = await openVaultImageArtifactDatabase();
	const tx = db.transaction(["artifacts", "chunks"], "readwrite");
	for (const publicationId of ["", "protected-a", "protected-b"]) {
		tx.objectStore("artifacts").put({
			accountId: "a",
			operationId: "op",
			publicationId,
			...(publicationId ? { protection: { opaque: publicationId } } : {}),
		});
		tx.objectStore("chunks").put({
			accountId: "a",
			operationId: "op",
			publicationId,
			chunkIndex: 0,
			bytes: new Uint8Array([1, 255]),
		});
	}
	await new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onabort = () => reject(tx.error);
	});
	db.close();
	const reader = new RecoveryRecordReader();
	const records = [];
	let cursor: string | null | undefined;
	for (;;) {
		const result = await reader.read("a", cursor);
		if (result.control.type === "end") break;
		if (result.control.type !== "entry") throw new Error("expected entry");
		records.push(result);
		cursor = result.control.nextCursor;
	}
	expect(
		records.map((value) =>
			value.control.type === "entry" ? value.control.record.type : "",
		),
	).toEqual([
		"vaultImageMetadata",
		"protectedVaultImageMetadata",
		"protectedVaultImageMetadata",
		"vaultImageChunk",
		"protectedVaultImageChunk",
		"protectedVaultImageChunk",
	]);
	expect(records[1]?.control).toMatchObject({
		record: {
			publicationId: "protected-a",
			metadataJson: JSON.stringify({
				accountId: "a",
				operationId: "op",
				publicationId: "protected-a",
				protection: { opaque: "protected-a" },
			}),
		},
	});
	expect(records[5]?.binaryChunk).toEqual(new Uint8Array([1, 255]));
});
