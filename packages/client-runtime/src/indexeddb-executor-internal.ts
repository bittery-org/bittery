import type {
	PreparedLockEpochAdvance,
	PreparedReplicaCommit,
	PreparedReplicaInstall,
	ReplicaHead,
	ReplicaPersistenceRequest,
	ReplicaPersistenceResponse,
	ReplicaStore,
	StoredReplicaRow,
} from "../generated/persistence/contract.ts";
import {
	validateReplicaPersistenceRequest,
	validateReplicaPersistenceResponse,
} from "../generated/persistence/validator.js";

const DATABASE_NAME = "bittery_replica";
/** Schema versions are additive: an upgrade may add stores, but never rebuild durable work. */
const DATABASE_VERSION = 7;
const ACCOUNT_INDEX = "by_account";
const MAX_U64 = 18_446_744_073_709_551_615n;
const STORE_NAMES = [
	"heads",
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
] as const;

type DatabaseStore = (typeof STORE_NAMES)[number];

export type IndexedDbReplicaExecutorTestOptions = {
	databaseName?: string;
	failAfterWrite?: number;
};

export class ConfigurableIndexedDbReplicaExecutor {
	readonly #databaseName: string;
	readonly #failAfterWrite: number | undefined;

	constructor(options: IndexedDbReplicaExecutorTestOptions = {}) {
		this.#databaseName = options.databaseName ?? DATABASE_NAME;
		this.#failAfterWrite = options.failAfterWrite;
	}

