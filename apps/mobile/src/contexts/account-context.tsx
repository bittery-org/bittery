import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useState,
} from "react";

import { type AccountMetadata, storage } from "@/services/storage";

interface AccountContextValue {
	allAccounts: AccountMetadata[];
	activeAccount: AccountMetadata | null;
	isLoading: boolean;
	refreshAccounts: () => Promise<void>;
	switchAccount: (email: string) => Promise<void>;
	removeAccount: (email: string) => Promise<void>;
}

const AccountContext = createContext<AccountContextValue>({
	allAccounts: [],
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
	const [allAccounts, setAllAccounts] = useState<AccountMetadata[]>([]);
	const [activeAccount, setActiveAccount] = useState<AccountMetadata | null>(
		null,
	);
	const [isLoading, setIsLoading] = useState(true);

	const refreshAccounts = useCallback(async () => {
		try {
			const accountsList = await storage.getAccountsList();
			setAllAccounts(accountsList);

			const activeAccount = await storage.getActiveAccount();
			if (activeAccount?.type === "single") {
				const active = accountsList.find(
					(a) => a.email.toLowerCase() === activeAccount.email.toLowerCase(),
				);
				setActiveAccount(active || null);
			} else if (accountsList.length > 0) {
				// Set the first account as active if none is set
				const firstAccount = accountsList[0];
				await storage.setActiveAccount({
					type: "single",
					email: firstAccount.email,
				});
				setActiveAccount(firstAccount);
			} else {
				setActiveAccount(null);
			}
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

	const removeAccount = useCallback(
		async (email: string) => {
			await storage.clearAccountData(email);

			// If removing the active account, switch to another one
			if (activeAccount?.email.toLowerCase() === email.toLowerCase()) {
				const remainingAccounts = allAccounts.filter(
					(a) => a.email.toLowerCase() !== email.toLowerCase(),
				);
				if (remainingAccounts.length > 0) {
					await storage.setActiveAccount({
						type: "single",
						email: remainingAccounts[0].email,
					});
				}
			}

			await refreshAccounts();
		},
		[activeAccount, allAccounts, refreshAccounts],
	);

	// Load accounts on mount
	useEffect(() => {
		refreshAccounts();
	}, [refreshAccounts]);

	return (
		<AccountContext.Provider
			value={{
				allAccounts,
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
