/**
 * Desktop Account Switcher
 * Wrapper around the shared AccountSwitcher component with desktop-specific logic
 */

import { useAccountSwitcher } from "@bittery/core/hooks";
import type { AccountMetadata } from "@bittery/storage/types";
import {
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
import { IconChevronDown } from "@bittery/ui/icons";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftRight, CheckIcon, Copy, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
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
		activeAccount: activeSelection,
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

	const accountsData = accounts;
	const unlockedAccountIdsList = unlockedAccountIds;
	const activeAccountId =
		activeSelection?.type === "single" ? activeSelection.accountId : null;
	const activeAccount = accountsData.find(
		(a) => a.accountId === activeAccountId,
	);
	const accountEmailById = useMemo(
		() =>
			new Map(
				accountsData.map((account) => [account.accountId, account.email]),
			),
		[accountsData],
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

	const handleSharedAccountSelect = (accountId: string) => {
		void handleAccountSelect(accountId);
	};

	const trigger = (
		<Button
			variant="ghost"
			size="sm"
			className="w-full justify-start gap-2 text-left text-foreground"
			disabled={switchAccount.isPending}
		>
			{activeAccount ? (
				<>
					<AccountAvatar account={activeAccount} size="sm" />
					<div className="flex min-w-0 flex-1 flex-col items-start">
						<span className="w-full truncate font-medium text-sm">
							{activeAccount.teamName ||
								activeAccount.name ||
								activeAccount.email.split("@")[0]}
						</span>
					</div>
				</>
			) : null}
			<IconChevronDown className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
		</Button>
	);

	const removeAccountEmail = accountToRemove
		? (accountEmailById.get(accountToRemove) ?? null)
		: null;

	return (
		<>
			<SharedAccountSwitcher
				accounts={accountsData}
				activeAccountId={activeAccountId}
				unlockedAccountIds={unlockedAccountIdsList}
				isLoading={switchAccount.isPending}
				labels={{
					accountsLabel: m.vaults_sidebar_account_switcher_menu_accounts(),
					noAccountsAdded:
						m.vaults_sidebar_account_switcher_menu_no_accounts_added(),
					addAccountLabel: m.vaults_sidebar_account_switcher_menu_add_account(),
					setupAnotherDeviceLabel:
						m.vaults_sidebar_account_switcher_menu_setup_another_device(),
					settingsLabel: m.nav_menu_settings(),
					lockAllAccountsLabel:
						m.vaults_sidebar_account_switcher_menu_lock_all_accounts(),
					manageAccountsLabel:
						m.vaults_sidebar_account_switcher_manage_accounts_title(),
				}}
				onAccountSelect={handleSharedAccountSelect}
				onAddAccount={handleAddAccount}
				onLockAll={handleLockAll}
				showManageAccounts={true}
				onManageAccounts={handleManageAccounts}
				showAddAccount={true}
				showSettings={true}
				onSettings={handleSettings}
				showSetupAnotherDevice={true}
				onSetupAnotherDevice={handleSetupAnotherDevice}
				trigger={trigger}
				align="start"
			/>

			<Dialog open={showManageAccounts} onOpenChange={setShowManageAccounts}>
				<DialogContent className="gap-0 p-0 sm:max-w-xl">
					<DialogHeader className="relative gap-1 px-5 pt-5 pb-4 text-left">
						<DialogTitle>
							{m.vaults_sidebar_account_switcher_manage_accounts_title()}
						</DialogTitle>
						<DialogDescription>
							{m.vaults_sidebar_account_switcher_manage_accounts_description()}
						</DialogDescription>
					</DialogHeader>

					<ScrollArea className="max-h-[65vh]">
						<div className="flex flex-col gap-3 px-5 pb-5">
							{accountsData.length === 0 && (
								<div className="rounded-lg border border-dashed px-4 py-10 text-center text-muted-foreground text-sm">
									{m.vaults_sidebar_account_switcher_manage_accounts_empty()}
								</div>
							)}

							{accountsData.map((account) => (
								<ManageAccountCard
									key={account.accountId}
									account={account}
									isActive={activeAccountId === account.accountId}
									isUnlocked={unlockedAccountIdsList.includes(
										account.accountId,
									)}
									isBusy={switchAccount.isPending}
									formatTimestamp={formatTimestamp}
									onSwitch={() =>
										handleAccountSelectFromManageDialog(account.accountId)
									}
									onRemove={() => {
										setShowManageAccounts(false);
										handleRemoveAccountClick(account.accountId);
									}}
									onCopy={handleCopy}
								/>
							))}

							<button
								type="button"
								onClick={handleAddAccountFromManageDialog}
								className="flex h-10 items-center justify-center gap-2 rounded-lg border border-dashed text-muted-foreground text-sm transition-colors hover:border-border-strong hover:bg-foreground/3 hover:text-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30"
							>
								<Plus className="size-4" />
								{m.vaults_sidebar_account_switcher_menu_add_account()}
							</button>
						</div>
					</ScrollArea>
				</DialogContent>
			</Dialog>

			<RemoveAccountDialog
				email={removeAccountEmail}
				onConfirm={() => {
					if (accountToRemove) void handleRemoveAccount(accountToRemove);
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
}: ManageAccountCardProps) {
	const { m } = useI18n();

	const displayName =
		account.teamName || account.name || account.email.split("@")[0];
	const serverUrl = account.serverUrl;

	return (
		<div
			className={cn(
				"group/card overflow-hidden rounded-lg border bg-card",
				isActive &&
					"shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-primary)_14%,transparent)]",
			)}
		>
			{/* Header row */}
			<div className="relative flex items-center gap-3 px-4 py-3">
				{isActive && (
					<span
						aria-hidden
						className="absolute top-2.5 bottom-2.5 left-0 w-0.5 rounded-full bg-primary shadow-[0_0_8px_color-mix(in_oklab,var(--color-primary)_80%,transparent)]"
					/>
				)}
				<AccountAvatar account={account} size="md" />

				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-1.5">
						<span className="truncate font-medium text-sm leading-tight">
							{displayName}
						</span>
						{isActive && (
							<CheckIcon
								aria-label={m.vaults_sidebar_account_switcher_badge_active()}
								className="size-3.5 shrink-0 text-primary drop-shadow-[0_0_4px_var(--color-primary)]"
							/>
						)}
					</div>
					<span className="block truncate text-[11px] text-muted-foreground leading-tight">
						{account.email}
					</span>
				</div>

				<span className="flex shrink-0 items-center gap-1.5 text-[10.5px] text-muted-foreground">
					<span
						aria-hidden
						className={cn(
							"size-1.5 rounded-full",
							isUnlocked
								? "bg-emerald-400 shadow-[0_0_6px_oklch(0.72_0.14_160/0.6)]"
								: "bg-muted-foreground/50",
						)}
					/>
					{isUnlocked
						? m.vaults_sidebar_account_switcher_badge_unlocked()
						: m.vaults_sidebar_account_switcher_badge_locked()}
				</span>

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

				<Button
					size="icon"
					variant="ghost"
					className="size-7 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover/card:opacity-100"
					onClick={onRemove}
					aria-label={m.vaults_sidebar_account_switcher_menu_remove_account()}
				>
					<Trash2 className="size-3.5" />
				</Button>
			</div>

			{/* Detail field rows (hairline-divided, hover-revealed copy actions) */}
			<div className="divide-y border-t">
				<ManageAccountFieldRow
					label={m.vaults_sidebar_account_switcher_label_server()}
					value={serverUrl || "—"}
					onCopy={serverUrl ? () => onCopy(serverUrl) : undefined}
					copyLabel={m.vaults_sidebar_account_switcher_action_copy()}
				/>
				<ManageAccountFieldRow
					label={m.vaults_sidebar_account_switcher_label_user_id()}
					value={account.userId}
					onCopy={() => onCopy(account.userId)}
					copyLabel={m.vaults_sidebar_account_switcher_action_copy()}
				/>
				{"secretKeyHint" in account && account.secretKeyHint && (
					<ManageAccountFieldRow
						label={m.vaults_sidebar_account_switcher_label_secret_key_hint()}
						value={account.secretKeyHint}
						copyLabel={m.vaults_sidebar_account_switcher_action_copy()}
					/>
				)}

				<div className="flex items-center gap-4 px-4 py-2 text-[11px] text-muted-foreground tabular-nums">
					{"addedAt" in account && (
						<span>
							{m.vaults_sidebar_account_switcher_label_added()}{" "}
							{formatTimestamp(account.addedAt)}
						</span>
					)}
					{"lastActiveAt" in account && (
						<span>
							{m.vaults_sidebar_account_switcher_label_last_active()}{" "}
							{formatTimestamp(account.lastActiveAt)}
						</span>
					)}
				</div>
			</div>
		</div>
	);
}

function ManageAccountFieldRow({
	label,
	value,
	onCopy,
	copyLabel,
}: {
	label: ReactNode;
	value: string;
	onCopy?: () => void;
	copyLabel: string;
}) {
	return (
		<div className="group/row flex min-h-[42px] items-center gap-3 px-4 py-1.5 transition-colors hover:bg-foreground/3">
			<div className="min-w-0 flex-1">
				<div className="font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.05em]">
					{label}
				</div>
				<div className="truncate font-mono text-[11.5px]" title={value}>
					{value}
				</div>
			</div>
			{onCopy && (
				<button
					type="button"
					onClick={onCopy}
					aria-label={copyLabel}
					className="grid size-7 shrink-0 place-items-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:bg-overlay hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100"
				>
					<Copy className="size-3.5" />
				</button>
			)}
		</div>
	);
}
