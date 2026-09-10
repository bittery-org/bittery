import { ConfigurableIndexedDbAttachmentArtifactExecutor } from "./indexeddb-attachment-artifact-executor-internal.ts";

/** Fixed production executor. Test storage redirection and fault injection stay package-internal. */
export class IndexedDbAttachmentArtifactExecutor {
	readonly #executor = new ConfigurableIndexedDbAttachmentArtifactExecutor();

	invoke(
		controlRequestJson: string,
		binaryChunk?: Uint8Array,
	): Promise<{ controlResponseJson: string; bytes?: ArrayBuffer }> {
		return this.#executor.invoke(controlRequestJson, binaryChunk);
	}
}

export type {
	IndexedDbAttachmentArtifactChunk,
	IndexedDbAttachmentArtifactOwner,
} from "./indexeddb-attachment-artifact-executor-internal.ts";
