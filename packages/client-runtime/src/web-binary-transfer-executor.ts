import {
	ConfigurableWebBinaryTransferExecutor,
	type ForegroundUploadOutcome,
} from "./web-binary-transfer-executor-internal.ts";

export type { ForegroundUploadOutcome } from "./web-binary-transfer-executor-internal.ts";

/** Fixed browser and MV3 adapter; credential and Fetch injection remain package-internal. */
export class WebBinaryTransferExecutor {
	readonly #executor = new ConfigurableWebBinaryTransferExecutor();

	invoke(
		controlRequestJson: string,
		binaryChunk?: Uint8Array,
	): Promise<{ controlResponseJson: string; bytes?: ArrayBuffer }> {
		return this.#executor.invoke(controlRequestJson, binaryChunk);
	}
	beginForegroundUpload(
		accountId: string,
		attachmentId: string,
		url: string,
		expectedByteLength: number,
	): string {
		return this.#executor.beginForegroundUpload(
			accountId,
			attachmentId,
			url,
			expectedByteLength,
		);
	}
	writeForegroundUpload(transferId: string, bytes: Uint8Array): Promise<void> {
		return this.#executor.writeForegroundUpload(transferId, bytes);
	}
	finishForegroundUpload(
		transferId: string,
		ciphertextSha256: string,
	): Promise<ForegroundUploadOutcome> {
		return this.#executor.finishForegroundUpload(transferId, ciphertextSha256);
	}
	abortForegroundUpload(transferId: string): Promise<void> {
		return this.#executor.abortForegroundUpload(transferId);
	}

	close(): Promise<void> {
		return this.#executor.close();
	}
}
