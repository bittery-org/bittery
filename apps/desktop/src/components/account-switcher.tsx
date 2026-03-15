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
	const { m, locale } = useI18n();
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
	const [showManageAccounts, setShowManageAccounts] = useState(false);

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
	const isGerman = locale === "de";
	const manageAccountsLabel = isGerman ? "Konten verwalten" : "Manage Accounts";
	const manageAccountsDescription = isGerman
		? "Alle Konten auf diesem Gerät anzeigen, Details prüfen und neue Konten hinzufügen."
		: "View every account on this device, review details, and add new ones.";
	const activeBadgeLabel = isGerman ? "Aktiv" : "Active";
	const unlockedBadgeLabel = isGerman ? "Entsperrt" : "Unlocked";
	const lockedBadgeLabel = isGerman ? "Gesperrt" : "Locked";
	const userIdLabel = isGerman ? "Benutzer-ID" : "User ID";
	const addedLabel = isGerman ? "Hinzugefügt" : "Added";
	const lastActiveLabel = isGerman ? "Zuletzt aktiv" : "Last active";
	const teamLabel = isGerman ? "Team" : "Team";
	const secretKeyHintLabel = isGerman
		? "Secret-Key-Hinweis"
		: "Secret key hint";
	const switchLabel = isGerman ? "Wechseln" : "Switch";
	const emptyManageAccountsLabel = isGerman
		? "Noch keine Konten hinzugefügt."
		: "No accounts added yet.";
	const dateTimeFormatter = new Intl.DateTimeFormat(
		isGerman ? "de-DE" : "en-US",
		{
			dateStyle: "medium",
			timeStyle: "short",
		},
	);
	const formatTimestamp = (value?: number) => {
		if (!value || Number.isNaN(value)) {
			return "—";
		}

		return dateTimeFormatter.format(value);
	};

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
			toast.error(m.toast_account_switcher_switch_account_failed());
		}
	};

	const handleAllAccountsSelect = async () => {
		// Check if we have any unlocked accounts
		if (unlockedEmailsList.length === 0) {
			toast.error(m.toast_account_switcher_no_unlocked_accounts());
			return;
		}

		try {
			await switchAccount.mutateAsync({ type: "all" });
			// Invalidate all account-related data to refresh multi-account view
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
			// Use AccountContext's version which broadcasts to extension
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

			toast.success(m.toast_account_switcher_remove_account_success());
		} catch (error) {
			console.error("Failed to remove account:", error);
			toast.error(m.toast_account_switcher_remove_account_failed());
		} finally {
			setAccountToRemove(null);
		}
	};

	const handleAccountSelectFromManageDialog = (email: string) => {
		setShowManageAccounts(false);
		void handleAccountSelect(email);
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
					manageAccountsLabel: manageAccountsLabel,
				}}
				onAccountSelect={handleAccountSelect}
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
				onRemoveAccount={handleRemoveAccountClick}
				trigger={trigger}
				align="start"
			/>

			<Dialog open={showManageAccounts} onOpenChange={setShowManageAccounts}>
				<DialogContent className="max-w-2xl overflow-hidden p-0">
					<DialogHeader className="gap-3 border-b bg-background px-6 py-5">
						<div className="flex flex-wrap items-start justify-between gap-3">
							<div className="space-y-1">
								<DialogTitle>{manageAccountsLabel}</DialogTitle>
								<DialogDescription>
									{manageAccountsDescription}
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
								{emptyManageAccountsLabel}
							</div>
						) : (
							<ScrollArea className="max-h-[420px] pr-4">
								<div className="space-y-3 pb-1">
									{accountsData.map((account) => {
										const isActive =
											activeAccountEmail?.toLowerCase() ===
											account.email.toLowerCase();
										const isUnlocked = unlockedEmailsList.includes(
											account.email,
										);
										const accountDisplayName =
											account.teamName ||
											account.name ||
											account.email.split("@")[0];

										return (
											<div
												key={account.email}
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
																	{activeBadgeLabel}
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
																	? unlockedBadgeLabel
																	: lockedBadgeLabel}
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
																	account.email,
																)
															}
															disabled={switchAccount.isPending}
														>
															{switchLabel}
														</Button>
													)}
												</div>

												<div className="mt-3 grid gap-1.5 rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5 text-xs">
													{account.teamName && (
														<div className="flex items-center justify-between gap-2">
															<span className="text-muted-foreground">
																{teamLabel}
															</span>
															<span className="max-w-[220px] truncate font-medium">
																{account.teamName}
															</span>
														</div>
													)}
													<div className="flex items-center justify-between gap-2">
														<span className="text-muted-foreground">
															{userIdLabel}
														</span>
														<span className="max-w-[220px] truncate font-mono text-[11px]">
															{account.userId}
														</span>
													</div>
													{"secretKeyHint" in account && (
														<div className="flex items-center justify-between gap-2">
															<span className="text-muted-foreground">
																{secretKeyHintLabel}
															</span>
															<span className="font-mono text-[11px]">
																{account.secretKeyHint || "—"}
															</span>
														</div>
													)}
													{"addedAt" in account && (
														<div className="flex items-center justify-between gap-2">
															<span className="text-muted-foreground">
																{addedLabel}
															</span>
															<span>{formatTimestamp(account.addedAt)}</span>
														</div>
													)}
													{"lastActiveAt" in account && (
														<div className="flex items-center justify-between gap-2">
															<span className="text-muted-foreground">
																{lastActiveLabel}
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
