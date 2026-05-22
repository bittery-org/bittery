import {
	build_client,
	type ClientBuilder,
	type HttpOptions,
	http,
	type MultiOptions,
	type Mutation,
	multi,
	type Plugins,
	type Query,
	type SocketOptions,
	type StreamHandler,
	type StreamUnsubscribe,
	type Subscription,
	type Transport,
	ws,
} from "@qubit-rs/client";
import type { QubitServer } from "./generated/index.ts";
import { type HttpBatchOptions, httpBatch } from "./http-batch.ts";

export type {
	ClientBuilder,
	HttpBatchOptions,
	HttpOptions,
	MultiOptions,
	Mutation,
	Plugins,
	Query,
	SocketOptions,
	StreamHandler,
	StreamUnsubscribe,
	Subscription,
	Transport,
};

export function createRustRpcClient(rpcUrl: string, options?: HttpOptions) {
	return build_client<QubitServer>(http(rpcUrl, options));
}

export function createRustRpcBatchClient(
	rpcUrl: string,
	options?: HttpBatchOptions,
) {
	return build_client<QubitServer>(httpBatch(rpcUrl, options));
}

export function createRustRpcMultiClient(
	rpcUrl: string,
	options?: MultiOptions,
) {
	return build_client<QubitServer>(multi(rpcUrl, options));
}

export function createRustRpcWsClient(rpcUrl: string, options?: SocketOptions) {
	return build_client<QubitServer>(ws(rpcUrl, options));
}

export type RustRpcClient = ReturnType<typeof createRustRpcClient>;
export type RustRpcBatchClient = ReturnType<typeof createRustRpcBatchClient>;
export type RustRpcMultiClient = ReturnType<typeof createRustRpcMultiClient>;
export type RustRpcWsClient = ReturnType<typeof createRustRpcWsClient>;