	async invoke(requestJson: string): Promise<string> {
		const request = parseRequest(requestJson);
		const database = await openDatabase(this.#databaseName);
		const failure = new WriteFailureInjection(this.#failAfterWrite);
		try {
			const response =
				request.type === "load"
					? await load(database, request.accountId)
					: request.type === "install"
						? await install(database, request.prepared, failure)
						: request.type === "commit"
							? await commit(database, request.prepared, failure)
							: request.type === "advanceLockEpoch"
								? await advanceLockEpoch(database, request.prepared, failure)
								: request.type === "deleteAccount"
									? await deleteAccount(database, request.accountId, failure)
									: await wipeDevice(database, failure);
			if (!validateReplicaPersistenceResponse(response)) {
				throw new Error(
					"persistence response does not match the generated contract",
				);
			}
			return JSON.stringify(response);
		} finally {
			database.close();
		}
	}
}

function parseRequest(requestJson: string): ReplicaPersistenceRequest {
	let value: unknown;
	try {
		value = JSON.parse(requestJson);
	} catch {
		throw new Error("persistence request must be valid JSON");
	}
	if (!validateReplicaPersistenceRequest(value)) {
		throw new Error(
			"persistence request does not match the generated contract",
		);
	}
	return value;
}

async function openDatabase(databaseName: string): Promise<IDBDatabase> {
	if (typeof globalThis.indexedDB === "undefined") {
		throw new Error("IndexedDB is unavailable");
	}
	const request = globalThis.indexedDB.open(databaseName, DATABASE_VERSION);
	request.onupgradeneeded = () => {
		const database = request.result;
		createSchema(database);
	};
	const database = await requestResult(request);
	assertSchema(database);
	return database;
}

function createSchema(database: IDBDatabase): void {
	if (!database.objectStoreNames.contains("heads")) {
		database.createObjectStore("heads", { keyPath: "accountId" });
	}
	for (const storeName of STORE_NAMES.filter((name) => name !== "heads")) {
		if (database.objectStoreNames.contains(storeName)) {
			continue;
		}
		const store = database.createObjectStore(storeName, {
			keyPath: ["accountId", "recordId"],
		});
		store.createIndex(ACCOUNT_INDEX, "accountId");
	}
}

function assertSchema(database: IDBDatabase): void {
	for (const storeName of STORE_NAMES) {
		if (!database.objectStoreNames.contains(storeName)) {
			database.close();
			throw new Error(`IndexedDB schema is missing ${storeName}`);
		}
	}
}

async function load(
	database: IDBDatabase,
	accountId: string,
): Promise<ReplicaPersistenceResponse> {
	assertIdentifier(accountId, "load Account");
	const transaction = database.transaction(STORE_NAMES, "readonly");
	const completed = transactionDone(transaction);
	try {
		const [headValue, ...storeValues] = await Promise.all([
			requestResult(transaction.objectStore("heads").get(accountId)),
			...STORE_NAMES.filter((name) => name !== "heads").map((storeName) =>
				requestResult(
					transaction
						.objectStore(storeName)
						.index(ACCOUNT_INDEX)
						.getAll(accountId),
				),
			),
		]);
		await completed;
		const head =
			headValue === undefined ? null : parseStoredHead(headValue, accountId);
		const stores: ReplicaStore[] = [
			"optimisticItems",
			"operations",
			"attachmentMovePreparations",
			"shareCapabilities",
			"operationReceipts",
			"replicaMetadata",
			"bootstrapGenerations",
			"bootstrapPages",
			"authorityVaults",
			"authorityItems",
		];
		const rows = stores.flatMap((store, index) =>
			(storeValues[index] as unknown[]).map((value) =>
				parseStoredRow(value, store, accountId),
			),
		);
		return { type: "loaded", head, rows };
	} catch (error) {
		abort(transaction);
		await completed.catch(() => undefined);
		throw error;
	}
}

async function install(
	database: IDBDatabase,
	prepared: PreparedReplicaInstall,
	failure: WriteFailureInjection,
): Promise<ReplicaPersistenceResponse> {
	const transaction = database.transaction(STORE_NAMES, "readwrite");
	const completed = transactionDone(transaction);
	try {
		const heads = transaction.objectStore("heads");
		const accountId = prepared.nextHead.accountId;
		const previousValue = await requestResult(heads.get(accountId));
		const previous =
			previousValue === undefined
				? null
				: parseStoredHead(previousValue, accountId);
		const matches =
			prepared.expected.type === "missing"
				? prepared.expected.accountId === accountId && previous === null
				: prepared.expected.accountId === accountId &&
					previous !== null &&
					previous.userId === prepared.expected.userId &&
					previous.incarnation === prepared.expected.incarnation &&
					previous.replicaRevision === prepared.expected.replicaRevision &&
					previous.lockEpoch === prepared.expected.lockEpoch;
		if (!matches) {
			await completed;
			return { type: "installed", result: { type: "stale" } };
		}
		// Unreachable writes do not override the authoritative guard outcome.
		assertInstallSafety(prepared);
		for (const write of prepared.writes ?? []) {
			if (write.type === "put") {
				transaction.objectStore(mapStore(write.row.store)).put({
					accountId: write.row.key.accountId,
					recordId: write.row.key.recordId,
					payloadJson: write.row.payloadJson,
				});
			} else {
				transaction
					.objectStore(mapStore(write.store))
					.delete([write.key.accountId, write.key.recordId]);
			}
			failure.afterWrite();
		}
		heads.put(prepared.nextHead);
		failure.afterWrite();
		await completed;
		return { type: "installed", result: { type: "applied" } };
	} catch (error) {
		abort(transaction);
		await completed.catch(() => undefined);
		throw error;
	}
}

async function commit(
	database: IDBDatabase,
	prepared: PreparedReplicaCommit,
	failure: WriteFailureInjection,
): Promise<ReplicaPersistenceResponse> {
	const transaction = database.transaction(STORE_NAMES, "readwrite");
	const completed = transactionDone(transaction);
	try {
		const heads = transaction.objectStore("heads");
		const headValue = await requestResult(
			heads.get(prepared.expected.accountId),
		);
		if (headValue === undefined) {
			await completed;
			return { type: "committed", result: { type: "missing" } };
		}
		const head = parseStoredHead(headValue, prepared.expected.accountId);
		if (
			head.userId !== prepared.expected.userId ||
			head.incarnation !== prepared.expected.incarnation ||
			head.replicaRevision !== prepared.expected.replicaRevision ||
			head.lockEpoch !== prepared.expected.lockEpoch
		) {
			await completed;
			return {
				type: "committed",
				result: { type: "stale", actualRevision: head.replicaRevision },
			};
		}
		// Unreachable writes do not override the authoritative guard outcome.
		assertPreparedSafety(prepared);
		assertWriteScope(prepared.writes, prepared.expected.accountId);
		for (const write of prepared.writes) {
			if (write.type === "put") {
				transaction.objectStore(mapStore(write.row.store)).put({
					accountId: write.row.key.accountId,
					recordId: write.row.key.recordId,
					payloadJson: write.row.payloadJson,
				});
			} else {
				transaction
					.objectStore(mapStore(write.store))
					.delete([write.key.accountId, write.key.recordId]);
			}
			failure.afterWrite();
		}
		heads.put(prepared.nextHead);
		failure.afterWrite();
		await completed;
		return {
			type: "committed",
			result: {
				type: "applied",
				replicaRevision: prepared.nextHead.replicaRevision,
			},
		};
	} catch (error) {
		abort(transaction);
		await completed.catch(() => undefined);
		throw error;
	}
}

async function advanceLockEpoch(
	database: IDBDatabase,
	prepared: PreparedLockEpochAdvance,
	failure: WriteFailureInjection,
): Promise<ReplicaPersistenceResponse> {
	const transaction = database.transaction("heads", "readwrite");
	const completed = transactionDone(transaction);
	try {
		const heads = transaction.objectStore("heads");
		const value = await requestResult(heads.get(prepared.expected.accountId));
		if (value === undefined) {
			await completed;
			return { type: "lockEpochAdvanced", result: { type: "missing" } };
		}
		const head = parseStoredHead(value, prepared.expected.accountId);
		if (
			head.userId !== prepared.expected.userId ||
			head.incarnation !== prepared.expected.incarnation ||
			head.replicaRevision !== prepared.expected.replicaRevision ||
			head.lockEpoch !== prepared.expected.lockEpoch
		) {
			await completed;
			return { type: "lockEpochAdvanced", result: { type: "stale" } };
		}
		assertLockEpochAdvanceSafety(prepared);
		if (prepared.nextHead.failure !== head.failure) {
			throw new Error("prepared Account lock epoch cannot change failure");
		}
		heads.put(prepared.nextHead);
		failure.afterWrite();
		await completed;
		return {
			type: "lockEpochAdvanced",
			result: { type: "applied", lockEpoch: prepared.nextHead.lockEpoch },
		};
	} catch (error) {
		abort(transaction);
		await completed.catch(() => undefined);
		throw error;
	}
}

async function deleteAccount(
	database: IDBDatabase,
	accountId: string,
	failure: WriteFailureInjection,
): Promise<ReplicaPersistenceResponse> {
	assertIdentifier(accountId, "delete Account");
	const transaction = database.transaction(STORE_NAMES, "readwrite");
	const completed = transactionDone(transaction);
	try {
		for (const storeName of STORE_NAMES.filter((name) => name !== "heads")) {
			const store = transaction.objectStore(storeName);
			const keys = await requestResult(
				store.index(ACCOUNT_INDEX).getAllKeys(accountId),
			);
			for (const key of keys) store.delete(key);
			failure.afterWrite();
		}
		transaction.objectStore("heads").delete(accountId);
		failure.afterWrite();
		await completed;
		return { type: "accountDeleted" };
	} catch (error) {
		abort(transaction);
		await completed.catch(() => undefined);
		throw error;
	}
}

async function wipeDevice(
	database: IDBDatabase,
	failure: WriteFailureInjection,
): Promise<ReplicaPersistenceResponse> {
	const transaction = database.transaction(STORE_NAMES, "readwrite");
	const completed = transactionDone(transaction);
	try {
		for (const storeName of STORE_NAMES) {
			transaction.objectStore(storeName).clear();
			failure.afterWrite();
		}
		await completed;
		return { type: "deviceWiped" };
	} catch (error) {
		abort(transaction);
		await completed.catch(() => undefined);
		throw error;
	}
}

function assertInstallSafety(prepared: PreparedReplicaInstall): void {
	const { expected, nextHead, writes } = prepared;
	assertIdentifier(nextHead.accountId, "next Account");
	assertIdentifier(nextHead.userId, "next User");
	assertIdentifier(nextHead.incarnation, "next incarnation");
	const nextRevision = parseRevision(nextHead.replicaRevision, "next revision");
	const nextLockEpoch = parseRevision(nextHead.lockEpoch, "next lock epoch");
	const transitionIsValid =
		expected.type === "missing"
			? nextRevision === 0n && nextLockEpoch === 0n && nextHead.failure === null
			: nextHead.userId === expected.userId &&
				parseRevision(expected.replicaRevision, "expected revision") <
					MAX_U64 &&
				nextRevision ===
					parseRevision(expected.replicaRevision, "expected revision") + 1n &&
				nextLockEpoch === 0n &&
				nextHead.failure === null;
	if (!transitionIsValid) {
		throw new Error("prepared Replica install transition is invalid");
	}
	assertWriteIdentifiers(writes);
	assertWriteScope(writes, nextHead.accountId);
}

function assertLockEpochAdvanceSafety(
	prepared: PreparedLockEpochAdvance,
): void {
	const { expected, nextHead } = prepared;
	assertIdentifier(expected.accountId, "expected Account");
	assertIdentifier(expected.userId, "expected User");
	assertIdentifier(expected.incarnation, "expected incarnation");
	parseRevision(expected.replicaRevision, "expected revision");
	const expectedEpoch = parseRevision(
		expected.lockEpoch,
		"expected lock epoch",
	);
	if (
		nextHead.accountId !== expected.accountId ||
		nextHead.userId !== expected.userId ||
		nextHead.incarnation !== expected.incarnation ||
		nextHead.replicaRevision !== expected.replicaRevision ||
		expectedEpoch === MAX_U64 ||
		nextHead.lockEpoch !== (expectedEpoch + 1n).toString()
	) {
		throw new Error("prepared Account lock epoch transition is invalid");
	}
}

function assertPreparedSafety(prepared: PreparedReplicaCommit): void {
	const { expected, nextHead } = prepared;
	assertIdentifier(expected.accountId, "expected Account");
	assertIdentifier(expected.incarnation, "expected incarnation");
	const expectedRevision = parseRevision(
		expected.replicaRevision,
		"expected revision",
	);
	if (nextHead.userId !== expected.userId) {
		throw new Error("prepared Replica commit cannot change User identity");
	}
	if (
		nextHead.accountId !== expected.accountId ||
		nextHead.incarnation !== expected.incarnation ||
		nextHead.lockEpoch !== expected.lockEpoch
	) {
		throw new Error(
			"next head does not preserve the expected Account and incarnation",
		);
	}
	if (expectedRevision === MAX_U64)
		throw new Error("Replica revision overflow");
	if (
		nextHead.replicaRevision !== expectedRevision.toString() &&
		nextHead.replicaRevision !== (expectedRevision + 1n).toString()
	) {
		throw new Error("next head revision must stay or be the exact successor");
	}
	assertWriteIdentifiers(prepared.writes);
}

function assertWriteIdentifiers(
	writes: PreparedReplicaInstall["writes"],
): void {
	for (const write of writes) {
		const key = write.type === "put" ? write.row.key : write.key;
		assertIdentifier(key.recordId, "prepared row key");
	}
}

function assertWriteScope(
	writes: PreparedReplicaInstall["writes"],
	accountId: string,
): void {
	for (const write of writes) {
		const key = write.type === "put" ? write.row.key : write.key;
		if (key.accountId !== accountId) {
			throw new Error(
				"prepared row Account scope does not match the expected head",
			);
		}
	}
}

class WriteFailureInjection {
	#writeCount = 0;

	constructor(private readonly failAfterWrite: number | undefined) {}

	afterWrite(): void {
		this.#writeCount += 1;
		if (this.#writeCount === this.failAfterWrite) {
			throw new Error(
				`injected IndexedDB failure after write ${this.#writeCount}`,
			);
		}
	}
}

function parseStoredHead(value: unknown, accountId: string): ReplicaHead {
	const candidate: ReplicaPersistenceResponse = {
		type: "loaded",
		head: value as ReplicaHead,
		rows: [],
	};
	if (
		!validateReplicaPersistenceResponse(candidate) ||
		candidate.type !== "loaded" ||
		!candidate.head
	) {
		throw new Error("stored head does not match the generated contract");
	}
	if (candidate.head.accountId !== accountId) {
		throw new Error("stored head Account scope does not match its key");
	}
	assertIdentifier(candidate.head.accountId, "stored head Account");
	assertIdentifier(candidate.head.userId, "stored head User");
	assertIdentifier(candidate.head.incarnation, "stored head incarnation");
	parseRevision(candidate.head.replicaRevision, "stored head revision");
	parseRevision(candidate.head.lockEpoch, "stored head lock epoch");
	return candidate.head;
}

function parseStoredRow(
	value: unknown,
	store: ReplicaStore,
	accountId: string,
): StoredReplicaRow {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("stored Replica row must be an object");
	}
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).length !== 3 ||
		typeof record.accountId !== "string" ||
		typeof record.recordId !== "string" ||
		typeof record.payloadJson !== "string"
	) {
		throw new Error("stored Replica row has an invalid primitive shape");
	}
	if (record.accountId !== accountId) {
		throw new Error(
			"stored Replica row Account scope does not match its index",
		);
	}
	assertIdentifier(record.recordId, "stored Replica row key");
	return {
		store,
		key: { accountId: record.accountId, recordId: record.recordId },
		payloadJson: record.payloadJson,
	};
}

