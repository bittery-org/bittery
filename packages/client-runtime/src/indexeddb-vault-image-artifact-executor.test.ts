import { beforeEach, describe, expect, test } from "bun:test";
import { IDBFactory, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";
import { IndexedDbVaultImageArtifactExecutor } from "./indexeddb-vault-image-artifact-executor";

beforeEach(() => {
	Object.defineProperty(globalThis, "indexedDB", {
		configurable: true,
		value: new IDBFactory(),
	});
	Object.defineProperty(globalThis, "IDBKeyRange", {
		configurable: true,
		value: IDBKeyRange,
	});
});
const scope = { accountId: "account-a", operationId: "operation-a" };
const metadata = {
	...scope,
	vaultId: "vault-a",
	byteLength: "3",
	contentType: "image/png",
	sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
};

describe("IndexedDB Vault-image artifact", () => {
	test("wipes every supplied binary even when validation rejects it", async () => {
		const executor = new IndexedDbVaultImageArtifactExecutor({
			databaseName: "vault-image-invalid-input-zeroization",
		});
		const malformed = new Uint8Array([1, 2, 3]);
		await expect(
			executor.invoke({ type: "not-a-request" } as never, malformed),
		).rejects.toThrow();
		expect(Array.from(malformed)).toEqual([0, 0, 0]);

		const short = new Uint8Array(0);
		await executor.invoke({ type: "begin", scope });
		await expect(
			executor.invoke({ type: "writeChunk", scope, chunkIndex: 0 }, short),
		).rejects.toThrow("Vault-image chunk is invalid");
		expect(Array.from(short)).toEqual([]);

		const oversized = new Uint8Array(262_145).fill(7);
		await expect(
			executor.invoke({ type: "writeChunk", scope, chunkIndex: 0 }, oversized),
		).rejects.toThrow("Vault-image chunk is invalid");
		expect(oversized.every((byte) => byte === 0)).toBe(true);
	});

	test("wipes executor-owned write and structured-clone read snapshots", async () => {
		let writeSnapshot: Uint8Array | undefined;
		let readSnapshot: Uint8Array | undefined;
		const add = IDBObjectStore.prototype.add;
		const get = IDBObjectStore.prototype.get;
		IDBObjectStore.prototype.add = function (...args) {
			const value = args[0] as { bytes?: Uint8Array };
			if (value.bytes !== undefined) writeSnapshot = value.bytes;
			return add.apply(this, args);
		};
		IDBObjectStore.prototype.get = function (...args) {
			const request = get.apply(this, args);
			if (this.name === "chunks")
				request.addEventListener("success", () => {
					readSnapshot = (request.result as { bytes?: Uint8Array } | undefined)
						?.bytes;
				});
			return request;
		};
		try {
			const executor = new IndexedDbVaultImageArtifactExecutor({
				databaseName: "vault-image-owned-snapshot-zeroization",
			});
			await executor.invoke({ type: "begin", scope });
			await executor.invoke(
				{ type: "writeChunk", scope, chunkIndex: 0 },
				new Uint8Array([97, 98, 99]),
			);
			expect(Array.from(writeSnapshot ?? [])).toEqual([0, 0, 0]);
			await executor.invoke({ type: "publish", metadata });
			const answer = await executor.invoke({
				type: "readChunk",
				metadata,
				chunkIndex: 0,
			});
			expect(answer).toEqual({
				type: "chunk",
				bytes: new Uint8Array([97, 98, 99]),
			});
			expect(Array.from(readSnapshot ?? [])).toEqual([0, 0, 0]);
		} finally {
			IDBObjectStore.prototype.add = add;
			IDBObjectStore.prototype.get = get;
		}
	});

	test("wipes the executor-owned write snapshot when the transaction fails", async () => {
		let writeSnapshot: Uint8Array | undefined;
		const add = IDBObjectStore.prototype.add;
		IDBObjectStore.prototype.add = function (...args) {
			const value = args[0] as { bytes?: Uint8Array };
			if (value.bytes !== undefined) writeSnapshot = value.bytes;
			return add.apply(this, args);
		};
		try {
			const databaseName = "vault-image-failed-write-snapshot-zeroization";
			const seed = new IndexedDbVaultImageArtifactExecutor({ databaseName });
			await seed.invoke({ type: "begin", scope });
			await expect(
				new IndexedDbVaultImageArtifactExecutor({
					databaseName,
					failure: { operation: "write", boundary: 2 },
				}).invoke(
					{ type: "writeChunk", scope, chunkIndex: 0 },
					new Uint8Array([97, 98, 99]),
				),
			).rejects.toThrow();
			expect(Array.from(writeSnapshot ?? [])).toEqual([0, 0, 0]);
		} finally {
			IDBObjectStore.prototype.add = add;
		}
	});

	test("replays, conflicts, atomically publishes, restarts, and deletes", async () => {
		const first = new IndexedDbVaultImageArtifactExecutor({
			databaseName: "vault-image-history",
		});
		expect(await first.invoke({ type: "begin", scope })).toEqual({
			type: "begun",
		});
		expect(
			await first.invoke(
				{ type: "writeChunk", scope, chunkIndex: 0 },
				new Uint8Array([97, 98, 99]),
			),
		).toEqual({ type: "chunkWritten", result: "stored" });
		expect(
			await first.invoke(
				{ type: "writeChunk", scope, chunkIndex: 0 },
				new Uint8Array([97, 98, 99]),
			),
		).toEqual({ type: "chunkWritten", result: "alreadyStored" });
		await expect(
			first.invoke(
				{ type: "writeChunk", scope, chunkIndex: 0 },
				new Uint8Array([1]),
			),
		).rejects.toThrow();
		expect(await first.invoke({ type: "publish", metadata })).toEqual({
			type: "published",
			result: "published",
		});
		const restarted = new IndexedDbVaultImageArtifactExecutor({
			databaseName: "vault-image-history",
		});
		expect(await restarted.invoke({ type: "publish", metadata })).toEqual({
			type: "published",
			result: "alreadyPublished",
		});
		expect(
			await restarted.invoke({ type: "readChunk", metadata, chunkIndex: 0 }),
		).toEqual({ type: "chunk", bytes: new Uint8Array([97, 98, 99]) });
		expect(await restarted.invoke({ type: "delete", scope })).toEqual({
			type: "deleted",
		});
		expect(await restarted.invoke({ type: "delete", scope })).toEqual({
			type: "deleted",
		});
	});

	test("refuses publication until the exact stored bytes match Rust metadata", async () => {
		const executor = new IndexedDbVaultImageArtifactExecutor({
			databaseName: "vault-image-publication-proof",
		});
		await executor.invoke({ type: "begin", scope });
		await executor.invoke(
			{ type: "writeChunk", scope, chunkIndex: 0 },
			new Uint8Array([97, 98, 99]),
		);
		await expect(
			executor.invoke({
				type: "publish",
				metadata: { ...metadata, byteLength: "2" },
			}),
		).rejects.toThrow();
		await expect(
			executor.invoke({
				type: "publish",
				metadata: { ...metadata, sha256: "0".repeat(64) },
			}),
		).rejects.toThrow();
		expect(await executor.invoke({ type: "publish", metadata })).toEqual({
			type: "published",
			result: "published",
		});
	});

	test("publication validates and marks the same bytes atomically across executors", async () => {
		const databaseName = "vault-image-digest-atomicity";
		const publisher = new IndexedDbVaultImageArtifactExecutor({ databaseName });
		const racer = new IndexedDbVaultImageArtifactExecutor({ databaseName });
		await publisher.invoke({ type: "begin", scope });
		await publisher.invoke(
			{ type: "writeChunk", scope, chunkIndex: 0 },
			new Uint8Array([97, 98, 99]),
		);
		const digest = crypto.subtle.digest.bind(crypto.subtle);
		let digestStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			digestStarted = resolve;
		});
		let releaseDigest!: () => void;
		const held = new Promise<void>((resolve) => {
			releaseDigest = resolve;
		});
		Object.defineProperty(crypto.subtle, "digest", {
			configurable: true,
			value: async (...args: Parameters<SubtleCrypto["digest"]>) => {
				digestStarted();
				await held;
				return digest(...args);
			},
		});
		try {
			const publication = publisher.invoke({ type: "publish", metadata });
			await started;
			let deletionSettled = false;
			const deletion = racer.invoke({ type: "delete", scope }).then(() => {
				deletionSettled = true;
			});
			await Promise.resolve();
			expect(deletionSettled).toBe(false);
			releaseDigest();
			expect(await publication).toEqual({
				type: "published",
				result: "published",
			});
			await deletion;
			await racer.invoke({ type: "begin", scope });
			await racer.invoke(
				{ type: "writeChunk", scope, chunkIndex: 0 },
				new Uint8Array([120, 121, 122]),
			);
			await expect(
				racer.invoke({ type: "readChunk", metadata, chunkIndex: 0 }),
			).rejects.toThrow();
		} finally {
			Object.defineProperty(crypto.subtle, "digest", {
				configurable: true,
				value: digest,
			});
		}
	});

	test("wipes the concatenated publication snapshot when digesting fails", async () => {
		let digestInput: Uint8Array | undefined;
		const executor = new IndexedDbVaultImageArtifactExecutor({
			databaseName: "vault-image-digest-zeroization",
			digest: async (bytes) => {
				digestInput = bytes;
				throw new Error("digest failed");
			},
		});
		await executor.invoke({ type: "begin", scope });
		await executor.invoke(
			{ type: "writeChunk", scope, chunkIndex: 0 },
			new Uint8Array([97, 98, 99]),
		);
		await expect(
			executor.invoke({ type: "publish", metadata }),
		).rejects.toThrow("digest failed");
		expect(Array.from(digestInput ?? [])).toEqual([0, 0, 0]);
	});

	test("exclusive startup sweep removes partial and published orphans before opening", async () => {
		const seed = new IndexedDbVaultImageArtifactExecutor({
			databaseName: "vault-image-sweep",
		});
		await seed.invoke({ type: "begin", scope });
		await seed.invoke(
			{ type: "writeChunk", scope, chunkIndex: 0 },
			new Uint8Array([1]),
		);
		const retained = { accountId: "account-a", operationId: "retained" };
		await seed.invoke({ type: "begin", scope: retained });
		const restarted = new IndexedDbVaultImageArtifactExecutor({
			databaseName: "vault-image-sweep",
		});
		expect(
			await restarted.invoke({
				type: "startupSweep",
				accountId: "account-a",
				referencedOperationIds: ["retained"],
			}),
		).toEqual({ type: "swept" });
		await expect(
			restarted.invoke(
				{ type: "writeChunk", scope, chunkIndex: 0 },
				new Uint8Array([1]),
			),
		).rejects.toThrow();
		expect(
			await restarted.invoke(
				{ type: "writeChunk", scope: retained, chunkIndex: 0 },
				new Uint8Array([1]),
			),
		).toEqual({ type: "chunkWritten", result: "stored" });
	});

	test("rolls back every write, publication, delete, and sweep failure boundary", async () => {
		for (const operation of ["write", "publish", "delete", "sweep"] as const)
			for (const boundary of [1, 2] as const) {
				const databaseName = `vault-image-${operation}-${boundary}`;
				const seed = new IndexedDbVaultImageArtifactExecutor({ databaseName });
				await seed.invoke({ type: "begin", scope });
				if (operation !== "write")
					await seed.invoke(
						{ type: "writeChunk", scope, chunkIndex: 0 },
						new Uint8Array([97, 98, 99]),
					);
				if (operation === "delete")
					await seed.invoke({ type: "publish", metadata });
				const failing = new IndexedDbVaultImageArtifactExecutor({
					databaseName,
					failure: { operation, boundary },
				});
				const action =
					operation === "write"
						? failing.invoke(
								{ type: "writeChunk", scope, chunkIndex: 0 },
								new Uint8Array([97, 98, 99]),
							)
						: operation === "publish"
							? failing.invoke({ type: "publish", metadata })
							: operation === "delete"
								? failing.invoke({ type: "delete", scope })
								: failing.invoke({
										type: "startupSweep",
										accountId: "account-a",
										referencedOperationIds: [],
									});
				await expect(action).rejects.toThrow();
				const resumed = new IndexedDbVaultImageArtifactExecutor({
					databaseName,
				});
				if (operation === "write")
					expect(
						await resumed.invoke(
							{ type: "writeChunk", scope, chunkIndex: 0 },
							new Uint8Array([97, 98, 99]),
						),
					).toEqual({ type: "chunkWritten", result: "stored" });
				else if (operation === "publish")
					expect(await resumed.invoke({ type: "publish", metadata })).toEqual({
						type: "published",
						result: "published",
					});
				else if (operation === "delete")
					expect(
						await resumed.invoke({
							type: "readChunk",
							metadata,
							chunkIndex: 0,
						}),
					).toEqual({ type: "chunk", bytes: new Uint8Array([97, 98, 99]) });
				else
					expect(
						await resumed.invoke(
							{ type: "writeChunk", scope, chunkIndex: 1 },
							new Uint8Array([1]),
						),
					).toEqual({ type: "chunkWritten", result: "stored" });
			}
	});

	test("retains begin, Account-delete, and Wipe obligations across every failure and restart", async () => {
		for (const boundary of [1, 2] as const) {
			const beginName = `vault-image-begin-${boundary}`;
			await expect(
				new IndexedDbVaultImageArtifactExecutor({
					databaseName: beginName,
					failure: { operation: "begin", boundary },
				}).invoke({ type: "begin", scope }),
			).rejects.toThrow();
			expect(
				await new IndexedDbVaultImageArtifactExecutor({
					databaseName: beginName,
				}).invoke({ type: "begin", scope }),
			).toEqual({ type: "begun" });

			for (const operation of ["deleteAccount", "wipe"] as const) {
				const databaseName = `vault-image-${operation}-${boundary}`;
				const seed = new IndexedDbVaultImageArtifactExecutor({ databaseName });
				await seed.invoke({ type: "begin", scope });
				await seed.invoke(
					{ type: "writeChunk", scope, chunkIndex: 0 },
					new Uint8Array([97, 98, 99]),
				);
				await seed.invoke({ type: "publish", metadata });
				const failing = new IndexedDbVaultImageArtifactExecutor({
					databaseName,
					failure: { operation, boundary },
				});
				await expect(
					operation === "deleteAccount"
						? failing.invoke({ type: "deleteAccount", accountId: "account-a" })
						: failing.invoke({ type: "wipe" }),
				).rejects.toThrow();
				expect(
					await new IndexedDbVaultImageArtifactExecutor({
						databaseName,
					}).invoke({ type: "readChunk", metadata, chunkIndex: 0 }),
				).toEqual({ type: "chunk", bytes: new Uint8Array([97, 98, 99]) });
			}
		}
	});
});
