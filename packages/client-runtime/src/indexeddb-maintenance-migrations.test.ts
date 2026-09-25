import { beforeEach, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { openAttachmentArtifactDatabase } from "./indexeddb-attachment-artifact-executor-internal";
import { openReplicaDatabase } from "./indexeddb-executor-internal";
import { openVaultImageArtifactDatabase } from "./indexeddb-vault-image-artifact-executor";

beforeEach(() =>
	Object.defineProperty(globalThis, "indexedDB", {
		configurable: true,
		value: new IDBFactory(),
	}),
);
type Layout = [string, string | string[], [string, string | string[]][]];
const replica: Layout[] = [
	["heads", "accountId", []],
	...[
		"optimistic_items",
		"operations",
		"attachment_move_preparations",
		"share_capabilities",
		"operation_receipts",
		"replica_metadata",
		"bootstrap_generations",
		"bootstrap_pages",
		"authority_vaults",
		"authority_items",
	].map(
		(name) =>
			[
				name,
				["accountId", "recordId"],
				[["by_account", "accountId"]],
			] as Layout,
	),
];
const replicaEight: Layout[] = [
	...replica,
	[
		"recovery_input",
		["accountId", "recoveryId", "kind", "store", "recordId", "chunkIndex"],
		[["by_account", "accountId"]],
	],
];
const replicaNine: Layout[] = [
	...replicaEight,
	[
		"cross_account_moves",
		["accountId", "recordId"],
		[["by_account", "accountId"]],
	],
];
const attachment: Layout[] = [
	["artifacts", ["accountId", "artifactId"], [["by_account", "accountId"]]],
	[
		"chunks",
		["accountId", "artifactId", "chunkIndex"],
		[
			["by_account", "accountId"],
			["by_artifact", ["accountId", "artifactId"]],
		],
	],
	[
		"provisional_artifacts",
		["accountId", "operationId", "attachmentId", "generation"],
		[
			["by_account", "accountId"],
			["by_scope", ["accountId", "operationId", "attachmentId"]],
		],
	],
	[
		"provisional_chunks",
		["accountId", "operationId", "attachmentId", "generation", "chunkIndex"],
		[
			["by_account", "accountId"],
			[
				"by_generation",
				["accountId", "operationId", "attachmentId", "generation"],
			],
		],
	],
];
const image: Layout[] = [
	["artifacts", ["accountId", "operationId"], [["by_account", "accountId"]]],
	[
		"chunks",
		["accountId", "operationId", "chunkIndex"],
		[
			["by_account", "accountId"],
			["by_scope", ["accountId", "operationId"]],
		],
	],
];
function done(tx: IDBTransaction) {
	return new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onabort = () => reject(tx.error);
	});
}
function result<T>(request: IDBRequest<T>) {
	return new Promise<T>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}
async function contents(db: IDBDatabase, stores = [...db.objectStoreNames]) {
	const tx = db.transaction(stores, "readonly");
	const finished = done(tx);
	const rows = await Promise.all(
		stores.map((name) => result(tx.objectStore(name).getAll())),
	);
	await finished;
	return rows;
}
async function storeIndexes(db: IDBDatabase) {
	const stores = [...db.objectStoreNames].sort();
	const tx = db.transaction(stores, "readonly");
	const finished = done(tx);
	const indexes = stores.map(
		(name) => [name, [...tx.objectStore(name).indexNames].sort()] as const,
	);
	await finished;
	return indexes;
}
for (const [name, oldVersion, currentVersion, layout, open] of [
	["replica", 7, 10, replica, openReplicaDatabase],
	["replica-v8", 8, 10, replicaEight, openReplicaDatabase],
	["replica-v9", 9, 10, replicaNine, openReplicaDatabase],
	["attachment", 2, 3, attachment, openAttachmentArtifactDatabase],
	["image", 1, 3, image, openVaultImageArtifactDatabase],
] as const) {
	test(`${name} version barrier preserves every prior store and rejects older reopen`, async () => {
		const request = indexedDB.open(name, oldVersion);
		request.onupgradeneeded = () => {
			for (const [storeName, keyPath, indexes] of layout) {
				const store = request.result.createObjectStore(storeName, { keyPath });
				for (const [index, key] of indexes) store.createIndex(index, key);
			}
		};
		const prior = await result(request);
		const tx = prior.transaction([...prior.objectStoreNames], "readwrite");
		for (const storeName of prior.objectStoreNames)
			for (const accountId of ["account-a", "account-b"])
				tx.objectStore(storeName).put({
					accountId,
					recordId: "opaque-record",
					recoveryId: "opaque-recovery",
					kind: "row",
					store: "operations",
					artifactId: "opaque-artifact",
					operationId: "operation",
					attachmentId: "attachment",
					generation: "generation",
					chunkIndex: 0,
					payloadJson: '{ "retained": [2,1] }',
					bytes: new Uint8Array([0, 255, 3]),
				});
		await done(tx);
		const before = await contents(prior);
		prior.close();
		if (name === "replica-v8" || name === "replica-v9") {
			for (const boundary of [1, 2]) {
				await expect(openReplicaDatabase(name, boundary)).rejects.toMatchObject(
					{
						code: "STORAGE_UNAVAILABLE",
						reason: "upgrade_failed",
					},
				);
				const retained = await result(indexedDB.open(name, oldVersion));
				expect([...retained.objectStoreNames]).not.toContain(
					name === "replica-v8" ? "cross_account_moves" : "rotation_attempts",
				);
				expect(await contents(retained)).toEqual(before);
				retained.close();
			}
		}
		const upgraded = await open(name);
		expect(upgraded.version).toBe(currentVersion);
		expect(
			await contents(upgraded, layout.map(([store]) => store).sort()),
		).toEqual(
			name === "image"
				? before.map((rows) =>
						rows.map((row) => ({ ...row, publicationId: "" })),
					)
				: before,
		);
		if (name === "replica")
			expect(await contents(upgraded, ["recovery_input"])).toEqual([[]]);
		if (name === "replica" || name === "replica-v8")
			expect(await contents(upgraded, ["cross_account_moves"])).toEqual([[]]);
		if (name.startsWith("replica"))
			expect(await contents(upgraded, ["rotation_attempts"])).toEqual([[]]);
		upgraded.close();
		await expect(
			result(indexedDB.open(name, oldVersion)),
		).rejects.toMatchObject({ name: "VersionError" });
	});
}

