const DATABASE_NAME = "bittery_replica";
const DATABASE_VERSION = 1;
const ACCOUNT_INDEX = "by_account";
const MAX_U64 = 18_446_744_073_709_551_615n;

type JsonObject = Record<string, unknown>;

type Head = {
	accountId: string;
	incarnation: string;
	revision: string;
	failure: string | null;
};

type ReplicaItem = {
	accountId: string;
	itemId: string;
	vaultId: string;
	ciphertext: number[];
	optimistic: boolean;
};

type Operation = {
	operationId: string;
	itemId: string;
	requestBytes: number[];
};

type StoredOperation = Operation & { accountId: string };

type Mutation =
	| { type: "putOptimisticItem"; item: ReplicaItem }
	| { type: "acceptOperation"; operation: Operation }
	| { type: "removeOperation"; operationId: string };

type CommitPlan = {
	accountId: string;
	expectedIncarnation: string;
	expectedReplicaRevision: string;
	mutations: Mutation[];
};

type Request =
	| { type: "load"; accountId: string }
	| { type: "commit"; plan: CommitPlan };

export class IndexedDbReplicaExecutor {
	async invoke(requestJson: string): Promise<string> {
		const request = parseRequest(requestJson);
		const database = await openDatabase();
		try {
			return JSON.stringify(
				request.type === "load"
					? await load(database, request.accountId)
					: await commit(database, request.plan),
			);
		} finally {
			database.close();
		}
	}
}

async function openDatabase(): Promise<IDBDatabase> {
	if (typeof globalThis.indexedDB === "undefined") {
		throw new Error("IndexedDB is unavailable");
	}
	const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
	request.onupgradeneeded = (event) => {
		if (event.oldVersion !== 0) {
			request.transaction?.abort();
			return;
		}
		const database = request.result;
		database.createObjectStore("heads", { keyPath: "accountId" });
		const items = database.createObjectStore("optimistic_items", {
			keyPath: ["accountId", "itemId"],
		});
		items.createIndex(ACCOUNT_INDEX, "accountId");
		const operations = database.createObjectStore("operations", {
			keyPath: ["accountId", "operationId"],
		});
		operations.createIndex(ACCOUNT_INDEX, "accountId");
	};
	const database = await requestResult(request);
	assertSchema(database);
	return database;
}

function assertSchema(database: IDBDatabase): void {
	for (const storeName of ["heads", "optimistic_items", "operations"]) {
		if (!database.objectStoreNames.contains(storeName)) {
			database.close();
			throw new Error(`IndexedDB schema is missing ${storeName}`);
		}
	}
}

async function load(database: IDBDatabase, accountId: string) {
	const transaction = database.transaction(
		["heads", "optimistic_items", "operations"],
		"readonly",
	);
	const completed = transactionDone(transaction);
	try {
		const headRequest = transaction.objectStore("heads").get(accountId);
		const itemsRequest = transaction
			.objectStore("optimistic_items")
			.index(ACCOUNT_INDEX)
			.getAll(accountId);
		const operationsRequest = transaction
			.objectStore("operations")
			.index(ACCOUNT_INDEX)
			.getAll(accountId);
		const [headValue, itemValues, operationValues] = await Promise.all([
			requestResult(headRequest),
			requestResult(itemsRequest),
			requestResult(operationsRequest),
		]);
		await completed;
		if (headValue === undefined) {
			return { type: "loaded", snapshot: null } as const;
		}
		const head = parseHead(headValue);
		const items = itemValues.map(parseStoredItem);
		if (head.accountId !== accountId) {
			throw new Error("head account scope does not match its key");
		}
		if (items.some((item) => item.accountId !== accountId)) {
			throw new Error("item account scope does not match its index");
		}
		const operations = operationValues.map((value) => {
			const stored = parseStoredOperation(value);
			if (stored.accountId !== accountId) {
				throw new Error("operation account scope does not match its index");
			}
			const { accountId: _, ...operation } = stored;
			return operation;
		});
		items.sort((left, right) => left.itemId.localeCompare(right.itemId));
		operations.sort((left, right) =>
			left.operationId.localeCompare(right.operationId),
		);
		return {
			type: "loaded",
			snapshot: { ...head, items, operations },
		} as const;
	} catch (error) {
		abort(transaction);
		await completed.catch(() => undefined);
		throw error;
	}
}

