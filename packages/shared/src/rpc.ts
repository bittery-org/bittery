import type { QueryClient } from "@tanstack/react-query";
import {
	createElement,
	createContext,
	useContext,
	useMemo,
	type PropsWithChildren,
} from "react";
import {
	createAppRpcOptionsProxy,
	type AppRpcClient,
	type AppRpcOptionsProxy,
} from "./rpc-client";

const RpcClientContext = createContext<AppRpcClient | null>(null);
const RpcOptionsContext = createContext<AppRpcOptionsProxy | null>(null);

export interface RpcProviderProps extends PropsWithChildren {
	rpcClient: AppRpcClient;
	queryClient: QueryClient;
}

export function RpcProvider({
	rpcClient,
	queryClient,
	children,
}: RpcProviderProps) {
	const rpc = useMemo(
		() => createAppRpcOptionsProxy(rpcClient, queryClient),
		[rpcClient, queryClient],
	);

	return createElement(
		RpcClientContext.Provider,
		{ value: rpcClient },
		createElement(RpcOptionsContext.Provider, { value: rpc }, children),
	);
}

export function useRPC() {
	const rpc = useContext(RpcOptionsContext);
	if (!rpc) {
		throw new Error("useRPC must be used within RpcProvider");
	}
	return rpc;
}

export function useRPCClient() {
	const rpcClient = useContext(RpcClientContext);
	if (!rpcClient) {
		throw new Error("useRPCClient must be used within RpcProvider");
	}
	return rpcClient;
}