import {
	createRustRpcBatchClient,
	createRustRpcClient,
	type HttpBatchOptions,
	type HttpOptions,
	type RustRpcClient,
} from "@bittery/rust-rpc";
import { normalizeServerUrl } from "./server-url";

function buildRustRpcEndpointUrl(serverUrl: string): string {
	const normalizedBase = normalizeServerUrl(serverUrl);
	if (!normalizedBase) {
		return serverUrl;
	}

	return `${normalizedBase}/rpc`;
}

export interface CreateAppRustRpcClientOptions {
	serverUrl: string;
	transportOptions?: HttpOptions;
	batch?: boolean;
	batchOptions?: HttpBatchOptions;
}

export function createAppRustRpcClient(
	options: CreateAppRustRpcClientOptions,
): RustRpcClient {
	const url = buildRustRpcEndpointUrl(options.serverUrl);

	if (options.batch !== false) {
		return createRustRpcBatchClient(
			url,
			options.batchOptions ?? options.transportOptions,
		);
	}

	return createRustRpcClient(url, options.transportOptions);
}

export { buildRustRpcEndpointUrl };
export type { RustRpcClient };
