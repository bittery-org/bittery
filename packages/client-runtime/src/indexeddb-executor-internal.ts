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
import {
	openIndexedDatabase,
	IndexedDbStorageError as StorageUnavailableError,
} from "./indexeddb-lifecycle";

const DATABASE_NAME = "bittery_replica";
/** Physical versions are independent of the Rust logical Replica/serialized contract. */
const DATABASE_VERSION = 10;
// v5 (c463ab3a) and v6 (2059ed62) are the supported legacy physical layouts.
// Earlier logical formats require a separate migration, never missing-field defaults.
const VERSION_FIVE_STORES = [
	"heads",
	"optimistic_items",
	"operations",
	"operation_receipts",
	"replica_metadata",
	"bootstrap_generations",
	"bootstrap_pages",
	"authority_vaults",
	"authority_items",
] as const;
const VERSION_SEVEN_STORES = [
	...VERSION_FIVE_STORES,
	"attachment_move_preparations",
	"share_capabilities",
];
const VERSION_EIGHT_STORES = [...VERSION_SEVEN_STORES, "recovery_input"];
const VERSION_NINE_STORES = [...VERSION_EIGHT_STORES, "cross_account_moves"];
const ACCOUNT_INDEX = "by_account";
const MAX_U64 = 18_446_744_073_709_551_615n;
export const REPLICA_STORE_MAP = {
	optimisticItems: "optimistic_items",
	operations: "operations",
	crossAccountMoves: "cross_account_moves",
	attachmentMovePreparations: "attachment_move_preparations",
	shareCapabilities: "share_capabilities",
	operationReceipts: "operation_receipts",
	rotationAttempts: "rotation_attempts",
	replicaMetadata: "replica_metadata",
	bootstrapGenerations: "bootstrap_generations",
	bootstrapPages: "bootstrap_pages",
	authorityVaults: "authority_vaults",
	authorityItems: "authority_items",
} as const satisfies Record<ReplicaStore, string>;
const STORE_NAMES = ["heads", ...Object.values(REPLICA_STORE_MAP)] as const;
export const RECOVERY_INPUT_STORE = "recovery_input";
const PHYSICAL_STORES = [...STORE_NAMES, RECOVERY_INPUT_STORE];

type DatabaseStore = (typeof STORE_NAMES)[number];

export type IndexedDbReplicaExecutorTestOptions = {
	databaseName?: string;
	failAfterWrite?: number;
	failAfterMigrationWrite?: number;
};

export class ConfigurableIndexedDbReplicaExecutor {
	readonly #databaseName: string;
	readonly #failAfterWrite: number | undefined;
	readonly #failAfterMigrationWrite: number | undefined;

	constructor(options: IndexedDbReplicaExecutorTestOptions = {}) {
		this.#databaseName = options.databaseName ?? DATABASE_NAME;
		this.#failAfterWrite = options.failAfterWrite;
		this.#failAfterMigrationWrite = options.failAfterMigrationWrite;
	}

