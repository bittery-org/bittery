import { ConfigurableWebBinaryTransferExecutor } from "./web-binary-transfer-executor-internal.ts";

/** Fixed browser and MV3 adapter; credential and Fetch injection remain package-internal. */
export class WebBinaryTransferExecutor {
	readonly #executor = new ConfigurableWebBinaryTransferExecutor();

	invoke(
		controlRequestJson: string,
		binaryChunk?: Uint8Array,
	): Promise<{ controlResponseJson: string; bytes?: ArrayBuffer }> {
		return this.#executor.invoke(controlRequestJson, binaryChunk);
	}

	close(): void {
		this.#executor.close();
	}
}
