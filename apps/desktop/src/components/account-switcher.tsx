/**
 * Desktop Account Switcher
 * Wrapper around the shared AccountSwitcher component with desktop-specific logic
 */

import { useAccountSwitcher } from "@bittery/hooks";
import {
	Button,
	AccountSwitcher as SharedAccountSwitcher,
	toast,
} from "@bittery/ui";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDown, Users } from "lucide-react";
import { useState } from "react";
import { storage } from "@/lib/storage";
import { useQueryInvalidator } from "@/providers/sync-provider";
import { AccountAvatar } from "./account-avatar";
import { AccountSettingsDialog } from "./account-settings-dialog";
import { RemoveAccountDialog } from "./remove-account-dialog";

export function AccountSwitcher() {
	const {
		accounts,
		activeEmail,
		unlockedEmails,
		switchAccount,
		removeAccount,
		lockAllAccounts,
	} = useAccountSwitcher();
	const invalidator = useQueryInvalidator();
	const navigate = useNavigate();
	const [accountToRemove, setAccountToRemove] = useState<string | null>(null);
	const [showSettings, setShowSettings] = useState(false);

	const accountsData = accounts.data ?? [];
	const unlockedEmailsList = unlockedEmails.data ?? [];
	const isAllAccountsMode = activeEmail.data === "all";
	const activeAccount = accountsData.find((a) => a.email === activeEmail.data);

	const handleAccountSelect = async (email: string) => {
		if (email === activeEmail.data) return;

		try {
			await switchAccount.mutateAsync(email);

			// Check if session is valid for the switched account
			const sessionValid = await storage.isSessionValid(email);
			if (!sessionValid) {
				navigate({ to: "/unlock", search: { email } });
			} else {
				// Invalidate all account-related data to clear cache from previous account
				await invalidator.invalidateAllAccountData();
				navigate({ to: "/vault" });
			}
		} catch (error) {
			console.error("Failed to switch account:", error);
			toast.error("Failed to switch account");
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
			await switchAccount.mutateAsync("all");
			// Invalidate all account-related data to refresh multi-account view
			await invalidator.invalidateAllAccountData();
			navigate({ to: "/vault" });
		} catch (error) {
			console.error("Failed to switch to All Accounts mode:", error);
			toast.error("Failed to switch to All Accounts mode");
		}
	};

	const handleAddAccount = () => {
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

	const handleAccountSettings = (_email: string) => {
		setShowSettings(true);
	};

	const handleRemoveAccountClick = (email: string) => {
		setAccountToRemove(email);
	};

	const handleRemoveAccount = async (email: string) => {
		try {
			await removeAccount.mutateAsync(email);

			// Check if there are any accounts left
			const accountsList = await storage.getAccountsList();
			if (accountsList.length === 0) {
				navigate({ to: "/login" });
			}

			toast.success("Account removed");
		} catch (error) {
			console.error("Failed to remove account:", error);
			toast.error("Failed to remove account");
		} finally {
			setAccountToRemove(null);
		}
	};

	// Custom trigger for desktop
	const trigger = (
		<Button
			variant="ghost"
			size="sm"
			className="gap-2"
			disabled={switchAccount.isPending}
		>
			{isAllAccountsMode ? (
				<>
					<div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10">
						<Users className="h-4 w-4 text-primary" />
					</div>
					<div className="flex flex-col items-start overflow-hidden">
						<span className="max-w-32 truncate font-medium text-sm">
							All Accounts
						</span>
						<span className="text-muted-foreground text-xs">
							{unlockedEmailsList.length} unlocked
						</span>
					</div>
				</>
			) : activeAccount ? (
				<>
					<AccountAvatar account={activeAccount} size="sm" />
					<div className="flex flex-col items-start overflow-hidden">
						<span className="max-w-32 truncate font-medium text-sm">
							{activeAccount.teamName ||
								activeAccount.name ||
								activeAccount.email.split("@")[0]}
						</span>
					</div>
				</>
			) : null}
			<ChevronDown className="h-4 w-4 opacity-50" />
		</Button>
	);

	return (
		<>
			<SharedAccountSwitcher
				accounts={accountsData}
				activeEmail={activeEmail.data ?? null}
				unlockedEmails={unlockedEmailsList}
				isLoading={switchAccount.isPending}
				onAccountSelect={handleAccountSelect}
				onAddAccount={handleAddAccount}
				onLockAll={handleLockAll}
				showAllAccountsOption={true}
				onAllAccountsSelect={handleAllAccountsSelect}
				showAccountSettings={true}
				onAccountSettings={handleAccountSettings}
				showRemoveAccount={true}
				onRemoveAccount={handleRemoveAccountClick}
				trigger={trigger}
				align="start"
			/>

			<RemoveAccountDialog
				email={accountToRemove}
				onConfirm={handleRemoveAccount}
				onCancel={() => setAccountToRemove(null)}
			/>

			{activeAccount && (
				<AccountSettingsDialog
					open={showSettings}
					onOpenChange={setShowSettings}
					email={activeAccount.email}
				/>
			)}
		</>
	);
}
