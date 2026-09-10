import { expect, test } from "bun:test";
import { IndexedDbAttachmentArtifactExecutor } from "./indexeddb-attachment-artifact-executor.ts";

test("production artifact persistence has no configurable database or failure seam", () => {
	const production = new IndexedDbAttachmentArtifactExecutor();
	expect("invoke" in production).toBe(true);
	expect("writeChunk" in production).toBe(false);
	expect("beginPublish" in production).toBe(false);
	expect("readStoredChunkForTest" in production).toBe(false);
	const compileOnly = () => {
		// @ts-expect-error Production always uses its fixed database and never accepts test hooks.
		new IndexedDbAttachmentArtifactExecutor({
			databaseName: "redirected-production-storage",
			failAfterWrite: 1,
		});
		// @ts-expect-error Primitive writes remain behind the one generated control invocation.
		production.writeChunk;
		// @ts-expect-error Test inspection never exists on the production executor.
		production.readStoredChunkForTest;
	};
	void compileOnly;
});
