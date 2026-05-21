import {
	build_client,
	http,
	multi,
	ws,
	type ClientBuilder,
	type HttpOptions,
	type MultiOptions,
	type Mutation,
	type Plugins,
	type Query,
	type SocketOptions,
	type StreamHandler,
	type StreamUnsubscribe,
	type Subscription,
	type Transport,
} from "@qubit-rs/client";
import type { QubitServer } from "./generated/index.ts";

export type {
	ClientBuilder,
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

export function createRustRpcClient(
	rpcUrl: string,
	options?: HttpOptions,
) {
	return build_client<QubitServer>(http(rpcUrl, options));
}

export function createRustRpcMultiClient(
	rpcUrl: string,
	options?: MultiOptions,
) {
	return build_client<QubitServer>(multi(rpcUrl, options));
}

export function createRustRpcWsClient(
	rpcUrl: string,
	options?: SocketOptions,
) {
	return build_client<QubitServer>(ws(rpcUrl, options));
}

export type RustRpcClient = ReturnType<typeof createRustRpcClient>;
export type RustRpcMultiClient = ReturnType<typeof createRustRpcMultiClient>;
export type RustRpcWsClient = ReturnType<typeof createRustRpcWsClient>;