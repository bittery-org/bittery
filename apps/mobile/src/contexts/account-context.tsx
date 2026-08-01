import {
	type AccountSessionManager,
	getAccountSessionManager,
} from "@bittery/core/services/account-session-manager";
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

import {
	type AccountMetadata,
	type ActiveAccount,
	itemCache,
	storage,
} from "@/services/storage";

interface AccountContextValue {
	allAccounts: AccountMetadata[];
	activeAccountConfig: ActiveAccount;
	activeAccount: AccountMetadata | null;
	isLoading: boolean;
	refreshAccounts: () => Promise<void>;
	switchAccount: (accountId: string) => Promise<void>;
	removeAccount: (accountId: string) => Promise<void>;
}

const AccountContext = createContext<AccountContextValue>({
	allAccounts: [],
	activeAccountConfig: null,
	activeAccount: null,
	isLoading: true,
	refreshAccounts: async () => {},
	switchAccount: async () => {},
	removeAccount: async () => {},
});

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

	const managerRef = useRef<AccountSessionManager | null>(null);
	if (!managerRef.current) {
		managerRef.current = getAccountSessionManager({
			storage,
			// Sibling of `storage`, not reachable through it: `removeAccount` has to wipe the
			// account's cached ciphertext as well as its session, and `AccountStore` sits on a
			// `PlatformPort` that cannot see the record store.
			itemCache,
			invalidateQueries: async (keys) => {
				await Promise.all(
					keys.map((key) =>
						queryClientRef.current.invalidateQueries({ queryKey: key }),
					),
				);
			},
		});
	}
	const manager = managerRef.current;

	const [isLoading, setIsLoading] = useState(true);

	useSyncExternalStore(manager.subscribe, manager.getSnapshot);

	useEffect(() => {
		void manager.initialize().finally(() => setIsLoading(false));
	}, [manager]);

	const allAccounts = manager.getAccounts();
	const activeAccountConfig = manager.getActiveAccount();
	const activeAccount = manager.getActiveAccountMetadata();

	const refreshAccounts = useCallback(async () => {
		await manager.refresh();
	}, [manager]);

	const switchAccount = useCallback(
		async (accountId: string) => {
			await manager.switchAccount({ type: "single", accountId });
		},
		[manager],
	);

	const removeAccount = useCallback(
		async (accountId: string) => {
			await manager.removeAccount(accountId);
		},
		[manager],
	);

	return (
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
	);
}
