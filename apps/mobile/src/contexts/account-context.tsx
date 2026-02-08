import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useState,
} from "react";

import {
	type AccountMetadata,
	type ActiveAccount,
	storage,
} from "@/services/storage";

interface AccountContextValue {
	allAccounts: AccountMetadata[];
	activeAccountConfig: ActiveAccount;
	activeAccount: AccountMetadata | null;
	isAllAccountsMode: boolean;
	isLoading: boolean;
	refreshAccounts: () => Promise<void>;
	switchAccount: (email: string) => Promise<void>;
	switchAllAccounts: () => Promise<void>;
	removeAccount: (email: string) => Promise<void>;
}

const AccountContext = createContext<AccountContextValue>({
	allAccounts: [],
	activeAccountConfig: null,
	activeAccount: null,
	isAllAccountsMode: false,
	isLoading: true,
	refreshAccounts: async () => {},
	switchAccount: async () => {},
	switchAllAccounts: async () => {},
	removeAccount: async () => {},
});

export function useAccount() {
	return useContext(AccountContext);
}

interface AccountProviderProps {
	children: ReactNode;
}

export function AccountProvider({ children }: AccountProviderProps) {
	const [allAccounts, setAllAccounts] = useState<AccountMetadata[]>([]);
	const [activeAccountConfig, setActiveAccountConfig] =
		useState<ActiveAccount>(null);
	const [activeAccount, setActiveAccount] = useState<AccountMetadata | null>(
		null,
	);
	const [isLoading, setIsLoading] = useState(true);

	const refreshAccounts = useCallback(async () => {
		try {
			const accountsList = await storage.getAccountsList();
			setAllAccounts(accountsList);

			const activeConfig = await storage.getActiveAccount();
			setActiveAccountConfig(activeConfig);

			if (accountsList.length === 0) {
				setActiveAccount(null);
				if (activeConfig) {
					await storage.setActiveAccount(null);
					setActiveAccountConfig(null);
				}
				return;
			}

			if (activeConfig?.type === "single") {
				const active = accountsList.find(
					(a) => a.email.toLowerCase() === activeConfig.email.toLowerCase(),
				);
				if (active) {
					setActiveAccount(active);
				} else {
					const firstAccount = accountsList[0];
					await storage.setActiveAccount({
						type: "single",
						email: firstAccount.email,
					});
					setActiveAccountConfig({
						type: "single",
						email: firstAccount.email,
					});
					setActiveAccount(firstAccount);
				}
				return;
			}

			if (activeConfig?.type === "all") {
				// Keep all-accounts mode active without forcing a single account
				setActiveAccount(null);
				return;
			}

			// No active account set - default to first account
			const firstAccount = accountsList[0];
			await storage.setActiveAccount({
				type: "single",
				email: firstAccount.email,
			});
			setActiveAccountConfig({ type: "single", email: firstAccount.email });
			setActiveAccount(firstAccount);
		} catch (error) {
			console.error("Error loading accounts:", error);
		} finally {
			setIsLoading(false);
		}
	}, []);

	const switchAccount = useCallback(
		async (email: string) => {
			await storage.setActiveAccount({ type: "single", email });
			await refreshAccounts();
		},
		[refreshAccounts],
	);

	const switchAllAccounts = useCallback(async () => {
		await storage.setActiveAccount({ type: "all" });
		await refreshAccounts();
	}, [refreshAccounts]);

	const removeAccount = useCallback(
		async (email: string) => {
			await storage.clearAccountData(email);

			// If removing the active account, switch to another one
			const remainingAccounts = allAccounts.filter(
				(a) => a.email.toLowerCase() !== email.toLowerCase(),
			);

			if (
				activeAccountConfig?.type === "single" &&
				activeAccountConfig.email.toLowerCase() === email.toLowerCase()
			) {
				if (remainingAccounts.length > 0) {
					await storage.setActiveAccount({
						type: "single",
						email: remainingAccounts[0].email,
					});
				} else {
					await storage.setActiveAccount(null);
				}
			}

			if (
				activeAccountConfig?.type === "all" &&
				remainingAccounts.length === 0
			) {
				await storage.setActiveAccount(null);
			}

			await refreshAccounts();
		},
		[activeAccountConfig, allAccounts, refreshAccounts],
	);

	// Load accounts on mount
	useEffect(() => {
		refreshAccounts();
	}, [refreshAccounts]);

	return (
		<AccountContext.Provider
			value={{
				allAccounts,
				activeAccountConfig,
				activeAccount,
				isAllAccountsMode: activeAccountConfig?.type === "all",
				isLoading,
				refreshAccounts,
				switchAccount,
				switchAllAccounts,
				removeAccount,
			}}
		>
			{children}
		</AccountContext.Provider>
	);
}
