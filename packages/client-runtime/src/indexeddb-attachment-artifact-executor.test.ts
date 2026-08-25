import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { IDBFactory, IDBIndex, IDBKeyRange } from "fake-indexeddb";
import { validateArtifactControlResponse } from "../generated/artifact-control/validator.js";
import {
	ConfigurableIndexedDbAttachmentArtifactExecutor as IndexedDbAttachmentArtifactExecutor,
	type IndexedDbAttachmentArtifactOwner,
} from "./indexeddb-attachment-artifact-executor-internal.ts";

const owner: IndexedDbAttachmentArtifactOwner = {
	accountId: "account-1",
	artifactId: "artifact-1",
	operationId: "operation-1",
	attachmentId: "attachment-1",
	ciphertextSha256:
		"7e592b7a2d9533c24af5c82a173f3f5d41290375a07dfac281b9b787277a5295",
	byteLength: "5",
	chunkCount: 2,
};
const provisionalWriter = {
	accountId: "account-1",
	operationId: "operation-1",
	attachmentId: "attachment-1",
	generation: "9f20db4b-2cf0-4b73-a2a4-ad93c3615c4d",
};

async function invokeControl(
	executor: IndexedDbAttachmentArtifactExecutor,
	request: unknown,
	bytes?: Uint8Array,
): Promise<{ response: any; bytes?: ArrayBuffer }> {
	const result = await executor.invoke(JSON.stringify(request), bytes);
	return {
		response: JSON.parse(result.controlResponseJson),
		bytes: result.bytes,
	};
}

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

