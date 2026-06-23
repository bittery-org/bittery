/**
 * Desktop Account Switcher
 * Wrapper around the shared AccountSwitcher component with desktop-specific logic
 */

import { useAccountSwitcher } from "@bittery/core/hooks";
import { normalizeServerUrl } from "@bittery/shared/server-url";
import type { AccountMetadata } from "@bittery/storage/types";
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
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
	Input,
	ScrollArea,
	AccountSwitcher as SharedAccountSwitcher,
	toast,
} from "@bittery/ui";
import { IconChevronDownOutlineDuo18 } from "@bittery/ui/icons";
import { useNavigate } from "@tanstack/react-router";
import {
	ArrowLeftRight,
	Check,
	Copy,
	MoreVertical,
	Pencil,
	Plus,
	Server,
	Trash2,
	X,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { useAccount } from "@/contexts/account-context";
import { setActiveAuthServerUrl } from "@/lib/auth-server";
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
		updateAccount,
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

	const handleCopy = async (value: string) => {
		try {
			await navigator.clipboard.writeText(value);
			toast.success(m.vaults_sidebar_account_switcher_toast_copied());
		} catch (error) {
			console.error("Failed to copy to clipboard:", error);
		}
	};

	const handleSaveServerUrl = async (
		account: AccountMetadata,
		nextUrl: string,
	): Promise<boolean> => {
		const normalized = normalizeServerUrl(nextUrl);
		if (!normalized) {
			toast.error(m.toast_auth_server_invalid_url());
			return false;
		}

		if (normalized === account.serverUrl) {
			return true;
		}

		try {
			await storage.storeServerUrl(normalized, account.accountId);
			await updateAccount.mutateAsync({ ...account, serverUrl: normalized });

			if (activeAccountId === account.accountId) {
				await setActiveAuthServerUrl(normalized);
			}

			await invalidator.invalidateAllAccountData();
			toast.success(m.toast_auth_server_updated());
			return true;
		} catch (error) {
			console.error("Failed to update server URL:", error);
			toast.error(m.toast_auth_server_invalid_url());
			return false;
		}
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
				<DialogContent className="max-w-2xl gap-0 overflow-hidden p-0">
					<DialogHeader className="space-y-4 border-b px-6 pt-6 pb-5 text-left">
						<div className="space-y-1.5">
							<DialogTitle className="text-xl tracking-tight">
								{m.vaults_sidebar_account_switcher_manage_accounts_title()}
							</DialogTitle>
							<DialogDescription>
								{m.vaults_sidebar_account_switcher_manage_accounts_description()}
							</DialogDescription>
						</div>
						<Button
							size="sm"
							className="w-fit gap-1.5"
							onClick={handleAddAccountFromManageDialog}
						>
							<Plus className="size-4" />
							{m.vaults_sidebar_account_switcher_menu_add_account()}
						</Button>
					</DialogHeader>

					{accountsData.length === 0 ? (
						<div className="px-6 py-10">
							<div className="rounded-2xl border border-dashed px-4 py-12 text-center text-muted-foreground text-sm">
								{m.vaults_sidebar_account_switcher_manage_accounts_empty()}
							</div>
						</div>
					) : (
						<ScrollArea className="max-h-[60vh]">
							<div className="space-y-3 px-6 py-5">
								{accountsData.map((account) => (
									<ManageAccountCard
										key={account.accountId}
										account={account}
										isActive={activeAccountId === account.accountId}
										isUnlocked={unlockedAccountIdsList.includes(
											account.accountId,
										)}
										isBusy={switchAccount.isPending || updateAccount.isPending}
										formatTimestamp={formatTimestamp}
										onSwitch={() =>
											handleAccountSelectFromManageDialog(account.accountId)
										}
										onRemove={() => {
											setShowManageAccounts(false);
											handleRemoveAccountClick(account.accountId);
										}}
										onCopy={handleCopy}
										onSaveServerUrl={(url) => handleSaveServerUrl(account, url)}
									/>
								))}
							</div>
						</ScrollArea>
					)}
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
				initialAccountId={activeAccountId}
			/>
		</>
	);
}

interface ManageAccountCardProps {
	account: AccountMetadata;
	isActive: boolean;
	isUnlocked: boolean;
	isBusy: boolean;
	formatTimestamp: (value?: number) => string;
	onSwitch: () => void;
	onRemove: () => void;
	onCopy: (value: string) => void;
	onSaveServerUrl: (url: string) => Promise<boolean>;
}

