import type {
	RecoveryControlResponse,
	RecoveryRecord,
	ReplicaStore,
} from "../generated/recovery-control/contract";
import { validateRecoveryControlResponse } from "../generated/recovery-control/validator";
import { openAttachmentArtifactDatabase } from "./indexeddb-attachment-artifact-executor-internal";
import {
	openReplicaDatabase,
	REPLICA_STORE_MAP,
} from "./indexeddb-executor-internal";
import { openVaultImageArtifactDatabase } from "./indexeddb-vault-image-artifact-executor";
import {
	assertRecoveryJsonBound,
	assertRecoveryTextBound,
	RECOVERY_RECORD_BYTES,
	recoveryJson,
} from "./recovery-json";
import { RecoveryLimitError } from "./recovery-limit";

type Entry = { control: RecoveryControlResponse; binaryChunk?: Uint8Array };
type Store = {
	open: () => Promise<IDBDatabase>;
	name: string;
	kind: Exclude<
		RecoveryRecord["type"],
		"protectedVaultImageMetadata" | "protectedVaultImageChunk"
	>;
	logical?: ReplicaStore;
};
const STORES: Store[] = [
	{ open: openReplicaDatabase, name: "heads", kind: "rawReplicaHead" },
	...Object.entries(REPLICA_STORE_MAP).map(([logical, name]) => ({
		open: openReplicaDatabase,
		name,
		kind: "rawReplicaRow" as const,
		logical: logical as ReplicaStore,
	})),
	{
		open: openAttachmentArtifactDatabase,
		name: "artifacts",
		kind: "artifactMetadata",
	},
	{
		open: openAttachmentArtifactDatabase,
		name: "chunks",
		kind: "artifactChunk",
	},
	{
		open: openAttachmentArtifactDatabase,
		name: "provisional_artifacts",
		kind: "provisionalMetadata",
	},
	{
		open: openAttachmentArtifactDatabase,
		name: "provisional_chunks",
		kind: "provisionalChunk",
	},
	{
		open: openVaultImageArtifactDatabase,
		name: "artifacts",
		kind: "vaultImageMetadata",
	},
	{
		open: openVaultImageArtifactDatabase,
		name: "chunks",
		kind: "vaultImageChunk",
	},
];

