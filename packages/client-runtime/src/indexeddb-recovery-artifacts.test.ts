import { beforeEach, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { openAttachmentArtifactDatabase } from "./indexeddb-attachment-artifact-executor-internal";
import { addRecoveryArtifact } from "./indexeddb-recovery-artifacts";
import { openVaultImageArtifactDatabase } from "./indexeddb-vault-image-artifact-executor";

beforeEach(() =>
	Object.defineProperty(globalThis, "indexedDB", {
		configurable: true,
		value: new IDBFactory(),
	}),
);
const record = {
	type: "vaultImageChunk" as const,
	accountId: "a",
	operationId: "op",
	chunkIndex: 0,
};
test("missing image bytes are added once; divergent present bytes and foreign scope are never overwritten", async () => {
	await addRecoveryArtifact("a", record, new Uint8Array([0, 255, 4]));
	await addRecoveryArtifact("a", record, new Uint8Array([0, 255, 4]));
	await expect(
		addRecoveryArtifact("a", record, new Uint8Array([1, 2, 3])),
	).rejects.toThrow();
	await expect(
		addRecoveryArtifact("b", record, new Uint8Array([1])),
	).rejects.toThrow();
	const db = await openVaultImageArtifactDatabase();
	const request = db
		.transaction("chunks", "readonly")
		.objectStore("chunks")
		.get(["a", "op", "", 0]);
	const stored = await new Promise<{ bytes: Uint8Array }>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	expect(stored.bytes).toEqual(new Uint8Array([0, 255, 4]));
	db.close();
});
test("metadata must retain its exact Account and artifact identity", async () => {
	await expect(
		addRecoveryArtifact("a", {
			type: "artifactMetadata",
			accountId: "a",
			artifactId: "artifact",
			metadataJson: '{"accountId":"b","artifactId":"artifact"}',
		}),
	).rejects.toThrow();
	await expect(
		addRecoveryArtifact("a", {
			type: "artifactMetadata",
			accountId: "a",
			artifactId: "artifact",
			metadataJson: '{"accountId":"a","artifactId":"other"}',
		}),
	).rejects.toThrow();
});

test("restored Attachment chunks retain the physical ArrayBuffer representation and compare existing bytes exactly", async () => {
	const chunk = {
		type: "artifactChunk" as const,
		accountId: "a",
		artifactId: "artifact",
		chunkIndex: 0,
		chunkSha256: "a".repeat(64),
	};
	await addRecoveryArtifact("a", chunk, new Uint8Array([1, 255, 3]));
	const db = await openAttachmentArtifactDatabase();
	const read = () =>
		new Promise<any>((resolve, reject) => {
			const request = db
				.transaction("chunks")
				.objectStore("chunks")
				.get(["a", "artifact", 0]);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
	const before = await read();
	expect(before.bytes).toBeInstanceOf(ArrayBuffer);
	await addRecoveryArtifact("a", chunk, new Uint8Array([1, 255, 3]));
	await expect(
		addRecoveryArtifact("a", chunk, new Uint8Array([1, 0, 3])),
	).rejects.toThrow();
	expect(await read()).toEqual(before);
	db.close();
});

test("protected image repair preserves raw and protected siblings and refuses generation substitution", async () => {
	await addRecoveryArtifact("a", record, new Uint8Array([9]));
	const protectedRecord = {
		...record,
		type: "protectedVaultImageChunk" as const,
		publicationId: "protected-a",
	};
	await addRecoveryArtifact("a", protectedRecord, new Uint8Array([1, 255]));
	await addRecoveryArtifact("a", protectedRecord, new Uint8Array([1, 255]));
	await addRecoveryArtifact(
		"a",
		{ ...protectedRecord, publicationId: "protected-b" },
		new Uint8Array([2]),
	);
	await expect(
		addRecoveryArtifact("a", protectedRecord, new Uint8Array([2])),
	).rejects.toThrow();
	await expect(
		addRecoveryArtifact(
			"a",
			{ ...protectedRecord, publicationId: "" },
			new Uint8Array([9]),
		),
	).rejects.toThrow();
	await expect(
		addRecoveryArtifact("a", {
			type: "vaultImageMetadata",
			accountId: "a",
			operationId: "op",
			metadataJson: JSON.stringify({
				accountId: "a",
				operationId: "op",
				publicationId: "protected-a",
				protection: { opaque: true },
			}),
		}),
	).rejects.toThrow();
	const db = await openVaultImageArtifactDatabase();
	const get = db.transaction("chunks").objectStore("chunks").getAll();
	const rows = await new Promise<
		Array<{ publicationId: string; bytes: Uint8Array }>
	>((resolve, reject) => {
		get.onsuccess = () => resolve(get.result);
		get.onerror = () => reject(get.error);
	});
	expect(rows.map((row) => [row.publicationId, [...row.bytes]])).toEqual([
		["", [9]],
		["protected-a", [1, 255]],
		["protected-b", [2]],
	]);
	db.close();
});
