/**
 * Desktop Account Switcher
 * Wrapper around the shared AccountSwitcher component with desktop-specific logic
 */

import { useAccountSwitcher } from "@bittery/core/hooks";
import {
	AccountAvatarGroup,
	Button,
	AccountSwitcher as SharedAccountSwitcher,
	toast,
} from "@bittery/ui";
import { IconChevronDownOutlineDuo18 } from "@bittery/ui/icons";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useAccount } from "@/contexts/account-context";
import { storage } from "@/lib/storage";
import { useI18n } from "@/providers/i18n-provider";
import { useQueryInvalidator } from "@/providers/sync-provider";
import { AccountAvatar } from "./account-avatar";
import { AddAccountDialog } from "./add-account-dialog";
import { DeviceSetupDialog } from "./device-setup-dialog";
import { RemoveAccountDialog } from "./remove-account-dialog";
import { SettingsDialog } from "./settings-dialog";

export function AccountSwitcher() {
	const { m } = useI18n();
	const {
		accounts,
		activeAccount: activeAccountQuery,
		unlockedEmails,
		switchAccount,
		removeAccount,
	} = useAccountSwitcher();
	// Use AccountContext's lockAllAccounts (has broadcast) instead of hook's version
	const { lockAllAccounts: lockAllAccountsWithBroadcast } = useAccount();
	const invalidator = useQueryInvalidator();
	const navigate = useNavigate();
	const [accountToRemove, setAccountToRemove] = useState<string | null>(null);
	const [showSettings, setShowSettings] = useState(false);
	const [showAddAccount, setShowAddAccount] = useState(false);
	const [showDeviceSetup, setShowDeviceSetup] = useState(false);

	const accountsData = accounts.data ?? [];
	const unlockedEmailsList = unlockedEmails.data ?? [];
	const isAllAccountsMode = activeAccountQuery.data?.type === "all";
	const activeAccountEmail =
		activeAccountQuery.data?.type === "single"
			? activeAccountQuery.data.email
			: null;
	const activeAccount = accountsData.find(
		(a) => a.email === activeAccountEmail,
	);

	const handleAccountSelect = async (email: string) => {
		if (email === activeAccountEmail) return;

		try {
			await switchAccount.mutateAsync({ type: "single", email });

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
			toast.error(m["toast.account_switcher.switch_account_failed"]());
		}
	};

	const handleAllAccountsSelect = async () => {
		// Check if we have any unlocked accounts
		if (unlockedEmailsList.length === 0) {
			toast.error(m["toast.account_switcher.no_unlocked_accounts"]());
			return;
		}

		try {
			await switchAccount.mutateAsync({ type: "all" });
			// Invalidate all account-related data to refresh multi-account view
			await invalidator.invalidateAllAccountData();
			navigate({ to: "/vault" });
		} catch (error) {
			console.error("Failed to switch to All Accounts mode:", error);
			toast.error(m["toast.account_switcher.switch_all_accounts_failed"]());
		}
	};

	const handleAddAccount = () => {
		setShowAddAccount(true);
	};

	const handleLockAll = async () => {
		try {
			// Use AccountContext's version which broadcasts to extension
			await lockAllAccountsWithBroadcast();
			navigate({ to: "/unlock" });
			toast.success(m["toast.account_switcher.lock_all_success"]());
		} catch (error) {
			console.error("Failed to lock all accounts:", error);
			toast.error(m["toast.account_switcher.lock_all_failed"]());
		}
	};

	const handleSettings = () => {
		setShowSettings(true);
	};

	const handleSetupAnotherDevice = () => {
		setShowDeviceSetup(true);
	};

	const handleRemoveAccountClick = (email: string) => {
		setAccountToRemove(email);
	};

	const handleRemoveAccount = async (email: string) => {
		try {
			const wasActive =
				activeAccountEmail?.toLowerCase() === email.toLowerCase();

			await removeAccount.mutateAsync(email);

			const accountsList = await storage.getAccountsList();
			if (accountsList.length === 0) {
				// No accounts left — go to login
				await storage.setActiveAccount(null);
				navigate({ to: "/login" });
			} else if (wasActive) {
				// Removed the active account — switch to another one
				const nextAccount = accountsList[0];
				await switchAccount.mutateAsync({
					type: "single",
					email: nextAccount.email,
				});

				const sessionValid = await storage.isSessionValid(nextAccount.email);
				if (!sessionValid) {
					navigate({ to: "/unlock", search: { email: nextAccount.email } });
				} else {
					await invalidator.invalidateAllAccountData();
					navigate({ to: "/vault" });
				}
			}

			toast.success(m["toast.account_switcher.remove_account_success"]());
		} catch (error) {
			console.error("Failed to remove account:", error);
			toast.error(m["toast.account_switcher.remove_account_failed"]());
		} finally {
			setAccountToRemove(null);
		}
	};

	// Custom trigger for desktop
	const trigger = (
		<Button
			variant="ghost"
			size="sm"
			className="w-full justify-start gap-2 text-left"
			disabled={switchAccount.isPending}
		>
			{isAllAccountsMode ? (
				<>
					<AccountAvatarGroup
						accounts={accountsData.filter((a) =>
							unlockedEmailsList.includes(a.email),
						)}
						maxVisible={2}
						size="sm"
					/>
					<div className="flex flex-col items-start overflow-hidden">
						<span className="max-w-24 truncate font-medium text-sm">
							{m["vaults.sidebar.account_switcher.menu.all_accounts"]()}
						</span>
					</div>
				</>
			) : activeAccount ? (
				<>
					<AccountAvatar account={activeAccount} size="sm" />
					<div className="flex flex-col items-start overflow-hidden">
						<span className="max-w-24 truncate font-medium text-sm">
							{activeAccount.teamName ||
								activeAccount.name ||
								activeAccount.email.split("@")[0]}
						</span>
					</div>
				</>
			) : null}
			<IconChevronDownOutlineDuo18 className="ml-auto h-4 w-4 opacity-50" />
		</Button>
	);

	return (
		<>
			<SharedAccountSwitcher
				accounts={accountsData}
				activeEmail={activeAccountEmail}
				unlockedEmails={unlockedEmailsList}
				isLoading={switchAccount.isPending}
				labels={{
					accountsLabel: m["vaults.sidebar.account_switcher.menu.accounts"](),
					noAccountsAdded: m[
						"vaults.sidebar.account_switcher.menu.no_accounts_added"
					](),
					allAccountsLabel: m[
						"vaults.sidebar.account_switcher.menu.all_accounts"
					](),
					viewItemsFromAccounts: ({ count }) =>
						count === 1
							? m[
									"vaults.sidebar.account_switcher.menu.view_items_from_accounts.single"
								]({ count })
							: m[
									"vaults.sidebar.account_switcher.menu.view_items_from_accounts.plural"
								]({ count }),
					addAccountLabel: m[
						"vaults.sidebar.account_switcher.menu.add_account"
					](),
					setupAnotherDeviceLabel: m[
						"vaults.sidebar.account_switcher.menu.setup_another_device"
					](),
					settingsLabel: m["nav.menu.settings"](),
					lockAllAccountsLabel: m[
						"vaults.sidebar.account_switcher.menu.lock_all_accounts"
					](),
					removeAccountLabel: m[
						"vaults.sidebar.account_switcher.menu.remove_account"
					](),
				}}
				onAccountSelect={handleAccountSelect}
				onAddAccount={handleAddAccount}
				onLockAll={handleLockAll}
				showAllAccountsOption={true}
				onAllAccountsSelect={handleAllAccountsSelect}
				showSettings={true}
				onSettings={handleSettings}
				showSetupAnotherDevice={true}
				onSetupAnotherDevice={handleSetupAnotherDevice}
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

			<SettingsDialog open={showSettings} onOpenChange={setShowSettings} />

			<AddAccountDialog
				open={showAddAccount}
				onOpenChange={setShowAddAccount}
			/>

			<DeviceSetupDialog
				open={showDeviceSetup}
				onOpenChange={setShowDeviceSetup}
				accounts={accountsData}
				initialAccountEmail={activeAccountEmail}
			/>
		</>
	);
}
