import type {
	HttpOptions,
	Mutation,
	QubitServer,
	Query,
	Subscription,
} from "@bittery/rust-rpc";
import type { QueryClient } from "@tanstack/react-query";
import { queryOptions } from "@tanstack/react-query";
import { createAppRustRpcClient } from "./rust-rpc-client";

type RpcFetch = (
	url: RequestInfo | URL,
	requestOptions?: RequestInit,
) => Promise<Response>;

const DEFAULT_RPC_ENDPOINT_PATH = "/rpc";

type RpcResultEnvelope<TSuccess = unknown, TError = unknown> =
	| { Ok: TSuccess }
	| { Err: TError };

type RpcErrorPayload = {
	code?: string | number;
	message?: string;
	data?: Record<string, unknown>;
};

type QueryArgs<TQuery extends Query<any[], any>> =
	TQuery extends Query<infer TArgs, any> ? TArgs : never;

type QueryOutput<TQuery extends Query<any[], any>> =
	TQuery extends Query<any[], infer TOutput>
		? UnwrapRpcResult<TOutput>
		: never;

type MutationArgs<TMutation extends Mutation<any[], any>> =
	TMutation extends Mutation<infer TArgs, any> ? TArgs : never;

type MutationOutput<TMutation extends Mutation<any[], any>> =
	TMutation extends Mutation<any[], infer TOutput>
		? UnwrapRpcResult<TOutput>
		: never;

type SubscriptionArgs<TSubscription extends Subscription<any[], any>> =
	TSubscription extends Subscription<infer TArgs, any> ? TArgs : never;

type SubscriptionOutput<TSubscription extends Subscription<any[], any>> =
	TSubscription extends Subscription<any[], infer TOutput> ? TOutput : never;

export type RpcQueryKey = readonly unknown[];

export type AppRpcQueryOptions<TResult> = {
	queryKey: RpcQueryKey;
	queryFn: () => Promise<TResult>;
};

export type UnwrapRpcResult<TValue> = TValue extends {
	Ok: infer TSuccess;
}
	? TSuccess
	: TValue extends {
		Err: unknown;
	}
		? never
		: TValue;

type RpcQueryClientMethod<TQuery extends Query<any[], any>> = {
	query: (...args: QueryArgs<TQuery>) => Promise<QueryOutput<TQuery>>;
};

type RpcMutationClientMethod<TMutation extends Mutation<any[], any>> = {
	mutate: (...args: MutationArgs<TMutation>) => Promise<MutationOutput<TMutation>>;
};

type RpcSubscriptionClientMethod<TSubscription extends Subscription<any[], any>> = {
	subscribe: (
		...args: SubscriptionArgs<TSubscription>
	) => SubscriptionOutput<TSubscription>;
};

type RpcQueryOptionsMethod<TQuery extends Query<any[], any>> = {
	queryKey: (...args: QueryArgs<TQuery>) => RpcQueryKey;
	queryOptions: (...args: QueryArgs<TQuery>) => AppRpcQueryOptions<QueryOutput<TQuery>>;
};

type RpcClientShape<TNode> = TNode extends Query<any[], any>
	? RpcQueryClientMethod<TNode>
	: TNode extends Mutation<any[], any>
		? RpcMutationClientMethod<TNode>
		: TNode extends Subscription<any[], any>
			? RpcSubscriptionClientMethod<TNode>
			: TNode extends Record<string, unknown>
				? { [TKey in keyof TNode]: RpcClientShape<TNode[TKey]> }
				: never;

type RpcOptionsProxyShape<TNode> = TNode extends Query<any[], any>
	? RpcQueryOptionsMethod<TNode>
	: TNode extends Record<string, unknown>
		? { [TKey in keyof TNode]: RpcOptionsProxyShape<TNode[TKey]> }
		: never;

export type AppRpcClient = RpcClientShape<QubitServer>;
export type AppRpcOptionsProxy = RpcOptionsProxyShape<QubitServer>;

export class RpcClientError extends Error {
	code?: string | number;
	data?: Record<string, unknown>;

	constructor(
		message: string,
		options?: {
			code?: string | number;
			data?: Record<string, unknown>;
			cause?: unknown;
		},
	) {
		super(message);
		this.name = "RpcClientError";
		this.code = options?.code;
		this.data = {
			...(options?.data ?? {}),
			...(options?.code !== undefined ? { code: options.code } : {}),
		};
		if (options?.cause !== undefined) {
			this.cause = options.cause;
		}
	}
}

function normalizeEndpointPath(pathname: string): string {
	const withLeadingSlash = pathname.startsWith("/")
		? pathname
		: `/${pathname}`;
	const normalized = withLeadingSlash.replace(/\/+$/, "");
	return normalized || "/";
}

function isEnvelope(value: unknown): value is RpcResultEnvelope {
	return Boolean(
		value &&
			typeof value === "object" &&
			(("Ok" in value && !("Err" in value)) ||
				("Err" in value && !("Ok" in value))),
	);
}

function isRpcErrorPayload(value: unknown): value is RpcErrorPayload {
	if (!value || typeof value !== "object") {
		return false;
	}

	const candidate = value as RpcErrorPayload;
	return (
		typeof candidate.message === "string" ||
		typeof candidate.code === "string" ||
		typeof candidate.code === "number"
	);
}

