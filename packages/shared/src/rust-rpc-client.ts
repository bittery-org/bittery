import {
	createRustRpcClient,
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
}

export function createAppRustRpcClient(
	options: CreateAppRustRpcClientOptions,
): RustRpcClient {
	return createRustRpcClient(
		buildRustRpcEndpointUrl(options.serverUrl),
		options.transportOptions,
	);
}

export { buildRustRpcEndpointUrl };
export type { RustRpcClient };