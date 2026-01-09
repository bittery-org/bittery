import type { AccountMetadata } from "@bittery/crypto/storage-tauri";
import * as tauriStorage from "@bittery/crypto/storage-tauri";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useState,
} from "react";

interface AccountContextValue {
	activeAccount: AccountMetadata | null;
	allAccounts: AccountMetadata[];
	switchAccount: (email: string) => Promise<void>;
	addAccount: (account: AccountMetadata) => Promise<void>;
	removeAccount: (email: string) => Promise<void>;
	lockAccount: (email: string) => Promise<void>;
	lockAllAccounts: () => Promise<void>;
	refreshAccounts: () => Promise<void>;
	isLoading: boolean;
}

const AccountContext = createContext<AccountContextValue | null>(null);

export function AccountProvider({ children }: { children: ReactNode }) {
	const [activeAccount, setActiveAccount] = useState<AccountMetadata | null>(
		null,
	);
	const [allAccounts, setAllAccounts] = useState<AccountMetadata[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const queryClient = useQueryClient();

	// Load accounts on mount
	const refreshAccounts = useCallback(async () => {
		try {
			const accountsList = await tauriStorage.getAccountsList();
			setAllAccounts(accountsList.accounts);

			const activeEmail = await tauriStorage.getActiveAccountEmail();
			if (activeEmail) {
				const active = accountsList.accounts.find(
					(a) => a.email.toLowerCase() === activeEmail.toLowerCase(),
				);
				setActiveAccount(active ?? null);
			} else if (accountsList.accounts.length > 0) {
				// No active account set, use first one
				const firstAccount = accountsList.accounts[0];
				await tauriStorage.setActiveAccount(firstAccount.email);
				setActiveAccount(firstAccount);
			} else {
				setActiveAccount(null);
			}
		} catch (error) {
			console.error("[AccountContext] Failed to load accounts:", error);
		} finally {
			setIsLoading(false);
		}
	}, []);

	useEffect(() => {
		refreshAccounts();
	}, [refreshAccounts]);

	const switchAccount = useCallback(
		async (email: string) => {
			const targetAccount = allAccounts.find(
				(a) => a.email.toLowerCase() === email.toLowerCase(),
			);
			if (!targetAccount) {
				throw new Error("Account not found");
			}

			// Check if target account session is valid
			const sessionValid = await tauriStorage.isSessionValid(email);

			// Clear current account's in-memory cache
			if (activeAccount) {
				await tauriStorage.clearSession(activeAccount.email);
			}

			// Set new active account
			await tauriStorage.setActiveAccount(email);
			setActiveAccount(targetAccount);

			// Invalidate all React Query queries to refetch with new account
			await queryClient.cancelQueries();
			queryClient.clear();

			// If session is not valid, the route guards will redirect to unlock
			if (!sessionValid) {
				// Session expired, will be handled by route guards
				return;
			}

			// Try to restore session for new account
			const restored = await tauriStorage.tryRestoreSession(true, email);
			if (!restored) {
				// Session restore failed, will be handled by route guards
				return;
			}
		},
		[activeAccount, allAccounts, queryClient],
	);

	const addAccount = useCallback(
		async (account: AccountMetadata) => {
			await tauriStorage.addAccountToList(account);
			await refreshAccounts();
		},
		[refreshAccounts],
	);

	const removeAccount = useCallback(
		async (email: string) => {
			const isActive =
				activeAccount?.email.toLowerCase() === email.toLowerCase();

			// Clear all data for this account
			await tauriStorage.clearAccountData(email);

			// Refresh accounts list
			await refreshAccounts();

			// If we removed the active account, switch to another if available
			if (isActive) {
				const accountsList = await tauriStorage.getAccountsList();
				if (accountsList.accounts.length > 0) {
					await switchAccount(accountsList.accounts[0].email);
				} else {
					setActiveAccount(null);
				}
			}
		},
		[activeAccount, refreshAccounts, switchAccount],
	);

	const lockAccount = useCallback(
		async (email: string) => {
			// Clear in-memory crypto materials for this account
			await tauriStorage.clearSession(email);

			// If locking active account, will need to re-authenticate
			if (activeAccount?.email.toLowerCase() === email.toLowerCase()) {
				await queryClient.cancelQueries();
				queryClient.clear();
			}
		},
		[activeAccount, queryClient],
	);

	const lockAllAccounts = useCallback(async () => {
		// Clear all in-memory caches
		tauriStorage.lockAllAccounts();

		// Cancel and clear all queries
		await queryClient.cancelQueries();
		queryClient.clear();
	}, [queryClient]);

	return (
		<AccountContext.Provider
			value={{
				activeAccount,
				allAccounts,
				switchAccount,
				addAccount,
				removeAccount,
				lockAccount,
				lockAllAccounts,
				refreshAccounts,
				isLoading,
			}}
		>
			{children}
		</AccountContext.Provider>
	);
}

export function useAccount(): AccountContextValue {
	const context = useContext(AccountContext);
	if (!context) {
		throw new Error("useAccount must be used within an AccountProvider");
	}
	return context;
}

export function useOptionalAccount(): AccountContextValue | null {
	return useContext(AccountContext);
}