function normalizeRpcError(error: unknown): Error {
	if (error instanceof RpcClientError) {
		return error;
	}

	if (isRpcErrorPayload(error)) {
		return new RpcClientError(error.message ?? "RPC request failed", {
			code: error.code,
			data: typeof error.data === "object" ? error.data : undefined,
			cause: error,
		});
	}

	if (error instanceof Error) {
		return error;
	}

	return new RpcClientError("Unknown RPC error", { cause: error });
}

function unwrapRpcResult<TValue>(value: TValue): UnwrapRpcResult<TValue> {
	if (!isEnvelope(value)) {
		return value as UnwrapRpcResult<TValue>;
	}

	if ("Ok" in value) {
		return value.Ok as UnwrapRpcResult<TValue>;
	}

	throw normalizeRpcError(value.Err);
}

function toHeaderRecord(headers?: HeadersInit): Record<string, string> {
	if (!headers) {
		return {};
	}

	const normalized: Record<string, string> = {};
	for (const [key, value] of new Headers(headers).entries()) {
		normalized[key] = value;
	}
	return normalized;
}

async function resolveHeaders(
	headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>),
): Promise<Record<string, string>> {
	if (!headers) {
		return {};
	}

	const resolved =
		typeof headers === "function" ? await headers() : await headers;
	return toHeaderRecord(resolved);
}

function createTransportOptions(options: {
	fetch?: RpcFetch;
	headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
}): HttpOptions | undefined {
	if (!options.fetch && !options.headers) {
		return undefined;
	}

	return {
		fetch: (async (url, requestOptions) => {
			const [resolvedHeaders, fetchImpl] = await Promise.all([
				resolveHeaders(options.headers),
				Promise.resolve(options.fetch ?? fetch),
			]);

			const mergedHeaders = {
				...toHeaderRecord(requestOptions?.headers),
				...resolvedHeaders,
			};

			return fetchImpl(url, {
				...requestOptions,
				headers: mergedHeaders,
			});
		}) as typeof fetch,
	};
}

function getLeaf(target: unknown, path: readonly string[]): any {
	let current = target as any;
	for (const segment of path) {
		current = current[segment];
	}
	return current;
}

function buildRpcQueryKey(
	path: readonly string[],
	args: readonly unknown[],
): RpcQueryKey {
	if (args.length === 0) {
		return ["rpc", ...path];
	}

	return ["rpc", ...path, ...args];
}

function createWrappedRpcClient(
	rawClient: ReturnType<typeof createAppRustRpcClient>,
	path: readonly string[] = [],
): AppRpcClient {
	return new Proxy(
		{},
		{
			get(_target, property) {
				if (typeof property !== "string") {
					return undefined;
				}

				if (property === "query") {
					return async (...args: unknown[]) => {
						try {
							return unwrapRpcResult(await getLeaf(rawClient, path).query(...args));
						} catch (error) {
							throw normalizeRpcError(error);
						}
					};
				}

				if (property === "mutate") {
					return async (...args: unknown[]) => {
						try {
							return unwrapRpcResult(await getLeaf(rawClient, path).mutate(...args));
						} catch (error) {
							throw normalizeRpcError(error);
						}
					};
				}

				if (property === "subscribe") {
					const leaf = getLeaf(rawClient, path);
					if (typeof leaf.subscribe !== "function") {
						return undefined;
					}

					return (...args: unknown[]) => leaf.subscribe(...args);
				}

				return createWrappedRpcClient(rawClient, [...path, property]);
			},
		},
	) as AppRpcClient;
}

function createRpcOptionsProxy(
	client: AppRpcClient,
	path: readonly string[] = [],
): AppRpcOptionsProxy {
	return new Proxy(
		{},
		{
			get(_target, property) {
				if (typeof property !== "string") {
					return undefined;
				}

				if (property === "queryKey") {
					return (...args: unknown[]) => buildRpcQueryKey(path, args);
				}

				if (property === "queryOptions") {
					return (...args: unknown[]) =>
						queryOptions({
							queryKey: buildRpcQueryKey(path, args),
							queryFn: () => getLeaf(client, path).query(...args),
						});
				}

				return createRpcOptionsProxy(client, [...path, property]);
			},
		},
	) as AppRpcOptionsProxy;
}

export interface CreateAppRpcClientOptions {
	serverUrl: string;
	fetch?: RpcFetch;
	headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
	endpointPath?: string;
}

export function createAppRpcClient(options: CreateAppRpcClientOptions) {
	const endpointPath = normalizeEndpointPath(
		options.endpointPath ?? DEFAULT_RPC_ENDPOINT_PATH,
	);
	const normalizedServerUrl =
		endpointPath === DEFAULT_RPC_ENDPOINT_PATH
			? options.serverUrl
			: `${options.serverUrl}${endpointPath}`;
	const rawClient = createAppRustRpcClient({
		serverUrl: normalizedServerUrl,
		transportOptions: createTransportOptions({
			fetch: options.fetch,
			headers: options.headers,
		}),
	});

	return createWrappedRpcClient(rawClient);
}

export function createAppRpcOptionsProxy(
	client: AppRpcClient,
	queryClient: QueryClient,
) {
	void queryClient;
	return createRpcOptionsProxy(client);
}