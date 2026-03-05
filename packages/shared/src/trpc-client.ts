import type { AppRouter } from "@bittery/api/routers/index";
import type { QueryClient } from "@tanstack/react-query";
import {
	createTRPCClient,
	type HTTPHeaders,
	httpBatchLink,
} from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";

type TrpcFetch = (
	url: RequestInfo | URL,
	requestOptions?: RequestInit,
) => Promise<Response>;

interface CreateAppTrpcClientOptions {
	serverUrl: string;
	fetch?: TrpcFetch;
	headers?: HTTPHeaders | (() => HTTPHeaders | Promise<HTTPHeaders>);
}

export function createAppTrpcClient(options: CreateAppTrpcClientOptions) {
	return createTRPCClient<AppRouter>({
		links: [
			httpBatchLink({
				url: `${options.serverUrl}/trpc`,
				fetch: options.fetch,
				headers: options.headers,
			}),
		],
	});
}

export function createAppTrpcOptionsProxy(
	client: ReturnType<typeof createAppTrpcClient>,
	queryClient: QueryClient,
) {
	return createTRPCOptionsProxy({
		client,
		queryClient,
	});
}
