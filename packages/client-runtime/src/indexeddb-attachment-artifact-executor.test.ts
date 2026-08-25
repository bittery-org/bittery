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
		for (const [index, step] of fixture.steps.entries()) {
			const controlJson = JSON.stringify(step.request);
			expect(controlJson).not.toContain("AQID");
			expect(controlJson).not.toContain("[1,2,3]");
			const result = await executor.invoke(
				controlJson,
				index === 0 ? new Uint8Array([1, 2, 3]) : undefined,
			);
			const response: unknown = JSON.parse(result.controlResponseJson);
			expect(validateArtifactControlResponse(response)).toBe(true);
			expect(response).toEqual(step.response);
			if (index === fixture.steps.length - 1) {
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
