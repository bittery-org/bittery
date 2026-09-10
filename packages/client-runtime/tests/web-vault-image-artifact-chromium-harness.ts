import { IndexedDbVaultImageArtifactExecutor } from "../src/indexeddb-vault-image-artifact-executor";

const executor = new IndexedDbVaultImageArtifactExecutor({
	databaseName: "vault-image-actual-chromium",
});
Object.assign(globalThis, {
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
