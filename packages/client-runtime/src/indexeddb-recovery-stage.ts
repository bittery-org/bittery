import type {
	RecoveryControlRequest,
	RecoveryExpectedRow,
	ReplicaHead,
	ReplicaStore,
} from "../generated/recovery-control/contract";
import {
	openReplicaDatabase,
	RECOVERY_INPUT_STORE,
	REPLICA_STORE_MAP,
} from "./indexeddb-executor-internal";
import { waitRecovery } from "./recovery-cancellation";
import { assertRecoveryTextBound } from "./recovery-json";
import { RecoveryLimitError } from "./recovery-limit";

type Commit = Extract<RecoveryControlRequest, { type: "commitRepair" }>;
type TransactionAction<T> = (
	tx: IDBTransaction,
	awaitHash: (work: Promise<ArrayBuffer>) => Promise<ArrayBuffer>,
) => Promise<T>;

type Row = {
	store: ReplicaStore;
	recordId: string;
	payloadByteLength: number;
	bytes: number;
	chunks: number;
};
const LIMIT = 64 * 1024 * 1024;
const ROW_LIMIT = 100_000;
const stageKey = (
	accountId: string,
	recoveryId: string,
	kind: string,
	store = "",
	recordId = "",
	chunkIndex = 0,
): IDBValidKey => [accountId, recoveryId, kind, store, recordId, chunkIndex];
const prefix = (values: IDBValidKey[]) =>
	IDBKeyRange.bound(values, [...values, []]);

