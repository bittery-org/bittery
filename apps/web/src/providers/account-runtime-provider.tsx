import { ClientRuntime } from "@bittery/core/services/client-runtime";
import type { QueryClient } from "@tanstack/react-query";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useState,
} from "react";
import { itemCache, storage } from "@/lib/storage";
import { vaultRepository } from "@/lib/vault-runtime";

interface AccountRuntimeContextValue {
	runtime: ClientRuntime;
	manager: ClientRuntime["accounts"];
	vaultRuntime: ClientRuntime["vaultRuntime"];
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
	const [runtime] = useState(
		() =>
			new ClientRuntime({
				storage,
				itemCache,
				vaultRepository,
				invalidateQueries: async (keys) => {
					await Promise.all(
						keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
					);
				},
			}),
	);
	const value = {
		runtime,
		manager: runtime.accounts,
		vaultRuntime: runtime.vaultRuntime,
	};

	// Durable browser reads begin only after hydration commits. The server and the
	// first client render therefore share the runtime's inert initial snapshot.
	useEffect(() => {
		runtime.start();
		return () => runtime.dispose();
	}, [runtime]);

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
