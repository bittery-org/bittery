const DATABASE_NAME = "bittery_attachment_artifacts";
const DATABASE_VERSION = 1;
const METADATA_STORE = "artifacts";
const CHUNK_STORE = "chunks";
const ACCOUNT_INDEX = "by_account";

export type IndexedDbAttachmentArtifactOwner = ArtifactOwnerControl;

export interface IndexedDbAttachmentArtifactExecutorOptions {
	databaseName?: string;
	failAfterWrite?: number;
}

type PublicationState = "incomplete" | "verifying" | "published";

interface StoredArtifact extends IndexedDbAttachmentArtifactOwner {
	readonly publicationState: PublicationState;
	readonly durableChunkCount: number;
}

interface StoredChunk {
	readonly accountId: string;
	readonly artifactId: string;
	readonly chunkIndex: number;
	readonly chunkSha256: string;
	readonly bytes: ArrayBuffer;
}

export interface IndexedDbAttachmentArtifactChunk {
	readonly bytes: ArrayBuffer;
	readonly chunkSha256: string;
}

export class ConfigurableIndexedDbAttachmentArtifactExecutor {
	readonly #databaseName: string;
	#remainingWritesBeforeFailure: number | undefined;

	constructor(options: IndexedDbAttachmentArtifactExecutorOptions = {}) {
		this.#databaseName = options.databaseName ?? DATABASE_NAME;
		this.#remainingWritesBeforeFailure = options.failAfterWrite;
	}

	async invoke(
		requestJson: string,
		bytes?: Uint8Array,
	): Promise<{ controlResponseJson: string; bytes?: ArrayBuffer }> {
		const request = parseControlRequest(requestJson);
		let response: ArtifactControlResponse;
		let responseBytes: ArrayBuffer | undefined;
		switch (request.type) {
			case "writeChunk":
				if (!(bytes instanceof Uint8Array))
					throw new Error("Attachment artifact write is missing binary bytes");
				response = {
					type: "chunkWritten",
					result: await this.writeChunk(
						request.owner,
						request.chunkIndex,
						request.chunkSha256,
						bytes,
					),
				};
				break;
			case "beginPublish":
				response = {
					type: "publicationStarted",
					state: await this.beginPublish(request.owner),
				};
				break;
			case "readVerifyingChunk": {
				const chunk = await this.readVerifyingChunk(
					request.owner,
					request.chunkIndex,
				);
				response = { type: "chunkRead", chunkSha256: chunk.chunkSha256 };
				responseBytes = chunk.bytes;
				break;
			}
			case "finishPublish":
				response = {
					type: "publicationFinished",
					result: await this.finishPublish(request.owner),
				};
				break;
			case "readPublishedChunk": {
				const chunk = await this.readPublishedChunk(
					request.owner,
					request.chunkIndex,
				);
				response = { type: "chunkRead", chunkSha256: chunk.chunkSha256 };
				responseBytes = chunk.bytes;
				break;
			}
			case "deleteAccount":
				await this.deleteAccount(request.accountId);
				response = { type: "accountDeleted" };
				break;
			case "listArtifactIds":
				response = {
					type: "artifactIds",
					artifactIds: [...(await this.listArtifactIds(request.accountId))],
				};
				break;
			case "deleteArtifact":
				response = {
					type: "artifactDeleted",
					result: await this.deleteArtifact(
						request.accountId,
						request.artifactId,
					),
				};
		}
		if (!validateArtifactControlResponse(response))
			throw new Error("Attachment artifact control response is invalid");
		return {
			controlResponseJson: JSON.stringify(response),
			bytes: responseBytes,
		};
	}

