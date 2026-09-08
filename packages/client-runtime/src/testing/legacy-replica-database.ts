/** Historical physical schemas, independent of the production migration implementation.
 * v5: c463ab3a, src/indexeddb-executor.ts; v6: 2059ed62, src/indexeddb-executor-internal.ts.
 * Their logical row payloads are opaque; executable checkpoints come from the Rust corpus.
 */
import type {
	ReplicaPersistenceResponse,
	ReplicaStore,
} from "../../generated/persistence/contract.ts";

export type LegacyReplicaVersion = 5 | 6;
export type LoadedCheckpoint = {
	accountId: string;
	response: Extract<ReplicaPersistenceResponse, { type: "loaded" }>;
};

const versionFiveStores = {
	optimisticItems: "optimistic_items",
	operations: "operations",
	operationReceipts: "operation_receipts",
	replicaMetadata: "replica_metadata",
	bootstrapGenerations: "bootstrap_generations",
	bootstrapPages: "bootstrap_pages",
	authorityVaults: "authority_vaults",
	authorityItems: "authority_items",
} as const;

function rowStores(
	version: LegacyReplicaVersion,
): Partial<Record<ReplicaStore, string>> {
	return version === 5
		? versionFiveStores
		: {
				...versionFiveStores,
				attachmentMovePreparations: "attachment_move_preparations",
			};
}

export function legacyCanRepresent(
	version: LegacyReplicaVersion,
	checkpoints: LoadedCheckpoint[],
): boolean {
	const stores = rowStores(version);
	return checkpoints.every(({ response }) =>
		response.rows.every((row) => stores[row.store] !== undefined),
	);
}

function result<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function done(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () => reject(transaction.error);
	});
}

export async function seedLegacyReplica(
	factory: IDBFactory,
	databaseName: string,
	version: LegacyReplicaVersion,
	checkpoints: LoadedCheckpoint[],
): Promise<void> {
	if (!legacyCanRepresent(version, checkpoints))
		throw new Error("Checkpoint needs a later physical store");
	const stores = rowStores(version);
	const request = factory.open(databaseName, version);
	request.onupgradeneeded = () => {
		request.result.createObjectStore("heads", { keyPath: "accountId" });
		for (const storeName of Object.values(stores)) {
			const store = request.result.createObjectStore(storeName, {
				keyPath: ["accountId", "recordId"],
			});
			store.createIndex("by_account", "accountId");
		}
	};
	const database = await result(request);
	try {
		const transaction = database.transaction(
			["heads", ...Object.values(stores)],
			"readwrite",
		);
		for (const { response } of checkpoints) {
			if (response.head !== null)
				transaction.objectStore("heads").put(response.head);
			for (const row of response.rows) {
				const store = stores[row.store];
				if (store === undefined)
					throw new Error("Checkpoint needs a later physical store");
				transaction.objectStore(store).put({
					accountId: row.key.accountId,
					recordId: row.key.recordId,
					payloadJson: row.payloadJson,
				});
			}
		}
		await done(transaction);
	} finally {
		database.close();
	}
}

export async function readLegacyReplica(
	factory: IDBFactory,
	databaseName: string,
	version: LegacyReplicaVersion,
	accountId: string,
): Promise<LoadedCheckpoint["response"]> {
	const database = await result(factory.open(databaseName, version));
	try {
		const stores = rowStores(version);
		const transaction = database.transaction(
			["heads", ...Object.values(stores)],
			"readonly",
		);
		const completed = done(transaction);
		const headRequest = result(transaction.objectStore("heads").get(accountId));
		const rows = await Promise.all(
			Object.entries(stores).map(async ([store, name]) => {
				const values = await result(
					transaction.objectStore(name).index("by_account").getAll(accountId),
				);
				return values.map(
					(value: {
						accountId: string;
						recordId: string;
						payloadJson: string;
					}) => ({
						store: store as ReplicaStore,
						key: { accountId: value.accountId, recordId: value.recordId },
						payloadJson: value.payloadJson,
					}),
				);
			}),
		);
		const head = await headRequest;
		await completed;
		return { type: "loaded", head: head ?? null, rows: rows.flat() };
	} finally {
		database.close();
	}
}
