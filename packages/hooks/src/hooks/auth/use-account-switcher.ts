/**
 * useAccountSwitcher Hook
 *
 * React hook for managing multi-account operations:
 * - Get list of all added accounts
 * - Get currently active account
 * - Switch between accounts
 * - Remove accounts from device
 * - Get list of unlocked accounts (with MUKs in memory)
 */

import type { AccountMetadata } from "@bittery/storage/types";
import {
	type UseMutationResult,
	type UseQueryResult,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { usePlatformStorage } from "../../context/platform-context";

/**
 * Options for useAccountSwitcher hook
 */
export interface UseAccountSwitcherOptions {
	/**
	 * Whether to enable the queries.
	 */
	enabled?: boolean;
}

/**
 * Result type for the account switcher hook
 */
export interface UseAccountSwitcherResult {
	/** List of all added accounts */
	accounts: UseQueryResult<AccountMetadata[], Error>;

	/** Currently active account email */
	activeEmail: UseQueryResult<string | null, Error>;

	/** List of unlocked account emails (with MUKs in memory) */
	unlockedEmails: UseQueryResult<string[], Error>;

	/** Mutation to switch to a different account */
	switchAccount: UseMutationResult<void, Error, string, unknown>;

	/** Mutation to remove an account from this device */
	removeAccount: UseMutationResult<void, Error, string, unknown>;

	/** Mutation to lock all accounts (clear all MUKs from memory) */
	lockAllAccounts: UseMutationResult<void, Error, void, unknown>;
}

/**
 * Hook for managing multi-account operations.
 *
 * @param options - Query options
 * @returns Account switcher result with queries and mutations
 *
 * @example
 * ```tsx
 * const { accounts, activeEmail, unlockedEmails, switchAccount, removeAccount } = useAccountSwitcher();
 *
 * // Display account list
 * accounts.data?.map(account => (
 *   <AccountItem
 *     key={account.email}
 *     account={account}
 *     isActive={account.email === activeEmail.data}
 *     isUnlocked={unlockedEmails.data?.includes(account.email)}
 *     onSwitch={() => switchAccount.mutate(account.email)}
 *     onRemove={() => removeAccount.mutate(account.email)}
 *   />
 * ))
 * ```
 */
export function useAccountSwitcher(
	options: UseAccountSwitcherOptions = {},
): UseAccountSwitcherResult {
	const storage = usePlatformStorage();
	const queryClient = useQueryClient();

	// Query: Get list of all accounts
	const accounts = useQuery({
		queryKey: ["accounts", "list"],
		queryFn: async () => {
			return storage.getAccountsList();
		},
		enabled: options.enabled !== false && storage.supportsMultiAccount,
		staleTime: 30 * 1000, // Cache for 30 seconds
	});

	// Query: Get active account email
	const activeEmail = useQuery({
		queryKey: ["accounts", "active"],
		queryFn: async () => {
			return storage.getActiveAccountEmail();
		},
		enabled: options.enabled !== false,
		staleTime: 10 * 1000, // Cache for 10 seconds
	});

	// Query: Get list of unlocked accounts
	const unlockedEmails = useQuery({
		queryKey: ["accounts", "unlocked"],
		queryFn: async () => {
			if (storage.getUnlockedAccounts) {
				return storage.getUnlockedAccounts();
			}
			// Fallback for adapters that don't implement getUnlockedAccounts
			return [];
		},
		enabled: options.enabled !== false && storage.supportsMultiAccount,
		staleTime: 5 * 1000, // Cache for 5 seconds
		refetchInterval: 10 * 1000, // Refetch every 10 seconds to stay in sync
	});

	// Mutation: Switch to a different account
	const switchAccount = useMutation({
		mutationFn: async (email: string) => {
			await storage.setActiveAccount(email);
		},
		onSuccess: () => {
			// Invalidate all account-related queries
			queryClient.invalidateQueries({ queryKey: ["accounts"] });
			queryClient.invalidateQueries({ queryKey: ["auth"] });
			queryClient.invalidateQueries({ queryKey: ["vaults"] });
			queryClient.invalidateQueries({ queryKey: ["items"] });
		},
	});

	// Mutation: Remove an account from this device
	const removeAccount = useMutation({
		mutationFn: async (email: string) => {
			await storage.removeAccount(email);
		},
		onSuccess: () => {
			// Invalidate account-related queries
			queryClient.invalidateQueries({ queryKey: ["accounts"] });
		},
	});

	// Mutation: Lock all accounts (clear all MUKs from memory)
	const lockAllAccounts = useMutation({
		mutationFn: async () => {
			if (storage.lockAllAccounts) {
				await storage.lockAllAccounts();
			} else {
				// Fallback: just clear the current account's MUK
				await storage.clearMasterUnlockKey();
			}
		},
		onSuccess: () => {
			// Invalidate session-related queries
			queryClient.invalidateQueries({ queryKey: ["accounts", "unlocked"] });
			queryClient.invalidateQueries({ queryKey: ["auth", "sessionState"] });
			queryClient.invalidateQueries({ queryKey: ["items"] });
		},
	});

	return {
		accounts,
		activeEmail,
		unlockedEmails,
		switchAccount,
		removeAccount,
		lockAllAccounts,
	};
}