function mapStore(store: ReplicaStore): DatabaseStore {
	switch (store) {
		case "optimisticItems":
			return "optimistic_items";
		case "operations":
			return "operations";
		case "attachmentMovePreparations":
			return "attachment_move_preparations";
		case "shareCapabilities":
			return "share_capabilities";
		case "operationReceipts":
			return "operation_receipts";
		case "replicaMetadata":
			return "replica_metadata";
		case "bootstrapGenerations":
			return "bootstrap_generations";
		case "bootstrapPages":
			return "bootstrap_pages";
		case "authorityVaults":
			return "authority_vaults";
		case "authorityItems":
			return "authority_items";
	}
}

function assertIdentifier(value: string, context: string): void {
	if (value.length === 0) throw new Error(`${context} must not be empty`);
}

function parseRevision(value: string, context: string): bigint {
	if (!/^(0|[1-9][0-9]*)$/.test(value)) {
		throw new Error(`${context} must be a canonical uint64 decimal string`);
	}
	const revision = BigInt(value);
	if (revision > MAX_U64) throw new Error(`${context} exceeds uint64`);
	return revision;
}

function requestResult<T = unknown>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error("IndexedDB request failed"));
	});
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
		transaction.onerror = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction failed"));
	});
}

function abort(transaction: IDBTransaction): void {
	try {
		transaction.abort();
	} catch (error) {
		if (!(error instanceof DOMException && error.name === "InvalidStateError"))
			throw error;
	}
}
