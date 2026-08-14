import type { LifecycleOutcome } from "@bittery/core/services/account-lifecycle";
import type { AccountSessionManager } from "@bittery/core/services/account-session-manager";
import type { AccountVaultRuntime } from "@bittery/core/services/account-vault-runtime";
import { ClientRuntime } from "@bittery/core/services/client-runtime";
import { useQueryClient } from "@tanstack/react-query";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";

import { lifecycleDeps } from "@/services/lifecycle";
import {
	type AccountMetadata,
	type ActiveAccountId,
	itemCache,
	storage,
} from "@/services/storage";
import { vaultRepository } from "@/services/vault-runtime";

interface AccountContextValue {
	allAccounts: AccountMetadata[];
	activeAccountConfig: ActiveAccountId;
	activeAccount: AccountMetadata | null;
	isLoading: boolean;
	refreshAccounts: () => Promise<void>;
	switchAccount: (accountId: string) => Promise<void>;
	removeAccount: (accountId: string) => Promise<LifecycleOutcome>;
}

/** Outside a provider nothing was removed, so the outcome reports an untouched device. */
const NOTHING_REMOVED: LifecycleOutcome = {
	affected: [],
	activeAccountId: undefined,
	activeAccount: null,
	wasActive: false,
	remaining: [],
	failures: [],
};

const AccountContext = createContext<AccountContextValue>({
	allAccounts: [],
	activeAccountConfig: null,
	activeAccount: null,
	isLoading: true,
	refreshAccounts: async () => {},
	switchAccount: async () => {},
	removeAccount: async () => NOTHING_REMOVED,
});
const AccountRuntimeContext = createContext<{
	manager: AccountSessionManager;
	vaultRuntime: AccountVaultRuntime;
} | null>(null);

export function useAccount() {
	return useContext(AccountContext);
}

interface AccountProviderProps {
	children: ReactNode;
}

export function AccountProvider({ children }: AccountProviderProps) {
	const queryClient = useQueryClient();
	const queryClientRef = useRef(queryClient);
	queryClientRef.current = queryClient;

	const runtimeRef = useRef<ClientRuntime | null>(null);
	if (!runtimeRef.current) {
		runtimeRef.current = new ClientRuntime({
			storage,
			// Sibling of `storage`, not reachable through it: `removeAccount` has to wipe the
			// account's cached ciphertext as well as its session, and `AccountStore` sits on a
			// `PlatformPort` that cannot see the record store.
			itemCache,
			vaultRepository,
			// Removals routed through the manager must drop the native autofill MUK mirror
			// too, otherwise autofill outlives the account it belonged to.
			credentialMirror: lifecycleDeps.credentialMirror,
			invalidateQueries: async (keys) => {
				await Promise.all(
					keys.map((key) =>
						queryClientRef.current.invalidateQueries({ queryKey: key }),
					),
				);
			},
		});
	}
	const runtime = runtimeRef.current;
	const manager = runtime.accounts;
	const vaultRuntime = runtime.vaultRuntime;

	const [isLoading, setIsLoading] = useState(true);

	useSyncExternalStore(manager.subscribe, manager.getSnapshot);

	useEffect(() => {
		runtime.start();
		void manager.initialize().finally(() => setIsLoading(false));
		return () => runtime.dispose();
	}, [manager, runtime]);

	const allAccounts = manager.getAccounts();
	const activeAccountConfig = manager.getActiveAccount();
	const activeAccount = manager.getActiveAccountMetadata();

	const refreshAccounts = useCallback(async () => {
		await manager.refresh();
	}, [manager]);

	const switchAccount = useCallback(
		async (accountId: string) => {
			await manager.switchAccount(accountId);
		},
		[manager],
	);

	const removeAccount = useCallback(
		async (accountId: string) => manager.removeAccount(accountId),
		[manager],
	);

	return (
		<AccountRuntimeContext.Provider value={{ manager, vaultRuntime }}>
			<AccountContext.Provider
				value={{
					allAccounts,
					activeAccountConfig,
					activeAccount,
					isLoading,
					refreshAccounts,
					switchAccount,
					removeAccount,
				}}
			>
				{children}
			</AccountContext.Provider>
		</AccountRuntimeContext.Provider>
	);
}

export function useMobileAccountRuntime() {
	const value = useContext(AccountRuntimeContext);
	if (!value) throw new Error("AccountProvider must own the mobile runtime");
	return value;
}