async function commit(database: IDBDatabase, plan: CommitPlan) {
	const transaction = database.transaction(
		["heads", "optimistic_items", "operations"],
		"readwrite",
	);
	const completed = transactionDone(transaction);
	try {
		const heads = transaction.objectStore("heads");
		const items = transaction.objectStore("optimistic_items");
		const operations = transaction.objectStore("operations");
		const headValue = await requestResult(heads.get(plan.accountId));
		if (headValue === undefined) {
			await completed;
			return { type: "committed", result: { type: "missing" } } as const;
		}
		const head = parseHead(headValue);
		if (
			head.incarnation !== plan.expectedIncarnation ||
			head.revision !== plan.expectedReplicaRevision
		) {
			await completed;
			return {
				type: "committed",
				result: { type: "stale", actualRevision: head.revision },
			} as const;
		}

		const operationIds = new Set<string>();
		for (const mutation of plan.mutations) {
			if (mutation.type === "acceptOperation") {
				operationIds.add(mutation.operation.operationId);
			} else if (mutation.type === "removeOperation") {
				operationIds.add(mutation.operationId);
			}
		}
		const operationState = new Map<string, boolean>();
		await Promise.all(
			[...operationIds].map(async (operationId) => {
				const value = await requestResult(
					operations.get([plan.accountId, operationId]),
				);
				operationState.set(operationId, value !== undefined);
			}),
		);
		for (const mutation of plan.mutations) {
			if (mutation.type === "acceptOperation") {
				if (operationState.get(mutation.operation.operationId)) {
					throw new Error("operation identity was reused");
				}
				operationState.set(mutation.operation.operationId, true);
			} else if (mutation.type === "removeOperation") {
				if (!operationState.get(mutation.operationId)) {
					throw new Error("cannot remove an unknown operation");
				}
				operationState.set(mutation.operationId, false);
			}
		}

		const nextRevision = incrementRevision(head.revision);
		for (const mutation of plan.mutations) {
			switch (mutation.type) {
				case "putOptimisticItem":
					items.put(mutation.item);
					break;
				case "acceptOperation":
					operations.put({
						accountId: plan.accountId,
						...mutation.operation,
					} satisfies StoredOperation);
					break;
				case "removeOperation":
					operations.delete([plan.accountId, mutation.operationId]);
					break;
			}
		}
		heads.put({ ...head, revision: nextRevision });
		await completed;
		return {
			type: "committed",
			result: { type: "applied", replicaRevision: nextRevision },
		} as const;
	} catch (error) {
		abort(transaction);
		await completed.catch(() => undefined);
		throw error;
	}
}

function parseRequest(requestJson: string): Request {
	let value: unknown;
	try {
		value = JSON.parse(requestJson);
	} catch {
		throw new Error("request must be valid JSON");
	}
	const request = object(value, "request");
	const type = string(request.type, "request.type");
	if (type === "load") {
		exactFields(request, ["type", "accountId"], "load request");
		return { type, accountId: string(request.accountId, "accountId") };
	}
	if (type === "commit") {
		exactFields(request, ["type", "plan"], "commit request");
		return { type, plan: parsePlan(request.plan) };
	}
	throw new Error(`unsupported request type: ${type}`);
}

function parsePlan(value: unknown): CommitPlan {
	const plan = object(value, "commit plan");
	exactFields(
		plan,
		[
			"accountId",
			"expectedIncarnation",
			"expectedReplicaRevision",
			"mutations",
		],
		"commit plan",
	);
	const accountId = string(plan.accountId, "plan.accountId");
	const mutationsValue = array(plan.mutations, "plan.mutations");
	return {
		accountId,
		expectedIncarnation: string(
			plan.expectedIncarnation,
			"plan.expectedIncarnation",
		),
		expectedReplicaRevision: revision(
			plan.expectedReplicaRevision,
			"plan.expectedReplicaRevision",
		),
		mutations: mutationsValue.map((mutation, index) =>
			parseMutation(mutation, accountId, index),
		),
	};
}