	async writeChunk(
		owner: IndexedDbAttachmentArtifactOwner,
		chunkIndex: number,
		chunkSha256: string,
		bytes: Uint8Array,
	): Promise<"stored" | "alreadyStored"> {
		if (
			!Number.isInteger(chunkIndex) ||
			chunkIndex < 0 ||
			chunkIndex >= owner.chunkCount
		)
			throw new Error("Attachment artifact chunk index is out of range");
		const database = await openDatabase(this.#databaseName);
		const transaction = database.transaction(
			[METADATA_STORE, CHUNK_STORE],
			"readwrite",
		);
		const completed = transactionDone(transaction);
		try {
			const artifacts = transaction.objectStore(METADATA_STORE);
			const chunks = transaction.objectStore(CHUNK_STORE);
			const stored = await requestResult<StoredArtifact | undefined>(
				artifacts.get([owner.accountId, owner.artifactId]),
			);
			const metadata: StoredArtifact = stored ?? {
				...owner,
				publicationState: "incomplete",
				durableChunkCount: 0,
			};
			if (stored === undefined) {
				artifacts.add(metadata);
				this.#afterWrite();
			} else {
				assertSameOwner(stored, owner);
			}
			const existing = await requestResult<StoredChunk | undefined>(
				chunks.get([owner.accountId, owner.artifactId, chunkIndex]),
			);
			if (existing !== undefined) {
				if (
					existing.chunkSha256 !== chunkSha256 ||
					!equalBytes(existing.bytes, bytes)
				) {
					throw new Error(
						"Attachment artifact chunk conflicts with durable ciphertext",
					);
				}
				await completed;
				return "alreadyStored";
			}
			if (
				stored?.publicationState !== undefined &&
				stored.publicationState !== "incomplete"
			) {
				throw new Error(
					"Published Attachment artifact is missing a durable chunk",
				);
			}
			const durableBytes = bytes.buffer.slice(
				bytes.byteOffset,
				bytes.byteOffset + bytes.byteLength,
			);
			chunks.add({
				accountId: owner.accountId,
				artifactId: owner.artifactId,
				chunkIndex,
				chunkSha256,
				bytes: durableBytes,
			});
			this.#afterWrite();
			artifacts.put({
				...metadata,
				durableChunkCount: metadata.durableChunkCount + 1,
			});
			this.#afterWrite();
			await completed;
			return "stored";
		} catch (error) {
			abort(transaction);
			await completed.catch(() => undefined);
			throw error;
		} finally {
			database.close();
		}
	}

	async beginPublish(
		owner: IndexedDbAttachmentArtifactOwner,
	): Promise<"verifying" | "published"> {
		const database = await openDatabase(this.#databaseName);
		const transaction = database.transaction(METADATA_STORE, "readwrite");
		const completed = transactionDone(transaction);
		try {
			const store = transaction.objectStore(METADATA_STORE);
			const stored = await requiredArtifact(store, owner);
			if (stored.publicationState === "published") {
				await completed;
				return "published";
			}
			if (stored.publicationState === "incomplete") {
				if (stored.durableChunkCount !== owner.chunkCount) {
					throw new Error("Attachment artifact chunks are incomplete");
				}
				store.put({ ...stored, publicationState: "verifying" });
				this.#afterWrite();
			}
			await completed;
			return "verifying";
		} catch (error) {
			abort(transaction);
			await completed.catch(() => undefined);
			throw error;
		} finally {
			database.close();
		}
	}

	async readVerifyingChunk(
		owner: IndexedDbAttachmentArtifactOwner,
		chunkIndex: number,
	): Promise<IndexedDbAttachmentArtifactChunk> {
		return this.#readChunk(owner, chunkIndex, ["verifying", "published"]);
	}

	async finishPublish(
		owner: IndexedDbAttachmentArtifactOwner,
	): Promise<"published" | "alreadyPublished"> {
		const database = await openDatabase(this.#databaseName);
		const transaction = database.transaction(METADATA_STORE, "readwrite");
		const completed = transactionDone(transaction);
		try {
			const store = transaction.objectStore(METADATA_STORE);
			const stored = await requiredArtifact(store, owner);
			if (stored.publicationState === "published") {
				await completed;
				return "alreadyPublished";
			}
			if (stored.publicationState !== "verifying") {
				throw new Error("Attachment artifact is not ready to publish");
			}
			store.put({ ...stored, publicationState: "published" });
			this.#afterWrite();
			await completed;
			return "published";
		} catch (error) {
			abort(transaction);
			await completed.catch(() => undefined);
			throw error;
		} finally {
			database.close();
		}
	}

	async readPublishedChunk(
		owner: IndexedDbAttachmentArtifactOwner,
		chunkIndex: number,
	): Promise<IndexedDbAttachmentArtifactChunk> {
		return this.#readChunk(owner, chunkIndex, ["published"]);
	}

	async deleteAccount(accountId: string): Promise<void> {
		while ((await this.#deleteAccountStep(accountId)) !== "deleted") {
			// Each iteration commits at most one durable record deletion.
		}
	}

	async #deleteAccountStep(accountId: string): Promise<"progress" | "deleted"> {
		const database = await openDatabase(this.#databaseName);
		const transaction = database.transaction(
			[METADATA_STORE, CHUNK_STORE],
			"readwrite",
		);
		const completed = transactionDone(transaction);
		try {
			for (const storeName of [CHUNK_STORE, METADATA_STORE]) {
				const cursor = await requestResult(
					transaction
						.objectStore(storeName)
						.index(ACCOUNT_INDEX)
						.openCursor(IDBKeyRange.only(accountId)),
				);
				if (cursor !== null) {
					cursor.delete();
					this.#afterWrite();
					await completed;
					return "progress";
				}
			}
			await completed;
			return "deleted";
		} catch (error) {
			abort(transaction);
			await completed.catch(() => undefined);
			throw error;
		} finally {
			database.close();
		}
	}

	async listArtifactIds(accountId: string): Promise<readonly string[]> {
		const database = await openDatabase(this.#databaseName);
		try {
			const transaction = database.transaction(METADATA_STORE, "readonly");
			const records = await requestResult<StoredArtifact[]>(
				transaction
					.objectStore(METADATA_STORE)
					.index(ACCOUNT_INDEX)
					.getAll(IDBKeyRange.only(accountId)),
			);
			await transactionDone(transaction);
			return records.map(({ artifactId }) => artifactId).sort();
		} finally {
			database.close();
		}
	}

	async deleteArtifact(
		accountId: string,
		artifactId: string,
	): Promise<"progress" | "deleted" | "missing"> {
		const database = await openDatabase(this.#databaseName);
		const transaction = database.transaction(
			[METADATA_STORE, CHUNK_STORE],
			"readwrite",
		);
		const completed = transactionDone(transaction);
		try {
			const artifacts = transaction.objectStore(METADATA_STORE);
			const key = [accountId, artifactId];
			const existed =
				(await requestResult(artifacts.getKey(key))) !== undefined;
			if (!existed) {
				await completed;
				return "missing";
			}
			const chunk = await requestResult(
				transaction
					.objectStore(CHUNK_STORE)
					.index("by_artifact")
					.openCursor(IDBKeyRange.only(key)),
			);
			if (chunk !== null) {
				chunk.delete();
				this.#afterWrite();
				await completed;
				return "progress";
			}
			artifacts.delete(key);
			this.#afterWrite();
			await completed;
			return "deleted";
		} catch (error) {
			abort(transaction);
			await completed.catch(() => undefined);
			throw error;
		} finally {
			database.close();
		}
	}

	async readStoredChunkForTest(
		owner: IndexedDbAttachmentArtifactOwner,
		chunkIndex: number,
	): Promise<ArrayBuffer> {
		const database = await openDatabase(this.#databaseName);
		try {
			const transaction = database.transaction(CHUNK_STORE, "readonly");
			const chunk = await requestResult<StoredChunk | undefined>(
				transaction
					.objectStore(CHUNK_STORE)
					.get([owner.accountId, owner.artifactId, chunkIndex]),
			);
			await transactionDone(transaction);
			if (chunk === undefined)
				throw new Error("Attachment artifact chunk is missing");
			return chunk.bytes;
		} finally {
			database.close();
		}
	}

	#afterWrite(): void {
		if (this.#remainingWritesBeforeFailure === undefined) return;
		this.#remainingWritesBeforeFailure -= 1;
		if (this.#remainingWritesBeforeFailure === 0) {
			throw new Error("injected IndexedDB Attachment artifact write failure");
		}
	}

	async #readChunk(
		owner: IndexedDbAttachmentArtifactOwner,
		chunkIndex: number,
		allowedStates: readonly PublicationState[],
	): Promise<IndexedDbAttachmentArtifactChunk> {
		const database = await openDatabase(this.#databaseName);
		try {
			const transaction = database.transaction(
				[METADATA_STORE, CHUNK_STORE],
				"readonly",
			);
			const stored = await requiredArtifact(
				transaction.objectStore(METADATA_STORE),
				owner,
			);
			if (!allowedStates.includes(stored.publicationState)) {
				throw new Error(
					allowedStates.length === 1 && allowedStates[0] === "published"
						? "Attachment artifact is not published"
						: "Attachment artifact is not being published",
				);
			}
			const chunk = await requestResult<StoredChunk | undefined>(
				transaction
					.objectStore(CHUNK_STORE)
					.get([owner.accountId, owner.artifactId, chunkIndex]),
			);
			await transactionDone(transaction);
			if (chunk === undefined)
				throw new Error("Attachment artifact chunk is missing");
			return { bytes: chunk.bytes, chunkSha256: chunk.chunkSha256 };
		} finally {
			database.close();
		}
	}
}

function parseControlRequest(requestJson: string): ArtifactControlRequest {
	let value: unknown;
	try {
		value = JSON.parse(requestJson);
	} catch {
		throw new Error("Attachment artifact control request must be valid JSON");
	}
	if (!validateArtifactControlRequest(value))
		throw new Error("Attachment artifact control request is invalid");
	return value;
}

async function openDatabase(databaseName: string): Promise<IDBDatabase> {
	if (globalThis.indexedDB === undefined)
		throw new Error("IndexedDB is unavailable");
	const request = globalThis.indexedDB.open(databaseName, DATABASE_VERSION);
	request.onupgradeneeded = () => {
		const database = request.result;
		const artifacts = database.createObjectStore(METADATA_STORE, {
			keyPath: ["accountId", "artifactId"],
		});
		artifacts.createIndex(ACCOUNT_INDEX, "accountId");
		const chunks = database.createObjectStore(CHUNK_STORE, {
			keyPath: ["accountId", "artifactId", "chunkIndex"],
		});
		chunks.createIndex(ACCOUNT_INDEX, "accountId");
		chunks.createIndex("by_artifact", ["accountId", "artifactId"]);
	};
	return requestResult(request);
}

async function requiredArtifact(
	store: IDBObjectStore,
	owner: IndexedDbAttachmentArtifactOwner,
): Promise<StoredArtifact> {
	const stored = await requestResult<StoredArtifact | undefined>(
		store.get([owner.accountId, owner.artifactId]),
	);
	if (stored === undefined)
		throw new Error("Attachment artifact is not available");
	assertSameOwner(stored, owner);
	return stored;
}

function assertSameOwner(
	stored: StoredArtifact,
	owner: IndexedDbAttachmentArtifactOwner,
): void {
	if (
		!Number.isInteger(stored.durableChunkCount) ||
		stored.durableChunkCount < 0 ||
		stored.durableChunkCount > owner.chunkCount
	)
		throw new Error("Attachment artifact durable chunk count is invalid");
	for (const key of [
		"accountId",
		"artifactId",
		"operationId",
		"attachmentId",
		"ciphertextSha256",
		"byteLength",
		"chunkCount",
	] as const) {
		if (stored[key] !== owner[key]) {
			throw new Error(
				"Attachment artifact durable ownership conflicts with its canonical reference",
			);
		}
	}
}

function equalBytes(stored: ArrayBuffer, expected: Uint8Array): boolean {
	const actual = new Uint8Array(stored);
	if (actual.byteLength !== expected.byteLength) return false;
	return actual.every((value, index) => value === expected[index]);
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
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
	} catch {
		// It already completed or aborted.
	}
}

import type {
	ArtifactControlRequest,
	ArtifactControlResponse,
	ArtifactOwnerControl,
} from "../generated/artifact-control/contract.ts";
import {
	validateArtifactControlRequest,
	validateArtifactControlResponse,
} from "../generated/artifact-control/validator.js";
