import { useAccountSwitcher } from "@bittery/hooks";
import { AccountSwitcher, toast } from "@bittery/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { createExtensionInvalidator } from "@/lib/query-invalidation";
import { storage } from "@/lib/storage";

/**
 * Extension-specific account switcher wrapper
 * Handles navigation and state management for multi-account support
 */
export function ExtensionAccountSwitcher() {
	const {
		accounts,
		activeAccount: activeAccountQuery,
		unlockedEmails,
		switchAccount,
		lockAllAccounts,
	} = useAccountSwitcher();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const invalidator = useMemo(
		() => createExtensionInvalidator(queryClient),
		[queryClient],
	);

	const accountsData = accounts.data ?? [];
	const unlockedEmailsList = unlockedEmails.data ?? [];
	const activeAccountEmail =
		activeAccountQuery.data?.type === "single"
			? activeAccountQuery.data.email
			: null;

	const handleSwitchAccount = async (email: string) => {
		if (email === activeAccountEmail) return;

		try {
			await switchAccount.mutateAsync({ type: "single", email });

			// Check if session is valid for the switched account
			const sessionValid = await storage.isSessionValid(email);
			if (!sessionValid) {
				// Redirect to unlock screen with the account email
				navigate({ to: "/unlock", search: { email } });
			} else {
				// Invalidate account-related data to clear cache from previous account
				await Promise.all([
					invalidator.invalidateVaultKeys(),
					queryClient.invalidateQueries({ queryKey: ["vault-items"] }),
					queryClient.invalidateQueries({ queryKey: ["items-unified"] }),
				]);
				// Reload vault items for the new account
				navigate({ to: "/vault" });
			}
		} catch (error) {
			console.error("Failed to switch account:", error);
			toast.error("Failed to switch account");
		}
	};

	const handleAddAccount = () => {
		// Navigate to login with addingAccount flag
		navigate({ to: "/login", search: { addingAccount: true } });
	};

	const handleLockAll = async () => {
		try {
			await lockAllAccounts.mutateAsync();
			navigate({ to: "/unlock" });
			toast.success("All accounts locked");
		} catch (error) {
			console.error("Failed to lock all accounts:", error);
			toast.error("Failed to lock accounts");
		}
	};

	const handleAllAccountsSelect = async () => {
		// Check if we have any unlocked accounts
		if (unlockedEmailsList.length === 0) {
			toast.error(
				"No accounts are unlocked. Please unlock at least one account.",
			);
			return;
		}

		try {
			await switchAccount.mutateAsync({ type: "all" });
			// Invalidate account-related data to refresh multi-account view
			await Promise.all([
				invalidator.invalidateVaultKeys(),
				queryClient.invalidateQueries({ queryKey: ["vault-items"] }),
				queryClient.invalidateQueries({ queryKey: ["items-unified"] }),
			]);
			navigate({ to: "/vault" });
		} catch (error) {
			console.error("Failed to switch to All Accounts mode:", error);
			toast.error("Failed to switch to All Accounts mode");
		}
	};

	return (
		<AccountSwitcher
			accounts={accountsData}
			activeEmail={activeAccountEmail}
			unlockedEmails={unlockedEmailsList}
			onAccountSelect={handleSwitchAccount}
			onAddAccount={handleAddAccount}
			onLockAll={handleLockAll}
			showAllAccountsOption={true}
			onAllAccountsSelect={handleAllAccountsSelect}
			isLoading={accounts.isLoading || switchAccount.isPending}
		/>
	);
}
