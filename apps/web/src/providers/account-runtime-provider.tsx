import {
	type AccountSessionManager,
	getAccountSessionManager,
	peekAccountSessionManager,
} from "@bittery/core/services/account-session-manager";
import type { AccountVaultRuntime } from "@bittery/core/services/account-vault-runtime";
import type { QueryClient } from "@tanstack/react-query";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
} from "react";
import { itemCache, storage } from "@/lib/storage";
import { getWebVaultRuntime } from "@/lib/vault-runtime";

interface AccountRuntimeContextValue {
	manager: AccountSessionManager;
	vaultRuntime: AccountVaultRuntime;
}

const AccountRuntimeContext = createContext<AccountRuntimeContextValue | null>(
	null,
);

function BrowserAccountRuntimeProvider({
	children,
	queryClient,
}: {
	children: ReactNode;
	queryClient: QueryClient;
}) {
	const value = useMemo(() => {
		const manager =
			peekAccountSessionManager() ??
			getAccountSessionManager({
				storage,
				itemCache,
				invalidateQueries: async (keys) => {
					await Promise.all(
						keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
					);
				},
			});
		return { manager, vaultRuntime: getWebVaultRuntime(manager) };
	}, [queryClient]);

	// Durable browser reads begin only after hydration commits. The server and the
	// first client render therefore share the runtime's inert initial snapshot.
	useEffect(() => value.vaultRuntime.start(), [value]);

	return (
		<AccountRuntimeContext.Provider value={value}>
			{children}
		</AccountRuntimeContext.Provider>
	);
}

/** Owns the browser process runtime and supplies an inert projection during SSR. */
export function AccountRuntimeProvider(props: {
	children: ReactNode;
	queryClient: QueryClient;
}) {
	return <BrowserAccountRuntimeProvider {...props} />;
}

export function useAccountRuntime(): AccountRuntimeContextValue {
	const value = useContext(AccountRuntimeContext);
	if (!value)
		throw new Error("useAccountRuntime requires AccountRuntimeProvider");
	return value;
}