test("replica v9 refuses extra indexes without changing its prior schema or data", async () => {
	for (const malformed of [
		{
			name: "replica-v9-extra-record-index",
			store: "operations",
			index: "unexpected",
		},
		{
			name: "replica-v9-extra-head-index",
			store: "heads",
			index: "by_account",
		},
	] as const) {
		const request = indexedDB.open(malformed.name, 9);
		request.onupgradeneeded = () => {
			for (const [storeName, keyPath, indexes] of replicaNine) {
				const store = request.result.createObjectStore(storeName, { keyPath });
				for (const [index, key] of indexes) store.createIndex(index, key);
				if (storeName === malformed.store)
					store.createIndex(
						malformed.index,
						storeName === "heads" ? "accountId" : "recordId",
					);
			}
		};
		const prior = await result(request);
		const storeNames = [...prior.objectStoreNames].sort();
		const seed = prior.transaction(storeNames, "readwrite");
		for (const storeName of storeNames) {
			for (const accountId of ["account-a", "account-b"]) {
				const row =
					storeName === "heads"
						? {
								accountId,
								userId: `${accountId}-user`,
								incarnation: `${accountId}-incarnation`,
								replicaRevision: 17,
								lockEpoch: 4,
								marker: "prior-head",
							}
						: storeName === "recovery_input"
							? {
									accountId,
									recoveryId: "prior-recovery",
									kind: "row",
									store: "operations",
									recordId: "prior-record",
									chunkIndex: 0,
									payloadJson: '{"marker":"prior-recovery-input"}',
								}
							: {
									accountId,
									recordId:
										storeName === "replica_metadata"
											? "bootstrap"
											: "prior-record",
									payloadJson: JSON.stringify({
										store: storeName,
										marker:
											storeName === "replica_metadata"
												? "prior-metadata"
												: "prior-row",
									}),
									marker:
										storeName === "replica_metadata"
											? "prior-metadata"
											: "prior-row",
								};
				seed.objectStore(storeName).put(row);
			}
		}
		await done(seed);
		const priorRows = await contents(prior, storeNames);
		const priorIndexes = await storeIndexes(prior);
		prior.close();

		await expect(openReplicaDatabase(malformed.name)).rejects.toMatchObject({
			code: "STORAGE_UNAVAILABLE",
			reason: "unavailable",
		});
		const retained = await result(indexedDB.open(malformed.name, 9));
		expect(retained.version).toBe(9);
		expect([...retained.objectStoreNames].sort()).toEqual(
			replicaNine.map(([store]) => store).sort(),
		);
		expect([...retained.objectStoreNames]).not.toContain("rotation_attempts");
		expect(await storeIndexes(retained)).toEqual(priorIndexes);
		expect(await contents(retained, storeNames)).toEqual(priorRows);
		retained.close();
	}
});