describe("IndexedDB Attachment artifact execution", () => {
	test("begins one durable provisional writer through the closed control boundary", async () => {
		const executor = new IndexedDbAttachmentArtifactExecutor({
			databaseName: "artifact-provisional-begin",
		});
		const request = {
			type: "beginProvisional",
			writer: {
				accountId: "account-1",
				operationId: "operation-1",
				attachmentId: "attachment-1",
				generation: "9f20db4b-2cf0-4b73-a2a4-ad93c3615c4d",
			},
		};

		const result = await executor.invoke(JSON.stringify(request));

		expect(JSON.parse(result.controlResponseJson)).toEqual({
			type: "provisionalBegun",
		});
	});

	test("seals, verifies, atomically maps, and recovers one physical generation across restarts", async () => {
		const databaseName = "artifact-provisional-restart";
		const first = new IndexedDbAttachmentArtifactExecutor({ databaseName });
		expect(
			(
				await invokeControl(first, {
					type: "beginProvisional",
					writer: provisionalWriter,
				})
			).response,
		).toEqual({ type: "provisionalBegun" });
		for (const [chunkIndex, bytes, chunkSha256] of [
			[
				0,
				new Uint8Array([1, 2, 3]),
				"039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
			],
			[
				1,
				new Uint8Array([4, 5]),
				"2fa1b377bf67309f65e5e3b38c74ec3c4bd97f1e12d44141715e88b7c0c6c3c6",
			],
		] as const) {
			expect(
				(
					await invokeControl(
						first,
						{
							type: "writeProvisionalChunk",
							writer: provisionalWriter,
							chunkIndex,
							chunkSha256,
						},
						bytes,
					)
				).response,
			).toEqual({ type: "chunkWritten", result: "stored" });
		}

		const state1 = new IndexedDbAttachmentArtifactExecutor({ databaseName });
		expect(
			(
				await invokeControl(state1, {
					type: "sealProvisional",
					writer: provisionalWriter,
					owner,
				})
			).response,
		).toEqual({ type: "provisionalBinding", owner, state: "sealed" });
		const read = await invokeControl(state1, {
			type: "readSealedProvisionalChunk",
			token: provisionalWriter,
			owner,
			chunkIndex: 1,
		});
		expect(new Uint8Array(read.bytes ?? [])).toEqual(new Uint8Array([4, 5]));
		expect(
			(
				await invokeControl(state1, {
					type: "finishProvisional",
					token: provisionalWriter,
					owner,
				})
			).response,
		).toEqual({ type: "provisionalFinished" });

		const state2 = new IndexedDbAttachmentArtifactExecutor({ databaseName });
		expect(
			(
				await invokeControl(state2, {
					type: "recoverProvisional",
					scope: {
						accountId: "account-1",
						operationId: "operation-1",
						attachmentId: "attachment-1",
					},
				})
			).response,
		).toEqual({
			type: "provisionalRecoveryAvailable",
			recovery: provisionalWriter,
		});
		expect(
			(
				await invokeControl(state2, {
					type: "resumeRecoveredProvisional",
					recovery: provisionalWriter,
				})
			).response,
		).toEqual({ type: "provisionalBinding", owner, state: "published" });
		expect(
			new Uint8Array((await state2.readPublishedChunk(owner, 0)).bytes),
		).toEqual(new Uint8Array([1, 2, 3]));
	});

	test("restart exposes only authenticated recovery and fences a fresh generation", async () => {
		const databaseName = "artifact-provisional-fence";
		const state0 = new IndexedDbAttachmentArtifactExecutor({ databaseName });
		await invokeControl(state0, {
			type: "beginProvisional",
			writer: provisionalWriter,
		});
		await expect(
			invokeControl(new IndexedDbAttachmentArtifactExecutor({ databaseName }), {
				type: "recoverProvisional",
				scope: {
					accountId: "account-1",
					operationId: "operation-1",
					attachmentId: "attachment-1",
				},
			}),
		).rejects.toThrow("authenticated provisional");
		await invokeControl(
			state0,
			{
				type: "writeProvisionalChunk",
				writer: provisionalWriter,
				chunkIndex: 0,
				chunkSha256:
					"7e592b7a2d9533c24af5c82a173f3f5d41290375a07dfac281b9b787277a5295",
			},
			new Uint8Array([1, 2, 3, 4, 5]),
		);
		const singleOwner = { ...owner, chunkCount: 1 };
		await invokeControl(state0, {
			type: "sealProvisional",
			writer: provisionalWriter,
			owner: singleOwner,
		});

		const secondWriter = {
			...provisionalWriter,
			generation: "3cf8c31a-4a2b-4b2b-bcce-a2f474de76ba",
		};
		expect(
			(
				await invokeControl(
					new IndexedDbAttachmentArtifactExecutor({ databaseName }),
					{ type: "beginProvisional", writer: secondWriter },
				)
			).response,
		).toEqual({
			type: "provisionalRecoveryAvailable",
			recovery: provisionalWriter,
		});
		await invokeControl(state0, {
			type: "finishProvisional",
			token: provisionalWriter,
			owner: singleOwner,
		});
		expect(
			(
				await invokeControl(state0, {
					type: "beginProvisional",
					writer: secondWriter,
				})
			).response,
		).toEqual({ type: "provisionalBegun" });
		await expect(
			invokeControl(
				state0,
				{
					type: "writeProvisionalChunk",
					writer: provisionalWriter,
					chunkIndex: 1,
					chunkSha256: "00",
				},
				new Uint8Array([9]),
			),
		).rejects.toThrow("stale");
		await expect(
			invokeControl(state0, {
				type: "resumeRecoveredProvisional",
				recovery: { ...provisionalWriter, operationId: "operation-other" },
			}),
		).rejects.toThrow("matching authenticated");
		await expect(
			invokeControl(state0, {
				type: "resumeRecoveredProvisional",
				recovery: { ...provisionalWriter, generation: "not-a-token" },
			}),
		).rejects.toThrow("control request is invalid");
	});

	test("rejects incomplete shape and unsigned bounds before durable publication", async () => {
		const executor = new IndexedDbAttachmentArtifactExecutor({
			databaseName: "artifact-provisional-bounds",
		});
		await invokeControl(executor, {
			type: "beginProvisional",
			writer: provisionalWriter,
		});
		await invokeControl(
			executor,
			{
				type: "writeProvisionalChunk",
				writer: provisionalWriter,
				chunkIndex: 0,
				chunkSha256:
					"039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
			},
			new Uint8Array([1, 2, 3]),
		);
		await expect(
			invokeControl(executor, {
				type: "sealProvisional",
				writer: provisionalWriter,
				owner,
			}),
		).rejects.toThrow("incomplete");
		await expect(
			invokeControl(executor, {
				type: "sealProvisional",
				writer: provisionalWriter,
				owner: { ...owner, chunkCount: 1, byteLength: "4" },
			}),
		).rejects.toThrow("incomplete");
		await expect(
			invokeControl(
				executor,
				{
					type: "writeProvisionalChunk",
					writer: provisionalWriter,
					chunkIndex: 4_294_967_296,
					chunkSha256: "00",
				},
				new Uint8Array([1]),
			),
		).rejects.toThrow("control request is invalid");
		await expect(
			invokeControl(
				executor,
				{
					type: "writeProvisionalChunk",
					writer: provisionalWriter,
					chunkIndex: 1,
					chunkSha256: "00",
				},
				new Uint8Array(256 * 1024 + 1),
			),
		).rejects.toThrow("chunk length is invalid");
	});

	test("concurrent exact finalizers converge on one canonical mapping", async () => {
		const databaseName = "artifact-provisional-concurrent-finalize";
		const seed = new IndexedDbAttachmentArtifactExecutor({ databaseName });
		const singleOwner = { ...owner, chunkCount: 1 };
		await invokeControl(seed, {
			type: "beginProvisional",
			writer: provisionalWriter,
		});
		await invokeControl(
			seed,
			{
				type: "writeProvisionalChunk",
				writer: provisionalWriter,
				chunkIndex: 0,
				chunkSha256: singleOwner.ciphertextSha256,
			},
			new Uint8Array([1, 2, 3, 4, 5]),
		);
		await invokeControl(seed, {
			type: "sealProvisional",
			writer: provisionalWriter,
			owner: singleOwner,
		});
		const results = await Promise.all([
			invokeControl(new IndexedDbAttachmentArtifactExecutor({ databaseName }), {
				type: "finishProvisional",
				token: provisionalWriter,
				owner: singleOwner,
			}),
			invokeControl(new IndexedDbAttachmentArtifactExecutor({ databaseName }), {
				type: "finishProvisional",
				token: provisionalWriter,
				owner: singleOwner,
			}),
		]);
		expect(results.map(({ response }) => response)).toEqual([
			{ type: "provisionalFinished" },
			{ type: "provisionalFinished" },
		]);
	});

	test("each provisional transaction boundary restarts without publishing partial state", async () => {
		const databaseName = "artifact-provisional-faults";
		await expect(
			invokeControl(
				new IndexedDbAttachmentArtifactExecutor({
					databaseName,
					failAfterWrite: 1,
				}),
				{ type: "beginProvisional", writer: provisionalWriter },
			),
		).rejects.toThrow("injected IndexedDB");
		const seed = new IndexedDbAttachmentArtifactExecutor({ databaseName });
		await invokeControl(seed, {
			type: "beginProvisional",
			writer: provisionalWriter,
		});
		await expect(
			invokeControl(
				new IndexedDbAttachmentArtifactExecutor({
					databaseName,
					failAfterWrite: 2,
				}),
				{
					type: "writeProvisionalChunk",
					writer: provisionalWriter,
					chunkIndex: 0,
					chunkSha256: owner.ciphertextSha256,
				},
				new Uint8Array([1, 2, 3, 4, 5]),
			),
		).rejects.toThrow("injected IndexedDB");
		await expect(
			invokeControl(seed, {
				type: "sealProvisional",
				writer: provisionalWriter,
				owner: { ...owner, chunkCount: 1 },
			}),
		).rejects.toThrow("incomplete");
		await invokeControl(
			seed,
			{
				type: "writeProvisionalChunk",
				writer: provisionalWriter,
				chunkIndex: 0,
				chunkSha256: owner.ciphertextSha256,
			},
			new Uint8Array([1, 2, 3, 4, 5]),
		);
		await expect(
			invokeControl(
				new IndexedDbAttachmentArtifactExecutor({
					databaseName,
					failAfterWrite: 1,
				}),
				{
					type: "sealProvisional",
					writer: provisionalWriter,
					owner: { ...owner, chunkCount: 1 },
				},
			),
		).rejects.toThrow("injected IndexedDB");
		await expect(
			invokeControl(seed, {
				type: "recoverProvisional",
				scope: {
					accountId: "account-1",
					operationId: "operation-1",
					attachmentId: "attachment-1",
				},
			}),
		).rejects.toThrow("authenticated provisional");
		await invokeControl(seed, {
			type: "sealProvisional",
			writer: provisionalWriter,
			owner: { ...owner, chunkCount: 1 },
		});
		await expect(
			invokeControl(
				new IndexedDbAttachmentArtifactExecutor({
					databaseName,
					failAfterWrite: 2,
				}),
				{
					type: "finishProvisional",
					token: provisionalWriter,
					owner: { ...owner, chunkCount: 1 },
				},
			),
		).rejects.toThrow("injected IndexedDB");
		const restarted = new IndexedDbAttachmentArtifactExecutor({ databaseName });
		expect(
			(
				await invokeControl(restarted, {
					type: "resumeRecoveredProvisional",
					recovery: provisionalWriter,
				})
			).response.state,
		).toBe("sealed");
		await invokeControl(restarted, {
			type: "finishProvisional",
			token: provisionalWriter,
			owner: { ...owner, chunkCount: 1 },
		});
		expect(
			(
				await invokeControl(
					new IndexedDbAttachmentArtifactExecutor({ databaseName }),
					{ type: "resumeRecoveredProvisional", recovery: provisionalWriter },
				)
			).response.state,
		).toBe("published");
	});

	test("Account deletion and orphan cleanup isolate scope and preserve a live mapped generation", async () => {
		const databaseName = "artifact-provisional-cleanup";
		const executor = new IndexedDbAttachmentArtifactExecutor({ databaseName });
		const singleOwner = { ...owner, chunkCount: 1 };
		await invokeControl(executor, {
			type: "beginProvisional",
			writer: provisionalWriter,
		});
		await invokeControl(
			executor,
			{
				type: "writeProvisionalChunk",
				writer: provisionalWriter,
				chunkIndex: 0,
				chunkSha256: owner.ciphertextSha256,
			},
			new Uint8Array([1, 2, 3, 4, 5]),
		);
		await invokeControl(executor, {
			type: "sealProvisional",
			writer: provisionalWriter,
			owner: singleOwner,
		});
		await invokeControl(executor, {
			type: "finishProvisional",
			token: provisionalWriter,
			owner: singleOwner,
		});
		const orphan = {
			...provisionalWriter,
			generation: "f89b4b03-7976-4d73-bb4f-cf58350fc3a2",
		};
		const other = {
			...provisionalWriter,
			accountId: "account-2",
			generation: "31a373ed-2aa1-4b4a-8ea9-998186fe204e",
		};
		await invokeControl(executor, { type: "beginProvisional", writer: orphan });
		await invokeControl(executor, { type: "beginProvisional", writer: other });
		const listed = (
			await invokeControl(executor, {
				type: "listArtifactIds",
				accountId: "account-1",
			})
		).response;
		expect(listed.provisional).toEqual([orphan]);
		await invokeControl(executor, {
			type: "deleteProvisionalGeneration",
			token: orphan,
		});
		expect(
			new Uint8Array((await executor.readPublishedChunk(singleOwner, 0)).bytes),
		).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
		await invokeControl(executor, {
			type: "deleteAccount",
			accountId: "account-1",
		});
		expect(
			(
				await invokeControl(executor, {
					type: "listArtifactIds",
					accountId: "account-1",
				})
			).response,
		).toEqual({ type: "artifactIds", artifactIds: [], provisional: [] });
		expect(
			(
				await invokeControl(executor, {
					type: "listArtifactIds",
					accountId: "account-2",
				})
			).response.provisional,
		).toEqual([other]);
	});

	test("orphan cleanup distinguishes an identical generation in a different Operation and Attachment scope", async () => {
		const databaseName = "artifact-provisional-generation-scope";
		const executor = new IndexedDbAttachmentArtifactExecutor({ databaseName });
		const singleOwner = { ...owner, chunkCount: 1 };
		await invokeControl(executor, {
			type: "beginProvisional",
			writer: provisionalWriter,
		});
		await invokeControl(
			executor,
			{
				type: "writeProvisionalChunk",
				writer: provisionalWriter,
				chunkIndex: 0,
				chunkSha256: owner.ciphertextSha256,
			},
			new Uint8Array([1, 2, 3, 4, 5]),
		);
		await invokeControl(executor, {
			type: "sealProvisional",
			writer: provisionalWriter,
			owner: singleOwner,
		});
		await invokeControl(executor, {
			type: "finishProvisional",
			token: provisionalWriter,
			owner: singleOwner,
		});

		const differentOperationOrphan = {
			...provisionalWriter,
			operationId: "operation-orphan",
		};
		const differentAttachmentOrphan = {
			...provisionalWriter,
			attachmentId: "attachment-orphan",
		};
		for (const writer of [
			differentAttachmentOrphan,
			differentOperationOrphan,
		]) {
			await invokeControl(executor, { type: "beginProvisional", writer });
		}

		expect(
			(
				await invokeControl(executor, {
					type: "listArtifactIds",
					accountId: "account-1",
				})
			).response.provisional,
		).toEqual([differentAttachmentOrphan, differentOperationOrphan]);
		for (const token of [differentAttachmentOrphan, differentOperationOrphan]) {
			expect(
				(
					await invokeControl(executor, {
						type: "deleteProvisionalGeneration",
						token,
					})
				).response,
			).toEqual({ type: "artifactDeleted", result: "deleted" });
		}
		expect(
			new Uint8Array((await executor.readPublishedChunk(singleOwner, 0)).bytes),
		).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
	});

	test("upgrades a B2 version-one database without losing canonical artifacts", async () => {
		const databaseName = "artifact-provisional-v1-upgrade";
		await seedVersionOneArtifactDatabase(
			databaseName,
			owner,
			new Uint8Array([1, 2, 3, 4, 5]),
		);
		const upgraded = new IndexedDbAttachmentArtifactExecutor({ databaseName });
		expect(
			new Uint8Array(
				(await upgraded.readPublishedChunk({ ...owner, chunkCount: 1 }, 0))
					.bytes,
			),
		).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
		expect(
			(
				await invokeControl(upgraded, {
					type: "beginProvisional",
					writer: provisionalWriter,
				})
			).response,
		).toEqual({ type: "provisionalBegun" });
	});

	test("executes Rust-generated control metadata with ciphertext on the binary side channel", async () => {
		const executor = new IndexedDbAttachmentArtifactExecutor({
			databaseName: "artifact-generated-control",
		});
		const fixture = JSON.parse(
			readFileSync(
				new URL("../generated/artifact-control/fixture.json", import.meta.url),
				"utf8",
			),
		) as {
			steps: Array<{ request: unknown; response: unknown }>;
		};
		for (const step of fixture.steps) {
			const controlJson = JSON.stringify(step.request);
			expect(controlJson).not.toContain("AQID");
			expect(controlJson).not.toContain("[1,2,3]");
			const result = await executor.invoke(
				controlJson,
				(step.request as { type?: string }).type === "writeChunk"
					? new Uint8Array([1, 2, 3])
					: undefined,
			);
			const response: unknown = JSON.parse(result.controlResponseJson);
			expect(validateArtifactControlResponse(response)).toBe(true);
			expect(response).toEqual(step.response);
			if ((step.request as { type?: string }).type === "readPublishedChunk") {
				expect(new Uint8Array(result.bytes ?? [])).toEqual(
					new Uint8Array([1, 2, 3]),
				);
			}
		}
	});
	test("publishes binary chunks and reads them after restart", async () => {
		const first = new IndexedDbAttachmentArtifactExecutor({
			databaseName: "artifact-restart",
		});
		expect(
			await first.writeChunk(
				owner,
				0,
				"039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
				new Uint8Array([1, 2, 3]),
			),
		).toBe("stored");
		expect(
			await first.writeChunk(
				owner,
				1,
				"2fa1b377bf67309f65e5e3b38c74ec3c4bd97f1e12d44141715e88b7c0c6c3c6",
				new Uint8Array([4, 5]),
			),
		).toBe("stored");
		expect(await first.beginPublish(owner)).toBe("verifying");
		expect(await first.finishPublish(owner)).toBe("published");

		const raw = await first.readStoredChunkForTest(owner, 0);
		expect(raw).toBeInstanceOf(ArrayBuffer);

		const restored = new IndexedDbAttachmentArtifactExecutor({
			databaseName: "artifact-restart",
		});
		const chunk = await restored.readPublishedChunk(owner, 1);
		expect(new Uint8Array(chunk.bytes)).toEqual(new Uint8Array([4, 5]));
		expect(chunk.chunkSha256).toBe(
			"2fa1b377bf67309f65e5e3b38c74ec3c4bd97f1e12d44141715e88b7c0c6c3c6",
		);
	});

	test("exact chunk replay converges and different bytes conflict", async () => {
		const executor = new IndexedDbAttachmentArtifactExecutor({
			databaseName: "artifact-replay",
		});
		const bytes = new Uint8Array([1, 2, 3]);
		const digest =
			"039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81";
		expect(await executor.writeChunk(owner, 0, digest, bytes)).toBe("stored");
		expect(await executor.writeChunk(owner, 0, digest, bytes)).toBe(
			"alreadyStored",
		);
		await expect(
			executor.writeChunk(
				owner,
				0,
				"9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
				new Uint8Array([1, 2, 4]),
			),
		).rejects.toThrow("conflicts with durable ciphertext");
	});

	test("two executors converge when publishing the same verifying artifact", async () => {
		const databaseName = "artifact-concurrent-publish";
		const seed = new IndexedDbAttachmentArtifactExecutor({ databaseName });
		await seed.writeChunk(
			{ ...owner, byteLength: "3", chunkCount: 1 },
			0,
			"039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
			new Uint8Array([1, 2, 3]),
		);
		const first = new IndexedDbAttachmentArtifactExecutor({ databaseName });
		const second = new IndexedDbAttachmentArtifactExecutor({ databaseName });
		const single = { ...owner, byteLength: "3", chunkCount: 1 };
		expect(
			await Promise.all([
				first.beginPublish(single),
				second.beginPublish(single),
			]),
		).toEqual(["verifying", "verifying"]);
		expect(
			(
				await Promise.all([
					first.finishPublish(single),
					second.finishPublish(single),
				])
			).sort(),
		).toEqual(["alreadyPublished", "published"]);
	});

	test("restart resumes each publication boundary without exposing incomplete bytes", async () => {
		const databaseName = "artifact-boundaries";
		const single = { ...owner, byteLength: "3", chunkCount: 1 };
		const failedWrite = new IndexedDbAttachmentArtifactExecutor({
			databaseName,
			failAfterWrite: 2,
		});
		await expect(
			failedWrite.writeChunk(
				single,
				0,
				"039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
				new Uint8Array([1, 2, 3]),
			),
		).rejects.toThrow("injected IndexedDB");
		const resumed = new IndexedDbAttachmentArtifactExecutor({ databaseName });
		await expect(resumed.beginPublish(single)).rejects.toThrow("not available");
		await resumed.writeChunk(
			single,
			0,
			"039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
			new Uint8Array([1, 2, 3]),
		);
		await resumed.beginPublish(single);
		const afterBegin = new IndexedDbAttachmentArtifactExecutor({
			databaseName,
		});
		await expect(afterBegin.readPublishedChunk(single, 0)).rejects.toThrow(
			"not published",
		);
		expect(
			new Uint8Array((await afterBegin.readVerifyingChunk(single, 0)).bytes),
		).toEqual(new Uint8Array([1, 2, 3]));
		await afterBegin.finishPublish(single);
		const afterFinish = new IndexedDbAttachmentArtifactExecutor({
			databaseName,
		});
		expect(
			new Uint8Array((await afterFinish.readPublishedChunk(single, 0)).bytes),
		).toEqual(new Uint8Array([1, 2, 3]));
	});

	test("premature publication stays incomplete so a missing chunk can resume", async () => {
		const databaseName = "artifact-incomplete-publication";
		const first = new IndexedDbAttachmentArtifactExecutor({ databaseName });
		await first.writeChunk(
			owner,
			0,
			"039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
			new Uint8Array([1, 2, 3]),
		);
		await expect(first.beginPublish(owner)).rejects.toThrow(
			"chunks are incomplete",
		);

		const restored = new IndexedDbAttachmentArtifactExecutor({ databaseName });
		expect(
			await restored.writeChunk(
				owner,
				1,
				"2fa1b377bf67309f65e5e3b38c74ec3c4bd97f1e12d44141715e88b7c0c6c3c6",
				new Uint8Array([4, 5]),
			),
		).toBe("stored");
		expect(await restored.beginPublish(owner)).toBe("verifying");
		expect(await restored.finishPublish(owner)).toBe("published");
	});

	test("publication proves completeness without materializing all chunk keys", async () => {
		const executor = new IndexedDbAttachmentArtifactExecutor({
			databaseName: "artifact-bounded-completeness",
		});
		await executor.writeChunk(
			{ ...owner, byteLength: "3", chunkCount: 1 },
			0,
			"039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
			new Uint8Array([1, 2, 3]),
		);
		const original = IDBIndex.prototype.getAllKeys;
		IDBIndex.prototype.getAllKeys = () => {
			throw new Error("unbounded chunk-key materialization");
		};
		try {
			expect(
				await executor.beginPublish({
					...owner,
					byteLength: "3",
					chunkCount: 1,
				}),
			).toBe("verifying");
		} finally {
			IDBIndex.prototype.getAllKeys = original;
		}
	});

	test("chunk-count rollback leaves restart writable and incomplete", async () => {
		const databaseName = "artifact-count-rollback";
		const seed = new IndexedDbAttachmentArtifactExecutor({ databaseName });
		await seed.writeChunk(
			owner,
			0,
			"039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
			new Uint8Array([1, 2, 3]),
		);
		const interrupted = new IndexedDbAttachmentArtifactExecutor({
			databaseName,
			failAfterWrite: 2,
		});
		await expect(
			interrupted.writeChunk(
				owner,
				1,
				"2fa1b377bf67309f65e5e3b38c74ec3c4bd97f1e12d44141715e88b7c0c6c3c6",
				new Uint8Array([4, 5]),
			),
		).rejects.toThrow("injected IndexedDB");
		const restored = new IndexedDbAttachmentArtifactExecutor({ databaseName });
		await expect(restored.beginPublish(owner)).rejects.toThrow(
			"chunks are incomplete",
		);
		expect(
			await restored.writeChunk(
				owner,
				1,
				"2fa1b377bf67309f65e5e3b38c74ec3c4bd97f1e12d44141715e88b7c0c6c3c6",
				new Uint8Array([4, 5]),
			),
		).toBe("stored");
		expect(await restored.beginPublish(owner)).toBe("verifying");
	});

	test("Account deletion is explicit and never uses active-account scope", async () => {
		const databaseName = "artifact-account-delete";
		const executor = new IndexedDbAttachmentArtifactExecutor({ databaseName });
		const other = { ...owner, accountId: "account-2" };
		for (const scoped of [owner, other]) {
			await executor.writeChunk(
				scoped,
				0,
				"039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
				new Uint8Array([1, 2, 3]),
			);
		}
		await executor.deleteAccount("account-1");
		expect(await executor.listArtifactIds("account-1")).toEqual([]);
		expect(await executor.listArtifactIds("account-2")).toEqual([
			owner.artifactId,
		]);
	});

	test("orphan deletion commits bounded progress and restart resumes", async () => {
		const databaseName = "artifact-sweep-resume";
		const seed = new IndexedDbAttachmentArtifactExecutor({ databaseName });
		const first = {
			...owner,
			artifactId: "artifact-a",
			operationId: "operation-a",
		};
		const second = {
			...owner,
			artifactId: "artifact-b",
			operationId: "operation-b",
		};
		const live = {
			...owner,
			artifactId: "artifact-live",
			operationId: "operation-live",
		};
		for (const scoped of [first, second, live]) {
			await seed.writeChunk(
				scoped,
				0,
				"039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
				new Uint8Array([1, 2, 3]),
			);
		}
		const interrupted = new IndexedDbAttachmentArtifactExecutor({
			databaseName,
			failAfterWrite: 3,
		});
		await interrupted.deleteArtifact("account-1", first.artifactId);
		await interrupted.deleteArtifact("account-1", first.artifactId);
		await expect(
			interrupted.deleteArtifact("account-1", second.artifactId),
		).rejects.toThrow("injected IndexedDB");
		const restored = new IndexedDbAttachmentArtifactExecutor({ databaseName });
		expect(await restored.listArtifactIds("account-1")).toEqual([
			second.artifactId,
			live.artifactId,
		]);
		await restored.deleteArtifact("account-1", second.artifactId);
		await restored.deleteArtifact("account-1", second.artifactId);
		expect(await restored.listArtifactIds("account-1")).toEqual([
			live.artifactId,
		]);
	});

	test("termination after a later orphan chunk keeps earlier bounded deletion", async () => {
		const databaseName = "artifact-sweep-chunk-resume";
		const multi = { ...owner, byteLength: "5", chunkCount: 2 };
		const seed = new IndexedDbAttachmentArtifactExecutor({ databaseName });
		await seed.writeChunk(
			multi,
			0,
			"039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
			new Uint8Array([1, 2, 3]),
		);
		await seed.writeChunk(
			multi,
			1,
			"2fa1b377bf67309f65e5e3b38c74ec3c4bd97f1e12d44141715e88b7c0c6c3c6",
			new Uint8Array([4, 5]),
		);
		const interrupted = new IndexedDbAttachmentArtifactExecutor({
			databaseName,
			failAfterWrite: 2,
		});
		expect(
			await interrupted.deleteArtifact("account-1", multi.artifactId),
		).toBe("progress");
		await expect(
			interrupted.deleteArtifact("account-1", multi.artifactId),
		).rejects.toThrow("injected IndexedDB");
		await expect(seed.readStoredChunkForTest(multi, 0)).rejects.toThrow(
			"missing",
		);
		expect(new Uint8Array(await seed.readStoredChunkForTest(multi, 1))).toEqual(
			new Uint8Array([4, 5]),
		);
		const restored = new IndexedDbAttachmentArtifactExecutor({ databaseName });
		expect(await restored.deleteArtifact("account-1", multi.artifactId)).toBe(
			"progress",
		);
		expect(await restored.deleteArtifact("account-1", multi.artifactId)).toBe(
			"deleted",
		);
		expect(await restored.listArtifactIds("account-1")).toEqual([]);
	});
});

