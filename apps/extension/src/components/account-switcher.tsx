import { AccountSwitcher } from "@bittery/ui";
import { useAccountSwitcher } from "@bittery/hooks";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "@bittery/ui";
import { storage } from "@/lib/storage";

/**
 * Extension-specific account switcher wrapper
 * Handles navigation and state management for multi-account support
 */
export function ExtensionAccountSwitcher() {
	const {
		accounts,
		activeEmail,
		unlockedEmails,
		switchAccount,
		lockAllAccounts,
	} = useAccountSwitcher();
	const navigate = useNavigate();

	const accountsData = accounts.data ?? [];
	const unlockedEmailsList = unlockedEmails.data ?? [];

	const handleSwitchAccount = async (email: string) => {
		if (email === activeEmail.data) return;

		try {
			await switchAccount.mutateAsync(email);

			// Check if session is valid for the switched account
			const sessionValid = await storage.isSessionValid(email);
			if (!sessionValid) {
				// Redirect to unlock screen with the account email
				navigate({ to: "/unlock", search: { email } });
			} else {
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

	return (
		<AccountSwitcher
			accounts={accountsData}
			activeEmail={activeEmail.data ?? null}
			unlockedEmails={unlockedEmailsList}
			onAccountSelect={handleSwitchAccount}
			onAddAccount={handleAddAccount}
			onLockAll={handleLockAll}
			isLoading={accounts.isLoading || switchAccount.isPending}
		/>
	);
}