function parseMutation(
	value: unknown,
	accountId: string,
	index: number,
): Mutation {
	const context = `mutation ${index}`;
	const mutation = object(value, context);
	const type = string(mutation.type, `${context}.type`);
	if (type === "putOptimisticItem") {
		exactFields(
			mutation,
			["type", "accountId", "itemId", "vaultId", "ciphertext", "optimistic"],
			context,
		);
		const item = parseItem(mutation);
		if (item.accountId !== accountId) {
			throw new Error("item account scope does not match the guarded plan");
		}
		return { type, item };
	}
	if (type === "acceptOperation") {
		exactFields(
			mutation,
			["type", "operationId", "itemId", "requestBytes"],
			context,
		);
		return { type, operation: parseOperation(mutation) };
	}
	if (type === "removeOperation") {
		exactFields(mutation, ["type", "operationId"], context);
		return {
			type,
			operationId: string(mutation.operationId, `${context}.operationId`),
		};
	}
	throw new Error(`unsupported mutation type: ${type}`);
}

function parseHead(value: unknown): Head {
	const head = object(value, "stored head");
	exactFields(
		head,
		["accountId", "incarnation", "revision", "failure"],
		"stored head",
	);
	const failure = head.failure;
	if (failure !== null && typeof failure !== "string") {
		throw new Error("stored head.failure must be null or a string");
	}
	return {
		accountId: string(head.accountId, "stored head.accountId"),
		incarnation: string(head.incarnation, "stored head.incarnation"),
		revision: revision(head.revision, "stored head.revision"),
		failure,
	};
}

function parseStoredItem(value: unknown): ReplicaItem {
	const stored = object(value, "stored item");
	exactFields(
		stored,
		["accountId", "itemId", "vaultId", "ciphertext", "optimistic"],
		"stored item",
	);
	const item = parseItem(stored);
	return item;
}

function parseItem(value: JsonObject): ReplicaItem {
	return {
		accountId: string(value.accountId, "item.accountId"),
		itemId: string(value.itemId, "item.itemId"),
		vaultId: string(value.vaultId, "item.vaultId"),
		ciphertext: bytes(value.ciphertext, "item.ciphertext"),
		optimistic: boolean(value.optimistic, "item.optimistic"),
	};
}

function parseStoredOperation(value: unknown): StoredOperation {
	const stored = object(value, "stored operation");
	exactFields(
		stored,
		["accountId", "operationId", "itemId", "requestBytes"],
		"stored operation",
	);
	return {
		accountId: string(stored.accountId, "stored operation.accountId"),
		...parseOperation(stored),
	};
}

function parseOperation(value: JsonObject): Operation {
	return {
		operationId: string(value.operationId, "operation.operationId"),
		itemId: string(value.itemId, "operation.itemId"),
		requestBytes: bytes(value.requestBytes, "operation.requestBytes"),
	};
}

function object(value: unknown, context: string): JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${context} must be an object`);
	}
	return value as JsonObject;
}

function array(value: unknown, context: string): unknown[] {
	if (!Array.isArray(value)) {
		throw new Error(`${context} must be an array`);
	}
	return value;
}

function string(value: unknown, context: string): string {
	if (typeof value !== "string") {
		throw new Error(`${context} must be a string`);
	}
	return value;
}

function boolean(value: unknown, context: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`${context} must be a boolean`);
	}
	return value;
}

function bytes(value: unknown, context: string): number[] {
	const values = array(value, context);
	if (
		!values.every(
			(byte) =>
				typeof byte === "number" &&
				Number.isInteger(byte) &&
				byte >= 0 &&
				byte <= 255,
		)
	) {
		throw new Error(`${context} must contain only bytes`);
	}
	return values as number[];
}

function revision(value: unknown, context: string): string {
	const decimal = string(value, context);
	if (!/^(0|[1-9][0-9]*)$/.test(decimal) || BigInt(decimal) > MAX_U64) {
		throw new Error(`${context} must be a uint64 decimal string`);
	}
	return decimal;
}

function incrementRevision(value: string): string {
	const current = BigInt(revision(value, "replica revision"));
	if (current === MAX_U64) {
		throw new Error("replica revision overflow");
	}
	return (current + 1n).toString();
}

function exactFields(
	value: JsonObject,
	allowed: readonly string[],
	context: string,
): void {
	const allowedFields = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!allowedFields.has(key)) {
			throw new Error(`${context} has unexpected field: ${key}`);
		}
	}
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
		if (
			!(error instanceof DOMException && error.name === "InvalidStateError")
		) {
			throw error;
		}
	}
}