/** One bounded, sequential, Account-scoped scan while the owner holds exclusive maintenance. */
export class RecoveryRecordReader {
	#position = 0;
	#key?: IDBValidKey;
	#account?: string;
	#next?: string;
	#reading = false;
	async read(
		accountId: string,
		cursor?: string | null,
		signal?: AbortSignal,
	): Promise<Entry> {
		if (this.#reading) throw new Error("Recovery scan is busy");
		if (cursor == null) {
			this.#position = 0;
			this.#key = undefined;
			this.#account = accountId;
			this.#next = undefined;
		} else if (this.#account !== accountId || this.#next !== cursor)
			throw new Error("Recovery cursor is invalid");
		this.#reading = true;
		try {
			while (this.#position < STORES.length) {
				const descriptor = STORES[this.#position];
				if (descriptor === undefined)
					throw new Error("Recovery scan position is invalid");
				signal?.throwIfAborted();
				const db = await descriptor.open();
				if (signal?.aborted) {
					db.close();
					signal.throwIfAborted();
				}
				let row:
					| { key: IDBValidKey; value: Record<string, unknown> }
					| undefined;
				try {
					const tx = db.transaction(descriptor.name, "readonly");
					const completed = transactionDone(tx, signal);
					void completed.catch(() => undefined);
					const range =
						descriptor.kind === "rawReplicaHead"
							? this.#key === undefined
								? IDBKeyRange.only(accountId)
								: undefined
							: IDBKeyRange.bound(
									this.#key ?? [accountId],
									[accountId, []],
									this.#key !== undefined,
								);
					if (range !== undefined) {
						const result = await requestResult(
							tx.objectStore(descriptor.name).openCursor(range),
						);
						if (result !== null)
							row = { key: result.primaryKey, value: result.value };
					}
					await completed;
					signal?.throwIfAborted();
				} finally {
					db.close();
				}
				if (row === undefined) {
					this.#position++;
					this.#key = undefined;
					continue;
				}
				if (
					(Array.isArray(row.key) ? row.key[0] : row.key) !== accountId ||
					row.value.accountId !== accountId
				)
					throw new Error("Recovery Account scope is invalid");
				const value = mapRecord(descriptor, accountId, row.value);
				const current = cursor ?? crypto.randomUUID();
				const next = crypto.randomUUID();
				const control = {
					type: "entry" as const,
					cursor: current,
					nextCursor: next,
					record: value.record,
				};
				assertRecoveryJsonBound(control);
				if (!validateRecoveryControlResponse(control))
					throw new Error("Recovery physical record is invalid");
				this.#key = row.key;
				this.#next = next;
				return {
					control,
					...(value.binaryChunk === undefined
						? {}
						: { binaryChunk: value.binaryChunk }),
				};
			}
			this.#next = undefined;
			return { control: { type: "end" } };
		} finally {
			this.#reading = false;
		}
	}
}

function mapRecord(
	descriptor: Store,
	accountId: string,
	value: Record<string, unknown>,
): { record: RecoveryRecord; binaryChunk?: Uint8Array } {
	const image =
		descriptor.kind === "vaultImageMetadata" ||
		descriptor.kind === "vaultImageChunk";
	const publication = image ? (value.publicationId ?? "") : "";
	if (
		typeof publication !== "string" ||
		(image && publication === "" && value.protection != null)
	)
		throw new Error("Recovery image publication is invalid");
	const string = (key: string) => {
		const result = value[key];
		if (typeof result !== "string")
			throw new Error("Recovery record field is invalid");
		return result;
	};
	const index = () => {
		if (!Number.isInteger(value.chunkIndex) || (value.chunkIndex as number) < 0)
			throw new Error("Recovery chunk index is invalid");
		return value.chunkIndex as number;
	};
	const metadata = () => {
		const { bytes: _bytes, ...rest } = value;
		if (image && publication === "") {
			const {
				publicationId: _publication,
				protection: _protection,
				...raw
			} = rest;
			return boundedJson(raw);
		}
		return boundedJson(rest);
	};
	const bytes = () => {
		const raw = value.bytes;
		if (
			!(raw instanceof Uint8Array || raw instanceof ArrayBuffer) ||
			raw.byteLength === 0
		)
			throw new Error("Recovery chunk size is invalid");
		if (raw.byteLength > 262144) throw new RecoveryLimitError("chunkBytes");
		return raw instanceof Uint8Array
			? new Uint8Array(raw)
			: new Uint8Array(raw.slice(0));
	};
	switch (descriptor.kind) {
		case "rawReplicaHead":
			return {
				record: {
					type: descriptor.kind,
					accountId,
					payloadJson: boundedJson(value),
				},
			};
		case "rawReplicaRow": {
			const payloadJson = string("payloadJson");
			assertRecoveryTextBound(payloadJson);
			if (descriptor.logical === undefined)
				throw new Error("Recovery store is invalid");
			return {
				record: {
					type: descriptor.kind,
					accountId,
					store: descriptor.logical,
					recordId: string("recordId"),
					payloadJson,
				},
			};
		}
		case "artifactMetadata":
			return {
				record: {
					type: descriptor.kind,
					accountId,
					artifactId: string("artifactId"),
					metadataJson: metadata(),
				},
			};
		case "artifactChunk":
			return {
				record: {
					type: descriptor.kind,
					accountId,
					artifactId: string("artifactId"),
					chunkIndex: index(),
					chunkSha256: string("chunkSha256"),
				},
				binaryChunk: bytes(),
			};
		case "provisionalMetadata":
			return {
				record: {
					type: descriptor.kind,
					accountId,
					operationId: string("operationId"),
					attachmentId: string("attachmentId"),
					generation: string("generation"),
					metadataJson: metadata(),
				},
			};
		case "provisionalChunk":
			return {
				record: {
					type: descriptor.kind,
					accountId,
					operationId: string("operationId"),
					attachmentId: string("attachmentId"),
					generation: string("generation"),
					chunkIndex: index(),
					chunkSha256: string("chunkSha256"),
				},
				binaryChunk: bytes(),
			};
		case "vaultImageMetadata":
			return {
				record: {
					...(publication
						? {
								type: "protectedVaultImageMetadata" as const,
								publicationId: publication,
							}
						: { type: "vaultImageMetadata" as const }),
					accountId,
					operationId: string("operationId"),
					metadataJson: metadata(),
				},
			};
		case "vaultImageChunk":
			return {
				record: {
					...(publication
						? {
								type: "protectedVaultImageChunk" as const,
								publicationId: publication,
							}
						: { type: "vaultImageChunk" as const }),
					accountId,
					operationId: string("operationId"),
					chunkIndex: index(),
				},
				binaryChunk: bytes(),
			};
	}
}
function boundedJson(value: unknown): string {
	return recoveryJson(value, RECOVERY_RECORD_BYTES, "recordBytes");
}
function requestResult<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}
function transactionDone(
	tx: IDBTransaction,
	signal?: AbortSignal,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const abort = () => {
			try {
				tx.abort();
			} catch {}
		};
		signal?.addEventListener("abort", abort, { once: true });
		tx.oncomplete = () => {
			signal?.removeEventListener("abort", abort);
			resolve();
		};
		tx.onabort = () => {
			signal?.removeEventListener("abort", abort);
			reject(
				signal?.aborted
					? new DOMException("Recovery cancelled", "AbortError")
					: tx.error,
			);
		};
	});
}