/** Unreachable input rows; Core validates identity and accepted-work coverage before committing. */
export class RecoveryRepairStage {
	constructor(
		private readonly signal: () => AbortSignal | undefined = () => undefined,
	) {}
	#transaction<T>(stores: string[], action: TransactionAction<T>) {
		return transaction(stores, action, this.signal());
	}
	#scope?: { recoveryId: string; accountId: string };
	#row?: Row;
	#expected = 0;
	#staged = 0;
	#busy = false;
	async close(): Promise<void> {
		const scope = this.#scope;
		if (scope !== undefined)
			await this.discard(scope.recoveryId, scope.accountId);
	}
	async begin(recoveryId: string, accountId: string): Promise<void> {
		if (this.#busy) throw new Error("Recovery staging is busy");
		this.#busy = true;
		try {
			await this.#transaction([RECOVERY_INPUT_STORE], async (tx) => {
				await request(tx.objectStore(RECOVERY_INPUT_STORE).clear());
			});
			this.#scope = { recoveryId, accountId };
			this.#row = undefined;
			this.#expected = 0;
			this.#staged = 0;
		} finally {
			this.#busy = false;
		}
	}
	async expected(
		recoveryId: string,
		accountId: string,
		row: RecoveryExpectedRow,
	): Promise<void> {
		return this.#run(recoveryId, accountId, async () => {
			if (this.#expected >= ROW_LIMIT)
				throw new RecoveryLimitError("recordCount");
			if (!/^[a-f0-9]{64}$/.test(row.payloadSha256))
				throw new Error("Recovery expected row is invalid");
			await this.#add("expected", row.store, row.recordId, 0, {
				payloadSha256: row.payloadSha256,
			});
			this.#expected++;
		});
	}
	async start(
		recoveryId: string,
		accountId: string,
		store: ReplicaStore,
		recordId: string,
		payloadByteLength: number,
	): Promise<void> {
		return this.#run(recoveryId, accountId, async () => {
			if (this.#staged >= ROW_LIMIT)
				throw new RecoveryLimitError("recordCount");
			if (payloadByteLength > LIMIT)
				throw new RecoveryLimitError("recordBytes");
			if (
				this.#row !== undefined ||
				!Number.isInteger(payloadByteLength) ||
				payloadByteLength < 0 ||
				recordId.length === 0
			)
				throw new Error("Recovery row start is invalid");
			await this.#add("row", store, recordId, 0, {
				payloadByteLength,
				complete: false,
			});
			this.#row = { store, recordId, payloadByteLength, bytes: 0, chunks: 0 };
		});
	}
	async chunk(
		recoveryId: string,
		accountId: string,
		bytes: Uint8Array,
	): Promise<void> {
		return this.#run(recoveryId, accountId, async () => {
			const row = this.#row;
			if (bytes.byteLength > 262144) throw new RecoveryLimitError("chunkBytes");
			if (
				row === undefined ||
				bytes.byteLength === 0 ||
				row.bytes + bytes.byteLength > row.payloadByteLength
			)
				throw new Error("Recovery row chunk is invalid");
			await this.#add("chunk", row.store, row.recordId, row.chunks, { bytes });
			row.bytes += bytes.byteLength;
			row.chunks++;
		});
	}
	async end(recoveryId: string, accountId: string): Promise<void> {
		return this.#run(recoveryId, accountId, async () => {
			const row = this.#row;
			if (row === undefined || row.bytes !== row.payloadByteLength)
				throw new Error("Recovery row is incomplete");
			await this.#transaction([RECOVERY_INPUT_STORE], async (tx) => {
				await request(
					tx.objectStore(RECOVERY_INPUT_STORE).put({
						accountId,
						recoveryId,
						kind: "row",
						store: row.store,
						recordId: row.recordId,
						chunkIndex: 0,
						payloadByteLength: row.bytes,
						chunks: row.chunks,
						complete: true,
					}),
				);
			});
			this.#row = undefined;
			this.#staged++;
		});
	}
	async discard(recoveryId: string, accountId: string): Promise<void> {
		return this.#run(recoveryId, accountId, async () => {
			await this.#transaction([RECOVERY_INPUT_STORE], async (tx) => {
				await request(
					tx
						.objectStore(RECOVERY_INPUT_STORE)
						.delete(prefix([accountId, recoveryId])),
				);
			});
			this.#scope = undefined;
			this.#row = undefined;
		});
	}
	async commit(command: Commit): Promise<"repaired" | "stale"> {
		return this.#run(command.recoveryId, command.accountId, async () => {
			if (
				this.#row !== undefined ||
				this.#expected !== command.expectedRowCount ||
				this.#staged !== command.stagedRowCount
			)
				throw new Error("Recovery stage is incomplete");
			const result = await this.#transaction(
				["heads", ...Object.values(REPLICA_STORE_MAP), RECOVERY_INPUT_STORE],
				async (tx, awaitHash) => {
					const { accountId, recoveryId } = command;
					const current = await request(tx.objectStore("heads").get(accountId));
					if (JSON.stringify(current) !== command.expectedHeadJson)
						return "stale" as const;
					assertHeadAdvance(current, command.nextHead, accountId);
					const input = tx.objectStore(RECOVERY_INPUT_STORE);
					let expectedCount = 0;
					for (const [logical, physical] of Object.entries(REPLICA_STORE_MAP)) {
						const store = tx.objectStore(physical);
						for await (const row of entries(store, prefix([accountId]))) {
							const value = row.value;
							if (
								value.accountId !== accountId ||
								typeof value.recordId !== "string" ||
								typeof value.payloadJson !== "string"
							)
								throw new Error("Recovery source row is malformed");
							assertRecoveryTextBound(value.payloadJson);
							const expected = await request(
								input.get(
									stageKey(
										accountId,
										recoveryId,
										"expected",
										logical,
										value.recordId,
									),
								),
							);
							if (expected === undefined) return "stale" as const;
							const digest = new Uint8Array(
								await awaitHash(
									crypto.subtle.digest(
										"SHA-256",
										new TextEncoder().encode(value.payloadJson),
									),
								),
							);
							const hex = Array.from(digest, (byte) =>
								byte.toString(16).padStart(2, "0"),
							).join("");
							if (expected.payloadSha256 !== hex) return "stale" as const;
							expectedCount++;
						}
					}
					if (
						expectedCount !== command.expectedRowCount ||
						(await request(
							input.count(prefix([accountId, recoveryId, "expected"])),
						)) !== expectedCount ||
						(await request(
							input.count(prefix([accountId, recoveryId, "row"])),
						)) !== command.stagedRowCount
					)
						return "stale" as const;
					for (const physical of Object.values(REPLICA_STORE_MAP))
						await request(tx.objectStore(physical).delete(prefix([accountId])));
					let rowCount = 0;
					for await (const { value } of entries(
						input,
						prefix([accountId, recoveryId, "row"]),
					)) {
						if (
							value.complete !== true ||
							!Number.isInteger(value.payloadByteLength) ||
							value.payloadByteLength < 0 ||
							value.payloadByteLength > LIMIT ||
							!Number.isInteger(value.chunks) ||
							value.chunks < 0
						)
							throw new Error("Recovery staged row is malformed");
						const bytes = new Uint8Array(value.payloadByteLength);
						let offset = 0;
						for (let index = 0; index < value.chunks; index++) {
							const chunk = await request(
								input.get(
									stageKey(
										accountId,
										recoveryId,
										"chunk",
										value.store,
										value.recordId,
										index,
									),
								),
							);
							if (
								!(chunk?.bytes instanceof Uint8Array) ||
								chunk.bytes.byteLength === 0 ||
								chunk.bytes.byteLength > 262144 ||
								offset + chunk.bytes.byteLength > bytes.length
							)
								throw new Error("Recovery staged chunk is malformed");
							bytes.set(chunk.bytes, offset);
							offset += chunk.bytes.byteLength;
						}
						if (offset !== bytes.length)
							throw new Error("Recovery staged row is truncated");
						const payloadJson = new TextDecoder("utf-8", {
							fatal: true,
						}).decode(bytes);
						const physical = REPLICA_STORE_MAP[value.store as ReplicaStore];
						if (
							physical === undefined ||
							value.accountId !== accountId ||
							value.recoveryId !== recoveryId ||
							typeof value.recordId !== "string"
						)
							throw new Error("Recovery staged row scope is invalid");
						await request(
							tx
								.objectStore(physical)
								.put({ accountId, recordId: value.recordId, payloadJson }),
						);
						rowCount++;
					}
					if (rowCount !== command.stagedRowCount)
						throw new Error("Recovery row count changed");
					await request(tx.objectStore("heads").put(command.nextHead));
					await request(input.delete(prefix([accountId, recoveryId])));
					return "repaired" as const;
				},
			);
			if (result === "repaired") this.#scope = undefined;
			return result;
		});
	}
	async #add(
		kind: string,
		store: ReplicaStore,
		recordId: string,
		chunkIndex: number,
		fields: Record<string, unknown>,
	) {
		const scope = this.#scope;
		if (scope === undefined || !Object.hasOwn(REPLICA_STORE_MAP, store))
			throw new Error("Recovery stage is not open");
		await this.#transaction([RECOVERY_INPUT_STORE], async (tx) => {
			await request(
				tx
					.objectStore(RECOVERY_INPUT_STORE)
					.add({ ...scope, kind, store, recordId, chunkIndex, ...fields }),
			);
		});
	}
	async #run<T>(
		recoveryId: string,
		accountId: string,
		action: () => Promise<T>,
	): Promise<T> {
		if (
			this.#busy ||
			this.#scope?.recoveryId !== recoveryId ||
			this.#scope.accountId !== accountId
		)
			throw new Error("Recovery stage scope is invalid or busy");
		this.#busy = true;
		try {
			return await action();
		} finally {
			this.#busy = false;
		}
	}
}
function assertHeadAdvance(
	current: ReplicaHead,
	next: ReplicaHead,
	accountId: string,
) {
	const counter = (value: unknown) => {
		if (
			typeof value !== "string" ||
			!/^(0|[1-9][0-9]*)$/.test(value) ||
			BigInt(value) > 18446744073709551615n
		)
			throw new Error("Recovery head counter is invalid");
		return BigInt(value);
	};
	if (
		current?.accountId !== accountId ||
		next.accountId !== accountId ||
		typeof current.userId !== "string" ||
		current.userId.length === 0 ||
		current.userId !== next.userId ||
		typeof current.incarnation !== "string" ||
		current.incarnation.length === 0 ||
		current.incarnation !== next.incarnation ||
		counter(next.replicaRevision) <= counter(current.replicaRevision) ||
		counter(next.lockEpoch) <= counter(current.lockEpoch)
	)
		throw new Error("Recovery head transition is invalid");
}
function request<T>(value: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		value.onsuccess = () => resolve(value.result);
		value.onerror = () => reject(value.error);
	});
}
async function* entries(store: IDBObjectStore, range: IDBKeyRange) {
	let key: IDBValidKey | undefined;
	while (true) {
		const cursor = await request(
			store.openCursor(
				key === undefined
					? range
					: IDBKeyRange.bound(key, range.upper, true, range.upperOpen),
			),
		);
		if (cursor === null) return;
		key = cursor.primaryKey;
		yield { key, value: cursor.value };
	}
}
/** Keep the exact read/write transaction alive across bounded WebCrypto work. */
async function transaction<T>(
	stores: string[],
	action: TransactionAction<T>,
	signal?: AbortSignal,
): Promise<T> {
	const firstStore = stores[0];
	if (firstStore === undefined)
		throw new Error("Recovery transaction requires stores");
	signal?.throwIfAborted();
	const database = await openReplicaDatabase();
	if (signal?.aborted) {
		database.close();
		signal.throwIfAborted();
	}
	const tx = database.transaction(stores, "readwrite");
	const abort = () => {
		try {
			tx.abort();
		} catch {}
	};
	signal?.addEventListener("abort", abort, { once: true });
	let active = true;
	const done = new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onabort = () =>
			reject(tx.error ?? new Error("Recovery transaction aborted"));
	});
	let pendingKeepAlive: IDBRequest | undefined;
	const keepAlive = () => {
		if (!active) return;
		try {
			const next = tx.objectStore(firstStore).get("__recovery_keepalive__");
			pendingKeepAlive = next;
			next.onsuccess = keepAlive;
			next.onerror = () => {};
		} catch {}
	};
	keepAlive();
	const awaitHash = async (
		work: Promise<ArrayBuffer>,
	): Promise<ArrayBuffer> => {
		const value = await work;
		signal?.throwIfAborted();
		const pending = pendingKeepAlive;
		if (!active || pending?.readyState !== "pending")
			throw new Error("Recovery transaction ended before hashing completed");
		// A queued request keeps the transaction alive, but Firefox still marks an
		// external WebCrypto task inactive. Resume from its next real IDB event.
		return new Promise((resolve, reject) => {
			const cleanup = () => {
				pending.removeEventListener("success", success);
				pending.removeEventListener("error", failure);
			};
			const success = () => {
				cleanup();
				resolve(value);
			};
			const failure = () => {
				cleanup();
				reject(
					pending.error ?? new Error("Recovery transaction request failed"),
				);
			};
			pending.addEventListener("success", success, { once: true });
			pending.addEventListener("error", failure, { once: true });
		});
	};
	try {
		const result = await waitRecovery(action(tx, awaitHash), signal);
		active = false;
		await done;
		return result;
	} catch (error) {
		active = false;
		try {
			tx.abort();
		} catch {}
		await done.catch(() => undefined);
		throw error;
	} finally {
		active = false;
		signal?.removeEventListener("abort", abort);
		database.close();
	}
}
