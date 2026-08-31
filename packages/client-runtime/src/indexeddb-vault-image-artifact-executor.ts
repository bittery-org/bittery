import type {
	VaultImageMetadataControl as Metadata,
	VaultImageScopeControl as Scope,
	VaultImageControlRequest,
} from "../generated/vault-image-control/contract";
import { validateVaultImageControlRequest } from "../generated/vault-image-control/validator";
import { wipeBinaryIntrinsic } from "./binary-intrinsics";

type ArtifactRow = Metadata & { published: boolean };
type ChunkRow = Scope & { chunkIndex: number; bytes: Uint8Array };
const ID = /^[A-Za-z0-9._~-]{1,128}$/;
const MIME = new Set([
	"image/jpeg",
	"image/png",
	"image/webp",
	"image/gif",
	"image/avif",
]);

export class IndexedDbVaultImageArtifactExecutor {
	readonly #name: string;
	readonly #failure?: {
		operation:
			| "begin"
			| "write"
			| "publish"
			| "delete"
			| "deleteAccount"
			| "wipe"
			| "sweep";
		boundary: 1 | 2;
	};
	readonly #digest: (bytes: Uint8Array) => Promise<ArrayBuffer>;
	#opening?: Promise<IDBDatabase>;
	#sweep?: Promise<void>;
	constructor(
		options: {
			databaseName?: string;
			failure?: {
				operation:
					| "begin"
					| "write"
					| "publish"
					| "delete"
					| "deleteAccount"
					| "wipe"
					| "sweep";
				boundary: 1 | 2;
			};
			digest?: (bytes: Uint8Array) => Promise<ArrayBuffer>;
		} = {},
	) {
		this.#name = options.databaseName ?? "bittery-vault-image-artifacts";
		this.#failure = options.failure;
		this.#digest =
			options.digest ??
			((bytes) =>
				crypto.subtle.digest("SHA-256", bytes) as Promise<ArrayBuffer>);
	}
	async invoke(
		request: VaultImageControlRequest,
		binary?: Uint8Array,
	): Promise<unknown> {
		try {
			validateRequest(request);
			if (request.type !== "startupSweep" && this.#sweep !== undefined)
				await this.#sweep;
			switch (request.type) {
				case "begin":
					await this.#begin(request.scope);
					return { type: "begun" };
				case "writeChunk":
					if (
						binary === undefined ||
						binary.byteLength < 1 ||
						binary.byteLength > 262_144
					)
						throw new Error("Vault-image chunk is invalid");
					return {
						type: "chunkWritten",
						result: await this.#write(
							request.scope,
							request.chunkIndex,
							binary,
						),
					};
				case "publish":
					return {
						type: "published",
						result: await this.#publish(request.metadata),
					};
				case "readChunk": {
					const bytes = await this.#read(request.metadata, request.chunkIndex);
					return bytes === undefined
						? { type: "missing" }
						: { type: "chunk", bytes };
				}
				case "delete":
					await this.#delete(request.scope);
					return { type: "deleted" };
				case "deleteAccount":
					await this.#deleteAccount(request.accountId);
					return { type: "accountDeleted" };
				case "wipe":
					await this.#wipe();
					return { type: "wiped" };
				case "startupSweep": {
					if (this.#sweep !== undefined)
						throw new Error("Vault-image startup sweep is already active");
					const task = this.#startupSweep(
						request.accountId,
						new Set(request.referencedOperationIds),
					);
					this.#sweep = task;
					try {
						await task;
					} finally {
						if (this.#sweep === task) this.#sweep = undefined;
					}
					return { type: "swept" };
				}
			}
		} finally {
			if (binary !== undefined) wipeBinaryIntrinsic(binary);
		}
	}
	async #database() {
		if (this.#opening !== undefined) return this.#opening;
		this.#opening = new Promise((resolve, reject) => {
			const request = indexedDB.open(this.#name, 1);
			request.onupgradeneeded = () => {
				const db = request.result;
				const artifacts = db.createObjectStore("artifacts", {
					keyPath: ["accountId", "operationId"],
				});
				artifacts.createIndex("by_account", "accountId");
				const chunks = db.createObjectStore("chunks", {
					keyPath: ["accountId", "operationId", "chunkIndex"],
				});
				chunks.createIndex("by_scope", ["accountId", "operationId"]);
				chunks.createIndex("by_account", "accountId");
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () =>
				reject(request.error ?? new Error("Vault-image IndexedDB open failed"));
		});
		return this.#opening;
	}
	async #begin(scope: Scope) {
		const db = await this.#database();
		const tx = db.transaction("artifacts", "readwrite");
		const store = tx.objectStore("artifacts");
		const existing = await result<ArtifactRow | undefined>(
			store.get(key(scope)),
		);
		this.#fail(tx, "begin", 1);
		if (existing === undefined) store.add({ ...scope, published: false });
		this.#fail(tx, "begin", 2);
		await complete(tx);
	}
	async #write(scope: Scope, index: number, bytes: Uint8Array) {
		const db = await this.#database();
		const tx = db.transaction(["artifacts", "chunks"], "readwrite");
		const artifacts = tx.objectStore("artifacts");
		const chunks = tx.objectStore("chunks");
		const owner = await result<ArtifactRow | undefined>(
			artifacts.get(key(scope)),
		);
		if (owner === undefined || owner.published)
			throw new Error("Vault-image artifact is not writable");
		const existing = await result<ChunkRow | undefined>(
			chunks.get([...key(scope), index]),
		);
		if (existing !== undefined) {
			try {
				if (!equal(existing.bytes, bytes))
					throw new Error("Vault-image chunk conflicts");
				await complete(tx);
				return "alreadyStored";
			} finally {
				wipeBinaryIntrinsic(existing.bytes);
			}
		}
		const count = await result<number>(
			chunks.index("by_scope").count(key(scope)),
		);
		if (count !== index)
			throw new Error("Vault-image chunks must be contiguous");
		const recordBytes = new Uint8Array(bytes);
		try {
			this.#fail(tx, "write", 1);
			chunks.add({
				...scope,
				chunkIndex: index,
				bytes: recordBytes,
			} satisfies ChunkRow);
			this.#fail(tx, "write", 2);
			await complete(tx);
			return "stored";
		} finally {
			// IndexedDB has synchronously structured-cloned this record before `add`
			// returns; this executor-owned source snapshot is no longer needed.
			wipeBinaryIntrinsic(recordBytes);
		}
	}
	async #publish(metadata: Metadata) {
		const db = await this.#database();
		const tx = db.transaction(["artifacts", "chunks"], "readwrite");
		const store = tx.objectStore("artifacts");
		const existing = await result<ArtifactRow | undefined>(
			store.get(key(metadata)),
		);
		if (existing === undefined)
			throw new Error("Vault-image artifact was not begun");
		if (existing.published) {
			if (!sameMetadata(existing, metadata))
				throw new Error("Vault-image publication conflicts");
			await complete(tx);
			return "alreadyPublished";
		}
		const chunks = await result<ChunkRow[]>(
			tx
				.objectStore("chunks")
				.index("by_scope")
				.getAll(IDBKeyRange.only(key(metadata))),
		);
		let owned: Uint8Array | undefined;
		try {
			owned = publicationBytes(metadata, chunks);
			// WebCrypto is asynchronous. Keep this same readwrite transaction alive while
			// it hashes the exact owned snapshot so no other executor can replace chunks
			// between validation and the publication marker.
			const digest = keepTransactionAlive(store, this.#digest(owned));
			const lowercase = [...new Uint8Array(await digest)]
				.map((byte) => byte.toString(16).padStart(2, "0"))
				.join("");
			if (lowercase !== metadata.sha256)
				throw new Error("Vault-image artifact digest conflicts");
		} finally {
			// Both the contiguous digest input and every structured-clone row returned by
			// `getAll` are executor-owned plaintext snapshots, including on validation errors.
			if (owned !== undefined) wipeBinaryIntrinsic(owned);
			for (const chunk of chunks) wipeBinaryIntrinsic(chunk.bytes);
		}
		this.#fail(tx, "publish", 1);
		store.put({ ...metadata, published: true } satisfies ArtifactRow);
		this.#fail(tx, "publish", 2);
		await complete(tx);
		return "published";
	}
	async #read(metadata: Metadata, index: number) {
		const db = await this.#database();
		const tx = db.transaction(["artifacts", "chunks"], "readonly");
		const owner = await result<ArtifactRow | undefined>(
			tx.objectStore("artifacts").get(key(metadata)),
		);
		if (owner === undefined) {
			await complete(tx);
			return undefined;
		}
		if (!owner.published || !sameMetadata(owner, metadata))
			throw new Error("Vault-image metadata conflicts");
		const chunk = await result<ChunkRow | undefined>(
			tx.objectStore("chunks").get([...key(metadata), index]),
		);
		if (chunk === undefined) {
			await complete(tx);
			return undefined;
		}
		try {
			const owned = new Uint8Array(chunk.bytes);
			await complete(tx);
			return owned;
		} finally {
			// `get` returns an executor-owned structured clone. Only the distinct
			// returned copy crosses the port boundary.
			wipeBinaryIntrinsic(chunk.bytes);
		}
	}
	async #delete(scope: Scope) {
		const db = await this.#database();
		const tx = db.transaction(["artifacts", "chunks"], "readwrite");
		const chunks = tx.objectStore("chunks");
		const chunkKeys = await result<IDBValidKey[]>(
			chunks.index("by_scope").getAllKeys(IDBKeyRange.only(key(scope))),
		);
		this.#fail(tx, "delete", 1);
		for (const chunkKey of chunkKeys) chunks.delete(chunkKey);
		tx.objectStore("artifacts").delete(key(scope));
		this.#fail(tx, "delete", 2);
		await complete(tx);
	}
	async #deleteAccount(accountId: string) {
		const db = await this.#database();
		const tx = db.transaction(["artifacts", "chunks"], "readwrite");
		this.#fail(tx, "deleteAccount", 1);
		for (const storeName of ["chunks", "artifacts"]) {
			const store = tx.objectStore(storeName);
			const keys = await result<IDBValidKey[]>(
				store.index("by_account").getAllKeys(IDBKeyRange.only(accountId)),
			);
			for (const itemKey of keys) store.delete(itemKey);
		}
		this.#fail(tx, "deleteAccount", 2);
		await complete(tx);
	}
	async #wipe() {
		const db = await this.#database();
		const tx = db.transaction(["artifacts", "chunks"], "readwrite");
		this.#fail(tx, "wipe", 1);
		tx.objectStore("chunks").clear();
		tx.objectStore("artifacts").clear();
		this.#fail(tx, "wipe", 2);
		await complete(tx);
	}
	async #startupSweep(accountId: string, refs: Set<string>) {
		const db = await this.#database();
		const tx = db.transaction(["artifacts", "chunks"], "readwrite");
		const artifacts = tx.objectStore("artifacts");
		const chunks = tx.objectStore("chunks");
		const rows = await result<ArtifactRow[]>(
			artifacts.index("by_account").getAll(IDBKeyRange.only(accountId)),
		);
		this.#fail(tx, "sweep", 1);
		for (const row of rows) {
			if (refs.has(row.operationId)) continue;
			const chunkKeys = await result<IDBValidKey[]>(
				chunks.index("by_scope").getAllKeys(IDBKeyRange.only(key(row))),
			);
			for (const chunkKey of chunkKeys) chunks.delete(chunkKey);
			artifacts.delete(key(row));
		}
		this.#fail(tx, "sweep", 2);
		await complete(tx);
	}
	#fail(
		transaction: IDBTransaction,
		operation:
			| "begin"
			| "write"
			| "publish"
			| "delete"
			| "deleteAccount"
			| "wipe"
			| "sweep",
		boundary: 1 | 2,
	) {
		if (
			this.#failure?.operation === operation &&
			this.#failure.boundary === boundary
		) {
			transaction.onabort = () => {};
			transaction.onerror = (event) => event.preventDefault();
			transaction.abort();
			throw new Error("Injected Vault-image IndexedDB failure");
		}
	}
}
const key = (scope: Scope) => [scope.accountId, scope.operationId];
function validateRequest(request: VaultImageControlRequest) {
	if (!validateVaultImageControlRequest(request))
		throw new Error("Vault-image control is invalid");
	if ("scope" in request) validateScope(request.scope);
	if ("metadata" in request) {
		validateScope(request.metadata);
		const length = Number(request.metadata.byteLength);
		if (
			!ID.test(request.metadata.vaultId) ||
			!Number.isSafeInteger(length) ||
			length < 1 ||
			length > 2_097_152 ||
			!MIME.has(request.metadata.contentType) ||
			!/^[0-9a-f]{64}$/.test(request.metadata.sha256)
		)
			throw new Error("Vault-image metadata is invalid");
	}
	if ("accountId" in request && !ID.test(request.accountId))
		throw new Error("Vault-image Account is invalid");
	if (
		"chunkIndex" in request &&
		(!Number.isSafeInteger(request.chunkIndex) || request.chunkIndex < 0)
	)
		throw new Error("Vault-image chunk index is invalid");
}
function validateScope(scope: Scope) {
	if (!ID.test(scope.accountId) || !ID.test(scope.operationId))
		throw new Error("Vault-image scope is invalid");
}
const sameMetadata = (left: ArtifactRow, right: Metadata) =>
	left.accountId === right.accountId &&
	left.operationId === right.operationId &&
	left.vaultId === right.vaultId &&
	left.byteLength === right.byteLength &&
	left.contentType === right.contentType &&
	left.sha256 === right.sha256;