/** Catalog-independent physical Account identities; never infers registration or Server identity. */
export class RecoveryAccountReader {
	#position = 0;
	#key?: IDBValidKey;
	#next?: string;
	#reading = false;
	async read(cursor?: string | null, signal?: AbortSignal): Promise<Entry> {
		if (this.#reading) throw new Error("Recovery Account scan is busy");
		if (cursor == null) {
			this.#position = 0;
			this.#key = undefined;
			this.#next = undefined;
		} else if (this.#next !== cursor)
			throw new Error("Recovery Account cursor is invalid");
		this.#reading = true;
		try {
			while (this.#position < STORES.length) {
				const descriptor = STORES[this.#position];
				if (descriptor === undefined)
					throw new Error("Recovery Account scan position is invalid");
				signal?.throwIfAborted();
				const db = await descriptor.open();
				if (signal?.aborted) {
					db.close();
					signal.throwIfAborted();
				}
				let key: IDBValidKey | undefined;
				try {
					const tx = db.transaction(descriptor.name, "readonly");
					const completed = transactionDone(tx, signal);
					void completed.catch(() => undefined);
					const store = tx.objectStore(descriptor.name);
					const source =
						descriptor.kind === "rawReplicaHead"
							? store
							: store.index("by_account");
					const next = await requestResult(
						source.openKeyCursor(
							this.#key === undefined
								? undefined
								: IDBKeyRange.lowerBound(this.#key, true),
							"nextunique",
						),
					);
					key = next?.key;
					await completed;
					signal?.throwIfAborted();
				} finally {
					db.close();
				}
				if (key === undefined) {
					this.#position++;
					this.#key = undefined;
					continue;
				}
				if (typeof key !== "string" || key.length === 0)
					throw new Error("Recovery Account key is malformed");
				assertRecoveryTextBound(key, 4096);
				const next = crypto.randomUUID();
				const control = {
					type: "accountEntry" as const,
					accountId: key,
					cursor: cursor ?? crypto.randomUUID(),
					nextCursor: next,
				};
				if (!validateRecoveryControlResponse(control))
					throw new Error("Recovery Account response is invalid");
				this.#key = key;
				this.#next = next;
				return { control };
			}
			this.#next = undefined;
			return { control: { type: "end" } };
		} finally {
			this.#reading = false;
		}
	}
}