function ManageAccountCard({
	account,
	isActive,
	isUnlocked,
	isBusy,
	formatTimestamp,
	onSwitch,
	onRemove,
	onCopy,
	onSaveServerUrl,
}: ManageAccountCardProps) {
	const { m } = useI18n();
	const [isEditingServer, setIsEditingServer] = useState(false);
	const [serverDraft, setServerDraft] = useState(account.serverUrl ?? "");
	const [isSaving, setIsSaving] = useState(false);

	const displayName =
		account.teamName || account.name || account.email.split("@")[0];

	const startEditingServer = () => {
		setServerDraft(account.serverUrl ?? "");
		setIsEditingServer(true);
	};

	const cancelEditingServer = () => {
		setIsEditingServer(false);
		setServerDraft(account.serverUrl ?? "");
	};

	const submitServer = async () => {
		setIsSaving(true);
		const saved = await onSaveServerUrl(serverDraft);
		setIsSaving(false);
		if (saved) {
			setIsEditingServer(false);
		}
	};

	return (
		<div
			className={cn(
				"overflow-hidden rounded-2xl border bg-card transition-colors",
				isActive
					? "border-primary/50 ring-1 ring-primary/15"
					: "hover:border-border",
			)}
		>
			<div className="flex items-center gap-3 p-4">
				<AccountAvatar account={account} size="lg" />

				<div className="min-w-0 flex-1 space-y-1">
					<div className="flex flex-wrap items-center gap-1.5">
						<span className="truncate font-semibold text-sm">
							{displayName}
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

				<div className="flex shrink-0 items-center gap-1.5">
					{!isActive && (
						<Button
							size="sm"
							variant="outline"
							className="gap-1.5"
							onClick={onSwitch}
							disabled={isBusy}
						>
							<ArrowLeftRight className="size-3.5" />
							{m.vaults_sidebar_account_switcher_action_switch()}
						</Button>
					)}
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								size="icon"
								variant="ghost"
								className="size-8 text-muted-foreground"
								aria-label={m.vaults_sidebar_account_switcher_action_account_actions()}
							>
								<MoreVertical className="size-4" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-52">
							<DropdownMenuItem onClick={startEditingServer}>
								<Pencil className="size-4" />
								{m.vaults_sidebar_account_switcher_action_edit_server()}
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem variant="destructive" onClick={onRemove}>
								<Trash2 className="size-4" />
								{m.vaults_sidebar_account_switcher_menu_remove_account()}
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>

			<dl className="space-y-2.5 border-t bg-muted/30 px-4 py-3 text-xs">
				{account.teamName && (
					<DetailRow label={m.vaults_sidebar_account_switcher_label_team()}>
						<span className="truncate font-medium">{account.teamName}</span>
					</DetailRow>
				)}

				<DetailRow
					label={
						<span className="flex items-center gap-1.5">
							<Server className="size-3.5" />
							{m.vaults_sidebar_account_switcher_label_server()}
						</span>
					}
				>
					{isEditingServer ? (
						<form
							className="flex flex-1 items-center justify-end gap-1"
							onSubmit={(event) => {
								event.preventDefault();
								void submitServer();
							}}
						>
							<Input
								autoFocus
								type="url"
								value={serverDraft}
								onChange={(event) => setServerDraft(event.target.value)}
								placeholder={m.auth_footer_server_placeholder()}
								className="h-7 max-w-[260px] font-mono text-[11px]"
								disabled={isSaving}
							/>
							<Button
								type="submit"
								size="icon"
								variant="ghost"
								className="size-7 text-emerald-600 hover:text-emerald-700"
								disabled={isSaving}
								aria-label={m.vaults_sidebar_account_switcher_action_save()}
							>
								<Check className="size-3.5" />
							</Button>
							<Button
								type="button"
								size="icon"
								variant="ghost"
								className="size-7 text-muted-foreground"
								onClick={cancelEditingServer}
								disabled={isSaving}
								aria-label={m.vaults_sidebar_account_switcher_action_cancel()}
							>
								<X className="size-3.5" />
							</Button>
						</form>
					) : (
						<button
							type="button"
							onClick={startEditingServer}
							className="group flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-foreground transition-colors hover:bg-muted"
							title={account.serverUrl ?? undefined}
						>
							<span className="truncate font-mono text-[11px]">
								{account.serverUrl || "—"}
							</span>
							<Pencil className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
						</button>
					)}
				</DetailRow>

				<DetailRow label={m.vaults_sidebar_account_switcher_label_user_id()}>
					<span className="truncate font-mono text-[11px]">
						{account.userId}
					</span>
					<button
						type="button"
						onClick={() => onCopy(account.userId)}
						className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
						aria-label={m.vaults_sidebar_account_switcher_action_copy()}
					>
						<Copy className="size-3" />
					</button>
				</DetailRow>

				{"secretKeyHint" in account && (
					<DetailRow
						label={m.vaults_sidebar_account_switcher_label_secret_key_hint()}
					>
						<span className="font-mono text-[11px]">
							{account.secretKeyHint || "—"}
						</span>
					</DetailRow>
				)}

				{"addedAt" in account && (
					<DetailRow label={m.vaults_sidebar_account_switcher_label_added()}>
						<span>{formatTimestamp(account.addedAt)}</span>
					</DetailRow>
				)}

				{"lastActiveAt" in account && (
					<DetailRow
						label={m.vaults_sidebar_account_switcher_label_last_active()}
					>
						<span>{formatTimestamp(account.lastActiveAt)}</span>
					</DetailRow>
				)}
			</dl>
		</div>
	);
}

function DetailRow({
	label,
	children,
}: {
	label: ReactNode;
	children: ReactNode;
}) {
	return (
		<div className="flex items-center justify-between gap-3">
			<dt className="shrink-0 text-muted-foreground">{label}</dt>
			<dd className="flex min-w-0 items-center justify-end gap-1.5 text-right">
				{children}
			</dd>
		</div>
	);
}