async function seedVersionOneArtifactDatabase(
	databaseName: string,
	legacyOwner: IndexedDbAttachmentArtifactOwner,
	bytes: Uint8Array,
): Promise<void> {
	const database = await new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(databaseName, 1);
		request.onupgradeneeded = () => {
			const artifacts = request.result.createObjectStore("artifacts", {
				keyPath: ["accountId", "artifactId"],
			});
			artifacts.createIndex("by_account", "accountId");
			const chunks = request.result.createObjectStore("chunks", {
				keyPath: ["accountId", "artifactId", "chunkIndex"],
			});
			chunks.createIndex("by_account", "accountId");
			chunks.createIndex("by_artifact", ["accountId", "artifactId"]);
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
	const transaction = database.transaction(
		["artifacts", "chunks"],
		"readwrite",
	);
	transaction.objectStore("artifacts").add({
		...legacyOwner,
		chunkCount: 1,
		publicationState: "published",
		durableChunkCount: 1,
	});
	transaction.objectStore("chunks").add({
		accountId: legacyOwner.accountId,
		artifactId: legacyOwner.artifactId,
		chunkIndex: 0,
		chunkSha256: legacyOwner.ciphertextSha256,
		bytes: bytes.buffer.slice(
			bytes.byteOffset,
			bytes.byteOffset + bytes.byteLength,
		),
	});
	await new Promise<void>((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onerror = () => reject(transaction.error);
		transaction.onabort = () => reject(transaction.error);
	});
	database.close();
}
