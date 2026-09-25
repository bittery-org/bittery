import { IndexedDbVaultImageArtifactExecutor } from "../src/indexeddb-vault-image-artifact-executor";
import { protectedImageStorageFixture } from "./protected-image-storage-fixture";

const executor = new IndexedDbVaultImageArtifactExecutor({
	databaseName: "vault-image-actual-chromium",
});
Object.assign(globalThis, {
	async runProtectedImageStorageHistory() {
		const name = "vault-image-protected-browser";
		const scope = {
			accountId: "protected-account",
			operationId: "protected-operation",
		};
		const metadata = {
			...scope,
			vaultId: "vault-a",
			byteLength: "3",
			contentType: "image/png",
			sha256:
				"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		};
		const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open(name, 2);
			request.onupgradeneeded = () => {
				const artifacts = request.result.createObjectStore("artifacts", {
					keyPath: ["accountId", "operationId"],
				});
				artifacts.createIndex("by_account", "accountId");
				const chunks = request.result.createObjectStore("chunks", {
					keyPath: ["accountId", "operationId", "chunkIndex"],
				});
				chunks.createIndex("by_account", "accountId");
				chunks.createIndex("by_scope", ["accountId", "operationId"]);
				artifacts.add({ ...metadata, published: true });
				chunks.add({
					...scope,
					chunkIndex: 0,
					bytes: new Uint8Array([97, 98, 99]),
				});
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		legacy.close();
		const { ciphertext, protectedScope, protectedMetadata } =
			await protectedImageStorageFixture(scope, metadata);
		const first = new IndexedDbVaultImageArtifactExecutor({
			databaseName: name,
		});
		const raw = (await first.invoke({
			type: "readChunk",
			metadata,
			chunkIndex: 0,
		})) as { bytes: Uint8Array };
		await first.invoke({ type: "begin", scope: protectedScope });
		const transferred = ciphertext.slice();
		await first.invoke(
			{ type: "writeChunk", scope: protectedScope, chunkIndex: 0 },
			transferred,
		);
		await first.invoke({ type: "publish", metadata: protectedMetadata });
		await first.close();
		const second = new IndexedDbVaultImageArtifactExecutor({
			databaseName: name,
		});
		const protectedRead = (await second.invoke({
			type: "readChunk",
			metadata: protectedMetadata,
			chunkIndex: 0,
		})) as { bytes: Uint8Array };
		const rawAgain = (await second.invoke({
			type: "readChunk",
			metadata,
			chunkIndex: 0,
		})) as { bytes: Uint8Array };
		const firstGeneration = await second.invoke({
			type: "readGeneration",
			scope,
		});
		const nextGeneration = await second.invoke({
			type: "readGeneration",
			scope,
			afterPublicationId: "",
		});
		await second.invoke({ type: "deleteGeneration", scope });
		const erasedRaw = await second.invoke({
			type: "readChunk",
			metadata,
			chunkIndex: 0,
		});
		const preservedProtected = (await second.invoke({
			type: "readChunk",
			metadata: protectedMetadata,
			chunkIndex: 0,
		})) as { bytes: Uint8Array };
		await second.invoke({ type: "delete", scope });
		const missingRaw = await second.invoke({
			type: "readChunk",
			metadata,
			chunkIndex: 0,
		});
		const missingProtected = await second.invoke({
			type: "readChunk",
			metadata: protectedMetadata,
			chunkIndex: 0,
		});
		await second.close();
		return {
			raw: Array.from(raw.bytes),
			rawAgain: Array.from(rawAgain.bytes),
			ciphertext: Array.from(protectedRead.bytes),
			wiped: Array.from(transferred),
			firstGenerationIsRaw:
				firstGeneration.type === "generation" &&
				!firstGeneration.generation.scope.publicationId,
			nextGenerationIsProtected:
				nextGeneration.type === "generation" &&
				nextGeneration.generation.scope.publicationId ===
					protectedScope.publicationId,
			erasedRaw,
			preservedProtected: Array.from(preservedProtected.bytes),
			missingRaw,
			missingProtected,
		};
	},

	async runVaultImageArtifactHistory() {
		const scope = { accountId: "account-a", operationId: "operation-a" };
		const metadata = {
			...scope,
			vaultId: "vault-a",
			byteLength: "3",
			contentType: "image/png",
			sha256:
				"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		};
		const transferred = new Uint8Array([97, 98, 99]);
		const responses = [];
		responses.push(await executor.invoke({ type: "begin", scope }));
		responses.push(
			await executor.invoke(
				{ type: "writeChunk", scope, chunkIndex: 0 },
				transferred,
			),
		);
		responses.push({ wipedTransferred: Array.from(transferred) });
		responses.push(await executor.invoke({ type: "publish", metadata }));
		const read = (await executor.invoke({
			type: "readChunk",
			metadata,
			chunkIndex: 0,
		})) as { type: string; bytes?: Uint8Array };
		responses.push({ type: read.type, bytes: Array.from(read.bytes ?? []) });
		responses.push(
			await executor.invoke({
				type: "startupSweep",
				accountId: "account-a",
				referencedOperationIds: [],
			}),
		);
		responses.push(
			await executor.invoke({ type: "readChunk", metadata, chunkIndex: 0 }),
		);
		return responses;
	},
	async runVaultImageArtifactAdversarialHistory() {
		const scope = { accountId: "account-race", operationId: "operation-race" };
		const metadata = {
			...scope,
			vaultId: "vault-race",
			byteLength: "3",
			contentType: "image/png",
			sha256:
				"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		};
		const first = new IndexedDbVaultImageArtifactExecutor({
			databaseName: "vault-image-actual-race",
		});
		const second = new IndexedDbVaultImageArtifactExecutor({
			databaseName: "vault-image-actual-race",
		});
		await first.invoke({ type: "begin", scope });
		await first.invoke(
			{ type: "writeChunk", scope, chunkIndex: 0 },
			new Uint8Array([97, 98, 99]),
		);
		let conflict = false;
		try {
			await second.invoke(
				{ type: "writeChunk", scope, chunkIndex: 0 },
				new Uint8Array([97, 98, 100]),
			);
		} catch {
			conflict = true;
		}
		let digestRejected = false;
		try {
			await second.invoke({
				type: "publish",
				metadata: { ...metadata, sha256: "0".repeat(64) },
			});
		} catch {
			digestRejected = true;
		}
		const publications = await Promise.allSettled([
			first.invoke({ type: "publish", metadata }),
			second.invoke({
				type: "publish",
				metadata: { ...metadata, vaultId: "vault-conflict" },
			}),
		]);
		const rollbackName = "vault-image-actual-rollback";
		const rollbackScope = {
			accountId: "account-rollback",
			operationId: "operation-rollback",
		};
		await new IndexedDbVaultImageArtifactExecutor({
			databaseName: rollbackName,
		}).invoke({ type: "begin", scope: rollbackScope });
		let rolledBack = false;
		try {
			await new IndexedDbVaultImageArtifactExecutor({
				databaseName: rollbackName,
				failure: { operation: "write", boundary: 2 },
			}).invoke(
				{ type: "writeChunk", scope: rollbackScope, chunkIndex: 0 },
				new Uint8Array([1]),
			);
		} catch {
			rolledBack = true;
		}
		const replay = await new IndexedDbVaultImageArtifactExecutor({
			databaseName: rollbackName,
		}).invoke(
			{ type: "writeChunk", scope: rollbackScope, chunkIndex: 0 },
			new Uint8Array([1]),
		);
		return {
			conflict,
			digestRejected,
			publicationStates: publications.map(({ status }) => status),
			rolledBack,
			replay,
		};
	},
	async runVaultImageHeldDigestHistory() {
		const databaseName = "vault-image-actual-held-digest";
		const scope = {
			accountId: "account-held",
			operationId: "operation-held",
		};
		const metadata = {
			...scope,
			vaultId: "vault-held",
			byteLength: "3",
			contentType: "image/png",
			sha256:
				"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		};
		let digestEntered!: () => void;
		const entered = new Promise<void>((resolve) => {
			digestEntered = resolve;
		});
		let releaseDigest!: () => void;
		const held = new Promise<void>((resolve) => {
			releaseDigest = resolve;
		});
		const publisher = new IndexedDbVaultImageArtifactExecutor({
			databaseName,
			digest: async (bytes) => {
				digestEntered();
				await held;
				return crypto.subtle.digest("SHA-256", bytes);
			},
		});
		const racer = new IndexedDbVaultImageArtifactExecutor({ databaseName });
		await publisher.invoke({ type: "begin", scope });
		await publisher.invoke(
			{ type: "writeChunk", scope, chunkIndex: 0 },
			new Uint8Array([97, 98, 99]),
		);
		const publication = publisher.invoke({ type: "publish", metadata });
		await entered;
		let deletionFinished = false;
		const deletion = racer.invoke({ type: "delete", scope }).then((answer) => {
			deletionFinished = true;
			return answer;
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		const deletionBlockedDuringDigest = !deletionFinished;
		releaseDigest();
		const publicationAnswer = await publication;
		const deletionAnswer = await deletion;
		const replacementBegin = await racer.invoke({ type: "begin", scope });
		const replacementWrite = await racer.invoke(
			{ type: "writeChunk", scope, chunkIndex: 0 },
			new Uint8Array([97, 98, 100]),
		);
		return {
			deletionBlockedDuringDigest,
			publicationAnswer,
			deletionAnswer,
			replacementBegin,
			replacementWrite,
		};
	},
});