const equal = (a: Uint8Array, b: Uint8Array) =>
	a.byteLength === b.byteLength &&
	a.every((value, index) => value === b[index]);
function publicationBytes(metadata: Metadata, chunks: ChunkRow[]): Uint8Array {
	let total = 0;
	for (const [index, chunk] of chunks.entries()) {
		if (
			chunk.chunkIndex !== index ||
			chunk.bytes.byteLength < 1 ||
			chunk.bytes.byteLength > 262_144 ||
			(index + 1 < chunks.length && chunk.bytes.byteLength !== 262_144)
		)
			throw new Error("Vault-image artifact chunks are incomplete");
		total += chunk.bytes.byteLength;
	}
	if (chunks.length === 0 || total !== Number(metadata.byteLength))
		throw new Error("Vault-image artifact length conflicts");
	const owned = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		owned.set(chunk.bytes, offset);
		offset += chunk.bytes.byteLength;
	}
	return owned;
}
async function keepTransactionAlive<T>(
	store: IDBObjectStore,
	work: Promise<T>,
): Promise<T> {
	let settled = false;
	let value: T | undefined;
	let failure: unknown;
	void work.then(
		(resultValue) => {
			value = resultValue;
			settled = true;
		},
		(error) => {
			failure = error;
			settled = true;
		},
	);
	while (!settled) await result(store.get(["", ""]));
	if (failure !== undefined) throw failure;
	return value as T;
}
const result = <T>(request: IDBRequest<T>) =>
	new Promise<T>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(
				request.error ?? new Error("Vault-image IndexedDB request failed"),
			);
	});
const complete = (transaction: IDBTransaction) =>
	new Promise<void>((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () =>
			reject(
				transaction.error ??
					new Error("Vault-image IndexedDB transaction aborted"),
			);
		transaction.onerror = () =>
			reject(
				transaction.error ??
					new Error("Vault-image IndexedDB transaction failed"),
			);
	});
