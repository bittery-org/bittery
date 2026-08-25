const DATABASE_NAME = "bittery_attachment_artifacts";
const DATABASE_VERSION = 2;
const METADATA_STORE = "artifacts";
const CHUNK_STORE = "chunks";
const PROVISIONAL_METADATA_STORE = "provisional_artifacts";
const PROVISIONAL_CHUNK_STORE = "provisional_chunks";
const ACCOUNT_INDEX = "by_account";
const SCOPE_INDEX = "by_scope";

export type IndexedDbAttachmentArtifactOwner = ArtifactOwnerControl;

export interface IndexedDbAttachmentArtifactExecutorOptions {
	databaseName?: string;
	failAfterWrite?: number;
}

type PublicationState = "incomplete" | "verifying" | "published";

interface StoredArtifact extends IndexedDbAttachmentArtifactOwner {
	readonly publicationState: PublicationState;
	readonly durableChunkCount: number;
	readonly physicalGeneration?: string;
}

type ProvisionalToken = ProvisionalArtifactTokenControl;

interface StoredProvisionalArtifact extends ProvisionalToken {
	readonly current: boolean;
	readonly publicationState: 0 | 1 | 2;
	readonly durableChunkCount: number;
	readonly durableByteLength: number;
	readonly minimumChunkIndex?: number;
	readonly maximumChunkIndex?: number;
	readonly artifactId?: string;
	readonly ciphertextSha256?: string;
	readonly byteLength?: string;
	readonly chunkCount?: number;
}

