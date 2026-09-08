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
for (const [name, oldVersion, layout, open] of [
	["replica", 7, replica, openReplicaDatabase],
	["attachment", 2, attachment, openAttachmentArtifactDatabase],
	["image", 1, image, openVaultImageArtifactDatabase],
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
		const upgraded = await open(name);
		expect(upgraded.version).toBe(oldVersion + 1);
		expect(
			await contents(upgraded, layout.map(([store]) => store).sort()),
		).toEqual(before);
		if (name === "replica")
			expect(await contents(upgraded, ["recovery_input"])).toEqual([[]]);
		upgraded.close();
		await expect(
			result(indexedDB.open(name, oldVersion)),
		).rejects.toMatchObject({ name: "VersionError" });
	});
}
