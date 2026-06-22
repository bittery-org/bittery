/**
 * Desktop Account Switcher
 * Wrapper around the shared AccountSwitcher component with desktop-specific logic
 */

import { useAccountSwitcher } from "@bittery/core/hooks";
import {
	AccountAvatarGroup,
	Badge,
	Button,
	cn,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	ScrollArea,
	AccountSwitcher as SharedAccountSwitcher,
	toast,
} from "@bittery/ui";
import { IconChevronDownOutlineDuo18 } from "@bittery/ui/icons";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
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
	const { m, locale } = useI18n();
	const {
		accounts,
		activeAccount: activeAccountQuery,
		unlockedAccountIds,
		switchAccount,
		removeAccount,
	} = useAccountSwitcher();
	const { lockAllAccounts: lockAllAccountsWithBroadcast } = useAccount();
	const invalidator = useQueryInvalidator();
	const navigate = useNavigate();
	const [accountToRemove, setAccountToRemove] = useState<string | null>(null);
	const [showSettings, setShowSettings] = useState(false);
	const [showAddAccount, setShowAddAccount] = useState(false);
	const [showDeviceSetup, setShowDeviceSetup] = useState(false);
	const [showManageAccounts, setShowManageAccounts] = useState(false);

	const accountsData = accounts.data ?? [];
	const unlockedAccountIdsList = unlockedAccountIds.data ?? [];
	const isAllAccountsMode = activeAccountQuery.data?.type === "all";
	const activeAccountId =
		activeAccountQuery.data?.type === "single"
			? activeAccountQuery.data.accountId
			: null;
	const activeAccount = accountsData.find(
		(a) => a.accountId === activeAccountId,
	);
	const activeAccountEmail = activeAccount?.email ?? null;

	const accountEmailById = useMemo(
		() =>
			new Map(
				accountsData.map((account) => [account.accountId, account.email]),
			),
		[accountsData],
	);

	const unlockedEmailsList = useMemo(
		() =>
			unlockedAccountIdsList
				.map((accountId) => accountEmailById.get(accountId))
				.filter((email): email is string => Boolean(email)),
		[accountEmailById, unlockedAccountIdsList],
	);

	const dateTimeFormatter = useMemo(
		() =>
			new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-US", {
				dateStyle: "medium",
				timeStyle: "short",
			}),
		[locale],
	);

	const formatTimestamp = (value?: number) => {
		if (!value || Number.isNaN(value)) {
			return "—";
		}
		return dateTimeFormatter.format(value);
	};

	const handleAccountSelect = async (accountId: string) => {
		if (accountId === activeAccountId) return;

		const account = accountsData.find((item) => item.accountId === accountId);
		if (!account) return;

		try {
			await switchAccount.mutateAsync({ type: "single", accountId });

			const sessionValid = await storage.isSessionValid(accountId);
			if (!sessionValid) {
				navigate({ to: "/unlock", search: { email: account.email } });
			} else {
				await invalidator.invalidateAllAccountData();
				navigate({ to: "/vault" });
			}
		} catch (error) {
			console.error("Failed to switch account:", error);
			toast.error(m.toast_account_switcher_switch_account_failed());
		}
	};

	const handleAllAccountsSelect = async () => {
		if (unlockedAccountIdsList.length === 0) {
			toast.error(m.toast_account_switcher_no_unlocked_accounts());
			return;
		}

		try {
			await switchAccount.mutateAsync({ type: "all" });
			await invalidator.invalidateAllAccountData();
			navigate({ to: "/vault" });
		} catch (error) {
			console.error("Failed to switch to All Accounts mode:", error);
			toast.error(m.toast_account_switcher_switch_all_accounts_failed());
		}
	};

	const handleAddAccount = () => {
		setShowAddAccount(true);
	};

	const handleAddAccountFromManageDialog = () => {
		setShowAddAccount(true);
	};

	const handleLockAll = async () => {
		try {
			await lockAllAccountsWithBroadcast();
			navigate({ to: "/unlock" });
			toast.success(m.toast_account_switcher_lock_all_success());
		} catch (error) {
			console.error("Failed to lock all accounts:", error);
			toast.error(m.toast_account_switcher_lock_all_failed());
		}
	};

	const handleSettings = () => {
		setShowSettings(true);
	};

	const handleSetupAnotherDevice = () => {
		setShowDeviceSetup(true);
	};

	const handleManageAccounts = () => {
		setShowManageAccounts(true);
	};

	const handleRemoveAccountClick = (accountId: string) => {
		setAccountToRemove(accountId);
	};

	const handleRemoveAccount = async (accountId: string) => {
		try {
			const wasActive = activeAccountId === accountId;

			await removeAccount.mutateAsync(accountId);

			const accountsList = await storage.getAccountsList();
			if (accountsList.length === 0) {
				await storage.setActiveAccount(null);
				navigate({ to: "/login" });
			} else if (wasActive) {
				const nextAccount = accountsList[0];
				await switchAccount.mutateAsync({
					type: "single",
					accountId: nextAccount.accountId,
				});

				const sessionValid = await storage.isSessionValid(
					nextAccount.accountId,
				);
				if (!sessionValid) {
					navigate({
						to: "/unlock",
						search: { email: nextAccount.email },
					});
				} else {
					await invalidator.invalidateAllAccountData();
					navigate({ to: "/vault" });
				}
			}

			toast.success(m.toast_account_switcher_remove_account_success());
		} catch (error) {
			console.error("Failed to remove account:", error);
			toast.error(m.toast_account_switcher_remove_account_failed());
		} finally {
			setAccountToRemove(null);
		}
	};

	const handleAccountSelectFromManageDialog = (accountId: string) => {
		setShowManageAccounts(false);
		void handleAccountSelect(accountId);
	};

	const handleSharedAccountSelect = (email: string) => {
		const account = accountsData.find(
			(item) => item.email.toLowerCase() === email.toLowerCase(),
		);
		if (account) {
			void handleAccountSelect(account.accountId);
		}
	};

	const handleSharedRemoveAccountClick = (email: string) => {
		const account = accountsData.find(
			(item) => item.email.toLowerCase() === email.toLowerCase(),
		);
		if (account) {
			handleRemoveAccountClick(account.accountId);
		}
	};

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
							unlockedAccountIdsList.includes(a.accountId),
						)}
						maxVisible={2}
						size="sm"
					/>
					<div className="flex flex-col items-start overflow-hidden">
						<span className="max-w-24 truncate font-medium text-sm">
							{m.vaults_sidebar_account_switcher_menu_all_accounts()}
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

	const removeAccountEmail = accountToRemove
		? (accountEmailById.get(accountToRemove) ?? null)
		: null;

	return (
		<>
			<SharedAccountSwitcher
				accounts={accountsData}
				activeEmail={activeAccountEmail}
				unlockedEmails={unlockedEmailsList}
				isLoading={switchAccount.isPending}
				labels={{
					accountsLabel: m.vaults_sidebar_account_switcher_menu_accounts(),
					noAccountsAdded:
						m.vaults_sidebar_account_switcher_menu_no_accounts_added(),
					allAccountsLabel:
						m.vaults_sidebar_account_switcher_menu_all_accounts(),
					viewItemsFromAccounts: ({ count }) =>
						count === 1
							? m.vaults_sidebar_account_switcher_menu_view_items_from_accounts_single(
									{ count },
								)
							: m.vaults_sidebar_account_switcher_menu_view_items_from_accounts_plural(
									{ count },
								),
					addAccountLabel: m.vaults_sidebar_account_switcher_menu_add_account(),
					setupAnotherDeviceLabel:
						m.vaults_sidebar_account_switcher_menu_setup_another_device(),
					settingsLabel: m.nav_menu_settings(),
					lockAllAccountsLabel:
						m.vaults_sidebar_account_switcher_menu_lock_all_accounts(),
					removeAccountLabel:
						m.vaults_sidebar_account_switcher_menu_remove_account(),
					manageAccountsLabel:
						m.vaults_sidebar_account_switcher_manage_accounts_title(),
				}}
				onAccountSelect={handleSharedAccountSelect}
				onAddAccount={handleAddAccount}
				onLockAll={handleLockAll}
				showManageAccounts={true}
				onManageAccounts={handleManageAccounts}
				showAddAccount={false}
				showAllAccountsOption={true}
				onAllAccountsSelect={handleAllAccountsSelect}
				showSettings={true}
				onSettings={handleSettings}
				showSetupAnotherDevice={true}
				onSetupAnotherDevice={handleSetupAnotherDevice}
				showRemoveAccount={true}
				onRemoveAccount={handleSharedRemoveAccountClick}
				trigger={trigger}
				align="start"
			/>

			<Dialog open={showManageAccounts} onOpenChange={setShowManageAccounts}>
				<DialogContent className="max-w-2xl overflow-hidden p-0">
					<DialogHeader className="gap-3 border-b bg-background px-6 py-5">
						<div className="flex flex-wrap items-start justify-between gap-3">
							<div className="space-y-1">
								<DialogTitle>
									{m.vaults_sidebar_account_switcher_manage_accounts_title()}
								</DialogTitle>
								<DialogDescription>
									{m.vaults_sidebar_account_switcher_manage_accounts_description()}
								</DialogDescription>
							</div>
							<Button size="sm" onClick={handleAddAccountFromManageDialog}>
								{m.vaults_sidebar_account_switcher_menu_add_account()}
							</Button>
						</div>
					</DialogHeader>

					<div className="px-6 py-4">
						{accountsData.length === 0 ? (
							<div className="rounded-xl border border-dashed px-4 py-8 text-center text-muted-foreground text-sm">
								{m.vaults_sidebar_account_switcher_manage_accounts_empty()}
							</div>
						) : (
							<ScrollArea className="max-h-[420px] pr-4">
								<div className="space-y-3 pb-1">
									{accountsData.map((account) => {
										const isActive = activeAccountId === account.accountId;
										const isUnlocked = unlockedAccountIdsList.includes(
											account.accountId,
										);
										const accountDisplayName =
											account.teamName ||
											account.name ||
											account.email.split("@")[0];

										return (
											<div
												key={account.accountId}
												className={cn(
													"rounded-xl border bg-card/70 p-4 shadow-xs transition-colors",
													isActive && "border-primary/40 bg-primary/5",
												)}
											>
												<div className="flex items-start gap-3">
													<AccountAvatar account={account} size="md" />

													<div className="min-w-0 flex-1 space-y-1">
														<div className="flex flex-wrap items-center gap-1.5">
															<span className="truncate font-medium text-sm">
																{accountDisplayName}
															</span>
															{isActive && (
																<Badge className="h-5 px-2 font-semibold text-[10px] uppercase tracking-wide">
																	{m.vaults_sidebar_account_switcher_badge_active()}
																</Badge>
															)}
															<Badge
																variant={isUnlocked ? "secondary" : "outline"}
																className={cn(
																	"h-5 px-2 font-semibold text-[10px] uppercase tracking-wide",
																	isUnlocked &&
																		"border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
																)}
															>
																{isUnlocked
																	? m.vaults_sidebar_account_switcher_badge_unlocked()
																	: m.vaults_sidebar_account_switcher_badge_locked()}
															</Badge>
														</div>
														<p className="truncate text-muted-foreground text-xs">
															{account.email}
														</p>
													</div>

													{!isActive && (
														<Button
															size="sm"
															variant="outline"
															onClick={() =>
																handleAccountSelectFromManageDialog(
																	account.accountId,
																)
															}
															disabled={switchAccount.isPending}
														>
															{m.vaults_sidebar_account_switcher_action_switch()}
														</Button>
													)}
												</div>

												<div className="mt-3 grid gap-1.5 rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5 text-xs">
													{account.teamName && (
														<div className="flex items-center justify-between gap-2">
															<span className="text-muted-foreground">
																{m.vaults_sidebar_account_switcher_label_team()}
															</span>
															<span className="max-w-[220px] truncate font-medium">
																{account.teamName}
															</span>
														</div>
													)}
													<div className="flex items-center justify-between gap-2">
														<span className="text-muted-foreground">
															{m.vaults_sidebar_account_switcher_label_user_id()}
														</span>
														<span className="max-w-[220px] truncate font-mono text-[11px]">
															{account.userId}
														</span>
													</div>
													{"secretKeyHint" in account && (
														<div className="flex items-center justify-between gap-2">
															<span className="text-muted-foreground">
																{m.vaults_sidebar_account_switcher_label_secret_key_hint()}
															</span>
															<span className="font-mono text-[11px]">
																{account.secretKeyHint || "—"}
															</span>
														</div>
													)}
													{"addedAt" in account && (
														<div className="flex items-center justify-between gap-2">
															<span className="text-muted-foreground">
																{m.vaults_sidebar_account_switcher_label_added()}
															</span>
															<span>{formatTimestamp(account.addedAt)}</span>
														</div>
													)}
													{"lastActiveAt" in account && (
														<div className="flex items-center justify-between gap-2">
															<span className="text-muted-foreground">
																{m.vaults_sidebar_account_switcher_label_last_active()}
															</span>
															<span>
																{formatTimestamp(account.lastActiveAt)}
															</span>
														</div>
													)}
												</div>
											</div>
										);
									})}
								</div>
							</ScrollArea>
						)}
					</div>
				</DialogContent>
			</Dialog>

			<RemoveAccountDialog
				email={removeAccountEmail}
				onConfirm={(email) => {
					const account = accountsData.find(
						(item) => item.email.toLowerCase() === email.toLowerCase(),
					);
					if (account) {
						void handleRemoveAccount(account.accountId);
					}
				}}
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