interface StoredProvisionalChunk {
	readonly accountId: string;
	readonly operationId: string;
	readonly attachmentId: string;
	readonly generation: string;
	readonly chunkIndex: number;
	readonly chunkSha256: string;
	readonly bytes: ArrayBuffer;
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
			case "beginProvisional": {
				const recovery = await this.beginProvisional(request.writer);
				response =
					recovery === undefined
						? { type: "provisionalBegun" }
						: { type: "provisionalRecoveryAvailable", recovery };
				break;
			}
			case "writeProvisionalChunk":
				if (!(bytes instanceof Uint8Array))
					throw new Error(
						"Provisional Attachment artifact write is missing binary bytes",
					);
				response = {
					type: "chunkWritten",
					result: await this.writeProvisionalChunk(
						request.writer,
						request.chunkIndex,
						request.chunkSha256,
						bytes,
					),
				};
				break;
			case "sealProvisional":
				response = {
					type: "provisionalBinding",
					...(await this.sealProvisional(request.writer, request.owner)),
				};
				break;
			case "readSealedProvisionalChunk": {
				const chunk = await this.readSealedProvisionalChunk(
					request.token,
					request.owner,
					request.chunkIndex,
				);
				response = { type: "chunkRead", chunkSha256: chunk.chunkSha256 };
				responseBytes = chunk.bytes;
				break;
			}
			case "finishProvisional":
				await this.finishProvisional(request.token, request.owner);
				response = { type: "provisionalFinished" };
				break;
			case "recoverProvisional":
				response = {
					type: "provisionalRecoveryAvailable",
					recovery: await this.recoverProvisional(request.scope),
				};
				break;
			case "resumeRecoveredProvisional":
				response = {
					type: "provisionalBinding",
					...(await this.resumeProvisional(request.recovery)),
				};
				break;
			case "resumeProvisionalFinalization":
				response = {
					type: "provisionalBinding",
					...(await this.resumeProvisional(request.writer)),
				};
				break;
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
				{
					response = {
						type: "artifactIds",
						artifactIds: [...(await this.listArtifactIds(request.accountId))],
						provisional: [
							...(await this.listProvisionalTokens(request.accountId)),
						],
					};
				}
				break;
			case "deleteArtifact":
				response = {
					type: "artifactDeleted",
					result: await this.deleteArtifact(
						request.accountId,
						request.artifactId,
					),
				};
				break;
			case "deleteProvisionalGeneration":
				response = {
					type: "artifactDeleted",
					result: await this.deleteProvisionalGeneration(request.token),
				};
		}
		if (!validateArtifactControlResponse(response))
			throw new Error("Attachment artifact control response is invalid");
		return {
			controlResponseJson: JSON.stringify(response),
			bytes: responseBytes,
		};
	}

	async beginProvisional(
		writer: ProvisionalToken,
	): Promise<ProvisionalToken | undefined> {
		assertCanonicalToken(writer);
		const database = await openDatabase(this.#databaseName);
		const transaction = database.transaction(
			PROVISIONAL_METADATA_STORE,
			"readwrite",
		);
		const completed = transactionDone(transaction);
		try {
			const store = transaction.objectStore(PROVISIONAL_METADATA_STORE);
			const existing = await requestResult<StoredProvisionalArtifact[]>(
				store.index(SCOPE_INDEX).getAll(IDBKeyRange.only(scopeKey(writer))),
			);
			const current = existing.filter(({ current }) => current);
			if (current.length > 1)
				throw new Error(
					"Provisional Attachment artifact has multiple current generations",
				);
			const exact = current.find(
				({ generation }) => generation === writer.generation,
			);
			if (
				exact?.publicationState !== undefined &&
				exact.publicationState !== 0
			) {
				await completed;
				return tokenOf(exact);
			}
			const sealed = current.find(
				({ publicationState }) => publicationState === 1,
			);
			if (sealed !== undefined) {
				await completed;
				return tokenOf(sealed);
			}
			if (exact === undefined) {
				for (const previous of current)
					store.put({ ...previous, current: false });
				store.add({
					...writer,
					current: true,
					publicationState: 0,
					durableChunkCount: 0,
					durableByteLength: 0,
					minimumChunkIndex: undefined,
					maximumChunkIndex: undefined,
				} satisfies StoredProvisionalArtifact);
				this.#afterWrite();
			}
			await completed;
			return undefined;
		} catch (error) {
			abort(transaction);
			await completed.catch(() => undefined);
			throw error;
		} finally {
			database.close();
		}
	}

	async writeProvisionalChunk(
		writer: ProvisionalToken,
		chunkIndex: number,
		chunkSha256: string,
		bytes: Uint8Array,
	): Promise<"stored" | "alreadyStored"> {
		assertCanonicalToken(writer);
		if (!isUint32(chunkIndex))
			throw new Error("Provisional chunk index is out of range");
		if (bytes.byteLength === 0 || bytes.byteLength > 256 * 1024)
			throw new Error("Provisional chunk length is invalid");
		const database = await openDatabase(this.#databaseName);
		const transaction = database.transaction(
			[PROVISIONAL_METADATA_STORE, PROVISIONAL_CHUNK_STORE],
			"readwrite",
		);
		const completed = transactionDone(transaction);
		try {
			const metadataStore = transaction.objectStore(PROVISIONAL_METADATA_STORE);
			const stored = await requiredCurrentProvisional(metadataStore, writer);
			if (stored.publicationState !== 0)
				throw new Error(
					"Provisional Attachment artifact writer is no longer writable",
				);
			const chunks = transaction.objectStore(PROVISIONAL_CHUNK_STORE);
			const key = [...tokenKey(writer), chunkIndex];
			const existing = await requestResult<StoredProvisionalChunk | undefined>(
				chunks.get(key),
			);
			if (existing !== undefined) {
				if (
					existing.chunkSha256 !== chunkSha256 ||
					!equalBytes(existing.bytes, bytes)
				)
					throw new Error(
						"Provisional Attachment artifact chunk conflicts with durable ciphertext",
					);
				await completed;
				return "alreadyStored";
			}
			const durableBytes = bytes.buffer.slice(
				bytes.byteOffset,
				bytes.byteOffset + bytes.byteLength,
			);
			chunks.add({ ...writer, chunkIndex, chunkSha256, bytes: durableBytes });
			this.#afterWrite();
			metadataStore.put({
				...stored,
				durableChunkCount: stored.durableChunkCount + 1,
				durableByteLength: stored.durableByteLength + bytes.byteLength,
				minimumChunkIndex:
					stored.minimumChunkIndex === undefined
						? chunkIndex
						: Math.min(stored.minimumChunkIndex, chunkIndex),
				maximumChunkIndex:
					stored.maximumChunkIndex === undefined
						? chunkIndex
						: Math.max(stored.maximumChunkIndex, chunkIndex),
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

	async sealProvisional(
		writer: ProvisionalToken,
		owner: IndexedDbAttachmentArtifactOwner,
	): Promise<{
		owner: IndexedDbAttachmentArtifactOwner;
		state: "sealed" | "published";
	}> {
		assertTokenOwns(writer, owner);
		const database = await openDatabase(this.#databaseName);
		const transaction = database.transaction(
			PROVISIONAL_METADATA_STORE,
			"readwrite",
		);
		const completed = transactionDone(transaction);
		try {
			const store = transaction.objectStore(PROVISIONAL_METADATA_STORE);
			const stored = await requiredCurrentProvisional(store, writer);
			if (stored.publicationState !== 0) {
				const binding = ownerFromProvisional(stored);
				assertOwnerIdentity(binding, owner);
				await completed;
				return {
					owner: binding,
					state: stored.publicationState === 2 ? "published" : "sealed",
				};
			}
			if (
				stored.durableChunkCount !== owner.chunkCount ||
				stored.minimumChunkIndex !== 0 ||
				stored.maximumChunkIndex !== owner.chunkCount - 1 ||
				stored.durableByteLength !== decimalLength(owner.byteLength)
			)
				throw new Error(
					"Provisional Attachment artifact chunks are incomplete",
				);
			store.put({
				...stored,
				publicationState: 1,
				artifactId: owner.artifactId,
				ciphertextSha256: owner.ciphertextSha256,
				byteLength: owner.byteLength,
				chunkCount: owner.chunkCount,
			});
			this.#afterWrite();
			await completed;
			return { owner, state: "sealed" };
		} catch (error) {
			abort(transaction);
			await completed.catch(() => undefined);
			throw error;
		} finally {
			database.close();
		}
	}

	async readSealedProvisionalChunk(
		token: ProvisionalToken,
		owner: IndexedDbAttachmentArtifactOwner,
		chunkIndex: number,
	): Promise<IndexedDbAttachmentArtifactChunk> {
		assertTokenOwns(token, owner);
		if (!isUint32(chunkIndex) || chunkIndex >= owner.chunkCount)
			throw new Error("Provisional chunk index is out of range");
		const database = await openDatabase(this.#databaseName);
		try {
			const transaction = database.transaction(
				[PROVISIONAL_METADATA_STORE, PROVISIONAL_CHUNK_STORE],
				"readonly",
			);
			const stored = await requiredProvisional(
				transaction.objectStore(PROVISIONAL_METADATA_STORE),
				token,
			);
			if (stored.publicationState === 0)
				throw new Error("Provisional Attachment artifact is not sealed");
			assertOwnerIdentity(ownerFromProvisional(stored), owner);
			const chunk = await requestResult<StoredProvisionalChunk | undefined>(
				transaction
					.objectStore(PROVISIONAL_CHUNK_STORE)
					.get([...tokenKey(token), chunkIndex]),
			);
			await transactionDone(transaction);
			if (chunk === undefined)
				throw new Error("Provisional Attachment artifact chunk is missing");
			return { bytes: chunk.bytes, chunkSha256: chunk.chunkSha256 };
		} finally {
			database.close();
		}
	}

	async finishProvisional(
		token: ProvisionalToken,
		owner: IndexedDbAttachmentArtifactOwner,
	): Promise<void> {
		assertTokenOwns(token, owner);
		const database = await openDatabase(this.#databaseName);
		const transaction = database.transaction(
			[METADATA_STORE, PROVISIONAL_METADATA_STORE],
			"readwrite",
		);
		const completed = transactionDone(transaction);
		try {
			const provisionalStore = transaction.objectStore(
				PROVISIONAL_METADATA_STORE,
			);
			const stored = await requiredProvisional(provisionalStore, token);
			if (stored.publicationState === 0)
				throw new Error("Provisional Attachment artifact is not sealed");
			assertOwnerIdentity(ownerFromProvisional(stored), owner);
			const artifacts = transaction.objectStore(METADATA_STORE);
			const existing = await requestResult<StoredArtifact | undefined>(
				artifacts.get([owner.accountId, owner.artifactId]),
			);
			if (existing !== undefined) {
				assertSameOwner(existing, owner);
				if (existing.physicalGeneration !== token.generation)
					throw new Error(
						"Attachment artifact is mapped to a different generation",
					);
			} else {
				artifacts.add({
					...owner,
					publicationState: "published",
					durableChunkCount: owner.chunkCount,
					physicalGeneration: token.generation,
				});
				this.#afterWrite();
			}
			if (stored.publicationState !== 2) {
				provisionalStore.put({ ...stored, publicationState: 2 });
				this.#afterWrite();
			}
			await completed;
		} catch (error) {
			abort(transaction);
			await completed.catch(() => undefined);
			throw error;
		} finally {
			database.close();
		}
	}

	async recoverProvisional(
		scope: ProvisionalArtifactScopeControl,
	): Promise<ProvisionalToken> {
		const database = await openDatabase(this.#databaseName);
		try {
			const transaction = database.transaction(
				PROVISIONAL_METADATA_STORE,
				"readonly",
			);
			const records = await requestResult<StoredProvisionalArtifact[]>(
				transaction
					.objectStore(PROVISIONAL_METADATA_STORE)
					.index(SCOPE_INDEX)
					.getAll(IDBKeyRange.only(scopeKey(scope))),
			);
			await transactionDone(transaction);
			const authenticated = records.find(
				({ publicationState, current }) => current && publicationState !== 0,
			);
			if (authenticated === undefined)
				throw new Error(
					"No authenticated provisional generation is available to recover",
				);
			return tokenOf(authenticated);
		} finally {
			database.close();
		}
	}

	async resumeProvisional(token: ProvisionalToken): Promise<{
		owner: IndexedDbAttachmentArtifactOwner;
		state: "sealed" | "published";
	}> {
		assertCanonicalToken(token);
		const database = await openDatabase(this.#databaseName);
		try {
			const transaction = database.transaction(
				[METADATA_STORE, PROVISIONAL_METADATA_STORE],
				"readonly",
			);
			const stored = await requestResult<StoredProvisionalArtifact | undefined>(
				transaction
					.objectStore(PROVISIONAL_METADATA_STORE)
					.get(tokenKey(token)),
			);
			if (stored !== undefined && stored.publicationState !== 0) {
				const owner = ownerFromProvisional(stored);
				if (stored.publicationState === 2) {
					const mapped = await requiredArtifact(
						transaction.objectStore(METADATA_STORE),
						owner,
					);
					if (mapped.physicalGeneration !== token.generation)
						throw new Error(
							"Completed Attachment artifact publication conflicts with its writer generation",
						);
				}
				await transactionDone(transaction);
				return {
					owner,
					state: stored.publicationState === 2 ? "published" : "sealed",
				};
			}
			const mapped = await requestResult<IDBCursorWithValue | null>(
				transaction
					.objectStore(METADATA_STORE)
					.index(ACCOUNT_INDEX)
					.openCursor(IDBKeyRange.only(token.accountId)),
			).then(async (cursor) => {
				let current = cursor;
				while (current !== null) {
					const value = current.value as StoredArtifact;
					if (
						value.physicalGeneration === token.generation &&
						value.operationId === token.operationId &&
						value.attachmentId === token.attachmentId
					)
						return value;
					current = await continueCursor(current);
				}
				return undefined;
			});
			await transactionDone(transaction);
			if (mapped === undefined)
				throw new Error(
					"No matching authenticated provisional generation is available to recover",
				);
			return { owner: mapped, state: "published" };
		} finally {
			database.close();
		}
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
			[
				METADATA_STORE,
				CHUNK_STORE,
				PROVISIONAL_METADATA_STORE,
				PROVISIONAL_CHUNK_STORE,
			],
			"readwrite",
		);
		const completed = transactionDone(transaction);
		try {
			for (const storeName of [
				CHUNK_STORE,
				PROVISIONAL_CHUNK_STORE,
				METADATA_STORE,
				PROVISIONAL_METADATA_STORE,
			]) {
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

	async listProvisionalTokens(
		accountId: string,
	): Promise<readonly ProvisionalToken[]> {
		const database = await openDatabase(this.#databaseName);
		try {
			const transaction = database.transaction(
				[METADATA_STORE, PROVISIONAL_METADATA_STORE],
				"readonly",
			);
			const records = await requestResult<StoredProvisionalArtifact[]>(
				transaction
					.objectStore(PROVISIONAL_METADATA_STORE)
					.index(ACCOUNT_INDEX)
					.getAll(IDBKeyRange.only(accountId)),
			);
			const artifacts = await requestResult<StoredArtifact[]>(
				transaction
					.objectStore(METADATA_STORE)
					.index(ACCOUNT_INDEX)
					.getAll(IDBKeyRange.only(accountId)),
			);
			await transactionDone(transaction);
			const mapped = new Set(
				artifacts.flatMap(
					({ operationId, attachmentId, physicalGeneration }) =>
						physicalGeneration === undefined
							? []
							: [
									physicalGenerationKey(
										operationId,
										attachmentId,
										physicalGeneration,
									),
								],
				),
			);
			return records
				.filter(
					({ operationId, attachmentId, generation }) =>
						!mapped.has(
							physicalGenerationKey(operationId, attachmentId, generation),
						),
				)
				.map(tokenOf);
		} finally {
			database.close();
		}
	}

	async deleteProvisionalGeneration(
		token: ProvisionalToken,
	): Promise<"progress" | "deleted" | "missing"> {
		assertCanonicalToken(token);
		const database = await openDatabase(this.#databaseName);
		const transaction = database.transaction(
			[METADATA_STORE, PROVISIONAL_METADATA_STORE, PROVISIONAL_CHUNK_STORE],
			"readwrite",
		);
		const completed = transactionDone(transaction);
		try {
			const mappedCursor = await requestResult<IDBCursorWithValue | null>(
				transaction
					.objectStore(METADATA_STORE)
					.index(ACCOUNT_INDEX)
					.openCursor(IDBKeyRange.only(token.accountId)),
			);
			let mapped = mappedCursor;
			while (mapped !== null) {
				const artifact = mapped.value as StoredArtifact;
				if (
					artifact.operationId === token.operationId &&
					artifact.attachmentId === token.attachmentId &&
					artifact.physicalGeneration === token.generation
				) {
					await completed;
					throw new Error(
						"Live mapped Attachment artifact generation cannot be deleted",
					);
				}
				mapped = await continueCursor(mapped);
			}
			const metadata = transaction.objectStore(PROVISIONAL_METADATA_STORE);
			const existed =
				(await requestResult(metadata.getKey(tokenKey(token)))) !== undefined;
			if (!existed) {
				await completed;
				return "missing";
			}
			const chunk = await requestResult(
				transaction
					.objectStore(PROVISIONAL_CHUNK_STORE)
					.index("by_generation")
					.openCursor(IDBKeyRange.only(tokenKey(token))),
			);
			if (chunk !== null) {
				chunk.delete();
				this.#afterWrite();
				await completed;
				return "progress";
			}
			metadata.delete(tokenKey(token));
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
				[METADATA_STORE, CHUNK_STORE, PROVISIONAL_CHUNK_STORE],
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
			const chunk =
				stored.physicalGeneration === undefined
					? await requestResult<StoredChunk | undefined>(
							transaction
								.objectStore(CHUNK_STORE)
								.get([owner.accountId, owner.artifactId, chunkIndex]),
						)
					: await requestResult<StoredProvisionalChunk | undefined>(
							transaction
								.objectStore(PROVISIONAL_CHUNK_STORE)
								.get([
									owner.accountId,
									owner.operationId,
									owner.attachmentId,
									stored.physicalGeneration,
									chunkIndex,
								]),
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
		if (!database.objectStoreNames.contains(METADATA_STORE)) {
			const artifacts = database.createObjectStore(METADATA_STORE, {
				keyPath: ["accountId", "artifactId"],
			});
			artifacts.createIndex(ACCOUNT_INDEX, "accountId");
		}
		if (!database.objectStoreNames.contains(CHUNK_STORE)) {
			const chunks = database.createObjectStore(CHUNK_STORE, {
				keyPath: ["accountId", "artifactId", "chunkIndex"],
			});
			chunks.createIndex(ACCOUNT_INDEX, "accountId");
			chunks.createIndex("by_artifact", ["accountId", "artifactId"]);
		}
		if (!database.objectStoreNames.contains(PROVISIONAL_METADATA_STORE)) {
			const provisional = database.createObjectStore(
				PROVISIONAL_METADATA_STORE,
				{ keyPath: ["accountId", "operationId", "attachmentId", "generation"] },
			);
			provisional.createIndex(ACCOUNT_INDEX, "accountId");
			provisional.createIndex(SCOPE_INDEX, [
				"accountId",
				"operationId",
				"attachmentId",
			]);
		}
		if (!database.objectStoreNames.contains(PROVISIONAL_CHUNK_STORE)) {
			const chunks = database.createObjectStore(PROVISIONAL_CHUNK_STORE, {
				keyPath: [
					"accountId",
					"operationId",
					"attachmentId",
					"generation",
					"chunkIndex",
				],
			});
			chunks.createIndex(ACCOUNT_INDEX, "accountId");
			chunks.createIndex("by_generation", [
				"accountId",
				"operationId",
				"attachmentId",
				"generation",
			]);
		}
	};
	return requestResult(request);
}

function tokenKey(token: ProvisionalToken): string[] {
	return [
		token.accountId,
		token.operationId,
		token.attachmentId,
		token.generation,
	];
}

function scopeKey(scope: ProvisionalArtifactScopeControl): string[] {
	return [scope.accountId, scope.operationId, scope.attachmentId];
}

function physicalGenerationKey(
	operationId: string,
	attachmentId: string,
	generation: string,
): string {
	return `${operationId}\0${attachmentId}\0${generation}`;
}

function tokenOf(value: ProvisionalToken): ProvisionalToken {
	return {
		accountId: value.accountId,
		operationId: value.operationId,
		attachmentId: value.attachmentId,
		generation: value.generation,
	};
}

function isUint32(value: number): boolean {
	return Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

function assertCanonicalToken(token: ProvisionalToken): void {
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
			token.generation,
		)
	)
		throw new Error("Provisional Attachment artifact generation is invalid");
	if (
		[token.accountId, token.operationId, token.attachmentId].some(
			(value) => value.length === 0 || value.includes("\0"),
		)
	)
		throw new Error("Provisional Attachment artifact scope is invalid");
}

function assertTokenOwns(
	token: ProvisionalToken,
	owner: IndexedDbAttachmentArtifactOwner,
): void {
	assertCanonicalToken(token);
	if (
		token.accountId !== owner.accountId ||
		token.operationId !== owner.operationId ||
		token.attachmentId !== owner.attachmentId
	)
		throw new Error("Provisional Attachment artifact has the wrong scope");
}

function decimalLength(value: string): number {
	if (!/^(0|[1-9][0-9]*)$/.test(value))
		throw new Error("Attachment artifact byte length is invalid");
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0)
		throw new Error("Attachment artifact byte length is invalid");
	return parsed;
}

async function requiredProvisional(
	store: IDBObjectStore,
	token: ProvisionalToken,
): Promise<StoredProvisionalArtifact> {
	const stored = await requestResult<StoredProvisionalArtifact | undefined>(
		store.get(tokenKey(token)),
	);
	if (stored === undefined)
		throw new Error("Provisional Attachment artifact writer is stale");
	return stored;
}

async function requiredCurrentProvisional(
	store: IDBObjectStore,
	token: ProvisionalToken,
): Promise<StoredProvisionalArtifact> {
	const stored = await requiredProvisional(store, token);
	if (!stored.current)
		throw new Error("Provisional Attachment artifact writer is stale");
	return stored;
}

function ownerFromProvisional(
	stored: StoredProvisionalArtifact,
): IndexedDbAttachmentArtifactOwner {
	if (
		stored.publicationState === 0 ||
		stored.ciphertextSha256 === undefined ||
		stored.byteLength === undefined ||
		stored.chunkCount === undefined
	)
		throw new Error("Provisional Attachment artifact is not authenticated");
	return {
		accountId: stored.accountId,
		operationId: stored.operationId,
		attachmentId: stored.attachmentId,
		artifactId: canonicalArtifactId(stored),
		ciphertextSha256: stored.ciphertextSha256,
		byteLength: stored.byteLength,
		chunkCount: stored.chunkCount,
	};
}

function canonicalArtifactId(stored: StoredProvisionalArtifact): string {
	// Rust validates this derived identity before accepting any host response. The browser stores
	// the canonical id supplied at the authenticated seal so it need not duplicate Rust hashing.
	const artifactId = stored.artifactId;
	if (artifactId === undefined)
		throw new Error("Provisional Attachment artifact binding is incomplete");
	return artifactId;
}

function continueCursor(
	cursor: IDBCursorWithValue,
): Promise<IDBCursorWithValue | null> {
	return new Promise((resolve, reject) => {
		const request = cursor.request;
		request.onsuccess = () =>
			resolve(request.result as IDBCursorWithValue | null);
		request.onerror = () =>
			reject(request.error ?? new Error("IndexedDB cursor failed"));
		cursor.continue();
	});
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

function assertOwnerIdentity(
	stored: IndexedDbAttachmentArtifactOwner,
	owner: IndexedDbAttachmentArtifactOwner,
): void {
	for (const key of [
		"accountId",
		"artifactId",
		"operationId",
		"attachmentId",
		"ciphertextSha256",
		"byteLength",
		"chunkCount",
	] as const) {
		if (stored[key] !== owner[key])
			throw new Error(
				"Attachment artifact durable ownership conflicts with its canonical reference",
			);
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
	ProvisionalArtifactScopeControl,
	ProvisionalArtifactTokenControl,
} from "../generated/artifact-control/contract.ts";
import {
	validateArtifactControlRequest,
	validateArtifactControlResponse,
} from "../generated/artifact-control/validator.js";