	async invoke(requestJson: string): Promise<string> {
		const request = parseRequest(requestJson);
		const database = await openReplicaDatabase(
			this.#databaseName,
			this.#failAfterMigrationWrite,
		);
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
								: request.type === "deleteAccountIfUnchanged"
									? await deleteAccountIfUnchanged(
											database,
											request.accountId,
											request.expectedHead,
											request.expectedRows,
											failure,
										)
									: request.type === "deleteAccount"
										? await deleteAccount(database, request.accountId, failure)
										: request.type === "wipeDevice"
											? await wipeDevice(database, failure)
											: unsupportedRequest();
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

function unsupportedRequest(): never {
	throw new Error("Replica persistence request is not implemented");
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

export async function openReplicaDatabase(
	databaseName = DATABASE_NAME,
	failAfterMigrationWrite?: number,
): Promise<IDBDatabase> {
	return openIndexedDatabase({
		name: databaseName,
		version: DATABASE_VERSION,
		upgrade(database, transaction, oldVersion) {
			if (oldVersion !== 0)
				assertLegacySchema(database, transaction, oldVersion);
			createSchema(
				database,
				new WriteFailureInjection(failAfterMigrationWrite),
			);
		},
		validate: assertSchema,
	});
}

function assertLegacySchema(
	database: IDBDatabase,
	transaction: IDBTransaction | null,
	version: number,
): void {
	if (
		(version !== 5 &&
			version !== 6 &&
			version !== 7 &&
			version !== 8 &&
			version !== 9) ||
		transaction === null
	) {
		throw new StorageUnavailableError("unsupported_version");
	}
	const expected =
		version === 5
			? [...VERSION_FIVE_STORES]
			: version === 6
				? [...VERSION_FIVE_STORES, "attachment_move_preparations"]
				: version === 7
					? [...VERSION_SEVEN_STORES]
					: version === 8
						? [...VERSION_EIGHT_STORES]
						: [...VERSION_NINE_STORES];
	if (
		JSON.stringify([...database.objectStoreNames].sort()) !==
		JSON.stringify(expected.sort())
	) {
		throw new StorageUnavailableError("unsupported_version");
	}
	assertStoreLayouts(
		transaction,
		expected.filter((store) => store !== RECOVERY_INPUT_STORE),
	);
	if (version >= 8) assertRecoveryInputLayout(transaction);
}

function createSchema(
	database: IDBDatabase,
	failure: WriteFailureInjection,
): void {
	if (!database.objectStoreNames.contains("heads")) {
		database.createObjectStore("heads", { keyPath: "accountId" });
		failure.afterWrite();
	}
	for (const storeName of STORE_NAMES.filter((name) => name !== "heads")) {
		if (database.objectStoreNames.contains(storeName)) {
			continue;
		}
		const store = database.createObjectStore(storeName, {
			keyPath: ["accountId", "recordId"],
		});
		failure.afterWrite();
		store.createIndex(ACCOUNT_INDEX, "accountId");
		failure.afterWrite();
	}
	if (!database.objectStoreNames.contains(RECOVERY_INPUT_STORE)) {
		const store = database.createObjectStore(RECOVERY_INPUT_STORE, {
			keyPath: [
				"accountId",
				"recoveryId",
				"kind",
				"store",
				"recordId",
				"chunkIndex",
			],
		});
		failure.afterWrite();
		store.createIndex(ACCOUNT_INDEX, "accountId");
		failure.afterWrite();
	}
}

function assertSchema(database: IDBDatabase, upgrade?: IDBTransaction): void {
	if (
		JSON.stringify([...database.objectStoreNames].sort()) !==
		JSON.stringify([...PHYSICAL_STORES].sort())
	)
		throw new StorageUnavailableError("unsupported_version");
	for (const storeName of STORE_NAMES) {
		if (!database.objectStoreNames.contains(storeName)) {
			database.close();
			throw new Error(`IndexedDB schema is missing ${storeName}`);
		}
	}
	const transaction =
		upgrade ?? database.transaction(PHYSICAL_STORES, "readonly");
	assertStoreLayouts(transaction, STORE_NAMES);
	assertRecoveryInputLayout(transaction);
}

function assertRecoveryInputLayout(transaction: IDBTransaction): void {
	const input = transaction.objectStore(RECOVERY_INPUT_STORE);
	if (
		JSON.stringify(input.keyPath) !==
			JSON.stringify([
				"accountId",
				"recoveryId",
				"kind",
				"store",
				"recordId",
				"chunkIndex",
			]) ||
		input.autoIncrement ||
		JSON.stringify([...input.indexNames]) !== JSON.stringify([ACCOUNT_INDEX]) ||
		input.index(ACCOUNT_INDEX).keyPath !== "accountId" ||
		input.index(ACCOUNT_INDEX).unique ||
		input.index(ACCOUNT_INDEX).multiEntry
	)
		throw new StorageUnavailableError("unsupported_version");
}

function assertStoreLayouts(
	transaction: IDBTransaction,
	stores: readonly string[],
): void {
	for (const storeName of stores) {
		const store = transaction.objectStore(storeName);
		const expectedKeyPath =
			storeName === "heads" ? "accountId" : ["accountId", "recordId"];
		if (
			JSON.stringify(store.keyPath) !== JSON.stringify(expectedKeyPath) ||
			store.autoIncrement
		) {
			throw new StorageUnavailableError("unavailable");
		}
		if (storeName !== "heads") {
			const index = store.index(ACCOUNT_INDEX);
			if (
				JSON.stringify([...store.indexNames].sort()) !==
				JSON.stringify([ACCOUNT_INDEX])
			)
				throw new StorageUnavailableError("unavailable");
			if (index.keyPath !== "accountId" || index.unique || index.multiEntry) {
				throw new StorageUnavailableError("unavailable");
			}
		} else if (store.indexNames.length !== 0) {
			throw new StorageUnavailableError("unavailable");
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
		const stores = Object.keys(REPLICA_STORE_MAP) as ReplicaStore[];
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
	const transaction = database.transaction(PHYSICAL_STORES, "readwrite");
	const completed = transactionDone(transaction);
	try {
		for (const storeName of PHYSICAL_STORES.filter(
			(name) => name !== "heads",
		)) {
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

async function deleteAccountIfUnchanged(
	database: IDBDatabase,
	accountId: string,
	expectedHead: ReplicaHead,
	expectedRows: StoredReplicaRow[],
	failure: WriteFailureInjection,
): Promise<ReplicaPersistenceResponse> {
	assertIdentifier(accountId, "guarded delete Account");
	assertGuardedDeletionScope(accountId, expectedHead, expectedRows);
	const transaction = database.transaction(PHYSICAL_STORES, "readwrite");
	const completed = transactionDone(transaction);
	const rowStoreNames = PHYSICAL_STORES.filter((name) => name !== "heads");
	try {
		const [headValue, ...scans] = await Promise.all([
			requestResult(transaction.objectStore("heads").get(accountId)),
			...rowStoreNames.map((storeName) =>
				requestResult(
					transaction
						.objectStore(storeName)
						.index(ACCOUNT_INDEX)
						.getAll(accountId),
				),
			),
			...rowStoreNames.map((storeName) =>
				requestResult(
					transaction
						.objectStore(storeName)
						.index(ACCOUNT_INDEX)
						.getAllKeys(accountId),
				),
			),
		]);
		const rowValues = scans.slice(0, rowStoreNames.length) as unknown[][];
		const rowKeys = scans.slice(rowStoreNames.length) as IDBValidKey[][];
		if (
			headValue === undefined &&
			rowValues.every((values) => values.length === 0)
		) {
			await completed;
			return {
				type: "accountDeletion",
				result: { type: "alreadyAbsent" },
			};
		}

		let actualHead: ReplicaHead | undefined;
		let actualRows: StoredReplicaRow[] = [];
		let malformed = false;
		try {
			actualHead =
				headValue === undefined
					? undefined
					: parseStoredHead(headValue, accountId);
			const stores = Object.keys(REPLICA_STORE_MAP) as ReplicaStore[];
			actualRows = stores.flatMap((store, index) => {
				const values = rowValues[index];
				if (values === undefined) {
					throw new Error("guarded Replica deletion scan is incomplete");
				}
				return values.map((value) => parseStoredRow(value, store, accountId));
			});
		} catch {
			// Malformed owned state is a conflict. Guarded deletion must preserve it.
			malformed = true;
		}
		const recoveryValues = rowValues[rowStoreNames.length - 1];
		if (
			malformed ||
			actualHead === undefined ||
			recoveryValues === undefined ||
			recoveryValues.length !== 0 ||
			!replicaHeadEquals(expectedHead, actualHead) ||
			!replicaRowsEqual(expectedRows, actualRows)
		) {
			await completed;
			return { type: "accountDeletion", result: { type: "conflict" } };
		}

		for (const [index, storeName] of rowStoreNames.entries()) {
			const store = transaction.objectStore(storeName);
			const keys = rowKeys[index];
			if (keys === undefined) {
				throw new Error("guarded Replica deletion key scan is incomplete");
			}
			for (const key of keys) store.delete(key);
			failure.afterWrite();
		}
		transaction.objectStore("heads").delete(accountId);
		failure.afterWrite();
		await completed;
		return { type: "accountDeletion", result: { type: "deleted" } };
	} catch (error) {
		abort(transaction);
		await completed.catch(() => undefined);
		throw error;
	}
}

function assertGuardedDeletionScope(
	accountId: string,
	expectedHead: ReplicaHead,
	expectedRows: StoredReplicaRow[],
): void {
	if (expectedHead.accountId !== accountId) {
		throw new Error("guarded Replica deletion identity disagrees");
	}
	const keys = new Set<string>();
	for (const row of expectedRows) {
		const identity = JSON.stringify([row.store, row.key.recordId]);
		if (row.key.accountId !== accountId || keys.has(identity)) {
			throw new Error(
				"guarded Replica deletion rows have invalid scope or duplicate keys",
			);
		}
		keys.add(identity);
	}
}

function replicaHeadEquals(left: ReplicaHead, right: ReplicaHead): boolean {
	return (
		left.accountId === right.accountId &&
		left.userId === right.userId &&
		left.incarnation === right.incarnation &&
		left.replicaRevision === right.replicaRevision &&
		left.lockEpoch === right.lockEpoch &&
		left.failure === right.failure
	);
}

function replicaRowsEqual(
	left: StoredReplicaRow[],
	right: StoredReplicaRow[],
): boolean {
	const compare = (left: string, right: string) =>
		left < right ? -1 : left > right ? 1 : 0;
	const canonical = (rows: StoredReplicaRow[]) =>
		[...rows].sort(
			(a, b) =>
				compare(a.store, b.store) ||
				compare(a.key.accountId, b.key.accountId) ||
				compare(a.key.recordId, b.key.recordId),
		);
	const expected = canonical(left);
	const actual = canonical(right);
	return (
		expected.length === actual.length &&
		expected.every((row, index) => {
			const candidate = actual[index];
			return (
				candidate !== undefined &&
				row.store === candidate.store &&
				row.key.accountId === candidate.key.accountId &&
				row.key.recordId === candidate.key.recordId &&
				row.payloadJson === candidate.payloadJson
			);
		})
	);
}

async function wipeDevice(
	database: IDBDatabase,
	failure: WriteFailureInjection,
): Promise<ReplicaPersistenceResponse> {
	const transaction = database.transaction(PHYSICAL_STORES, "readwrite");
	const completed = transactionDone(transaction);
	try {
		for (const storeName of PHYSICAL_STORES) {
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
	return REPLICA_STORE_MAP[store];
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
