"use client";

/**
 * Account Switcher Component
 *
 * Dropdown menu for switching between multiple accounts (desktop/mobile/extension).
 * Shows:
 * - List of all added accounts with active indicator
 * - Unlocked status badge
 * - Add Account option
 * - Lock All option
 */

import {
	CheckIcon,
	LockIcon,
	PlusIcon,
	SettingsIcon,
	SmartphoneIcon,
	UsersIcon,
} from "lucide-react";
import type React from "react";
import { useState } from "react";
import { cn, getAccountInitials } from "../lib/utils.js";
import { Avatar, AvatarFallback, AvatarImage } from "./avatar.js";
import { Button } from "./button.js";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "./dropdown-menu.js";

export interface AccountSwitcherAccount {
	accountId: string;
	email: string;
	name: string;
	userId: string;
	teamName?: string;
	teamAvatarUrl?: string | null;
}

export interface AccountSwitcherLabels {
	accountsLabel?: string;
	noAccountLabel?: string;
	noAccountsAdded?: string;
	manageAccountsLabel?: string;
	addAccountLabel?: string;
	setupAnotherDeviceLabel?: string;
	settingsLabel?: string;
	lockAllAccountsLabel?: string;
}

export interface AccountSwitcherProps {
	/** List of all accounts */
	accounts: AccountSwitcherAccount[];

	/** Currently active account ID */
	activeAccountId: string | null;

	/** List of unlocked account IDs (with MUKs in memory) */
	unlockedAccountIds: string[];

	/** Loading state */
	isLoading?: boolean;

	/** Callback when user selects an account */
	onAccountSelect: (accountId: string) => void;

	/** Optional: callback when user clicks "Add Account" */
	onAddAccount?: () => void;

	/** Callback when user clicks "Lock All" */
	onLockAll: () => void;

	/** Optional: show "Lock All" option */
	showLockAll?: boolean;

	/** Optional: show "Manage Accounts" option */
	showManageAccounts?: boolean;

	/** Optional: callback when user clicks "Manage Accounts" */
	onManageAccounts?: () => void;

	/** Optional: show "Add Account" option */
	showAddAccount?: boolean;

	/** Optional: show "Settings" option */
	showSettings?: boolean;

	/** Optional: callback when user clicks "Settings" */
	onSettings?: () => void;

	/** Optional: show "Set up another device" option */
	showSetupAnotherDevice?: boolean;

	/** Optional: callback when user clicks "Set up another device" */
	onSetupAnotherDevice?: () => void;

	/** Optional: custom trigger element */
	trigger?: React.ReactNode;

	/** Optional: align menu to start or end */
	align?: "start" | "end";

	/** Optional: localized/overridden labels */
	labels?: AccountSwitcherLabels;
}

const avatarFallbackClassName =
	"bg-linear-to-br from-primary to-primary-deep font-semibold text-primary-foreground shadow-[inset_0_0_0_1px_oklch(1_0_0/0.15)]";

/**
 * Account switcher dropdown for multi-account platforms.
 *
 * @example
 * ```tsx
 * <AccountSwitcher
 *   accounts={accounts}
 *   activeAccountId={activeAccountId}
 *   unlockedAccountIds={unlockedAccountIds}
 *   onAccountSelect={(accountId) => switchAccount.mutate(accountId)}
 *   onAddAccount={() => navigate('/login?add=true')}
 *   onLockAll={() => lockAllAccounts.mutate()}
 * />
 * ```
 */
export function AccountSwitcher({
	accounts,
	activeAccountId,
	unlockedAccountIds,
	isLoading = false,
	onAccountSelect,
	onAddAccount,
	onLockAll,
	showLockAll = true,
	showManageAccounts = false,
	onManageAccounts,
	showAddAccount = true,
	showSettings = false,
	onSettings,
	showSetupAnotherDevice = false,
	onSetupAnotherDevice,
	trigger,
	align = "start",
	labels,
}: AccountSwitcherProps) {
	const [open, setOpen] = useState(false);
	const activeAccount = accounts.find((a) => a.accountId === activeAccountId);
	const resolvedLabels: Required<AccountSwitcherLabels> = {
		accountsLabel: "Accounts",
		noAccountLabel: "No account",
		noAccountsAdded: "No accounts added",
		manageAccountsLabel: "Manage Accounts",
		addAccountLabel: "Add Account",
		setupAnotherDeviceLabel: "Set up another device",
		settingsLabel: "Settings",
		lockAllAccountsLabel: "Lock All Accounts",
		...labels,
	};
	const showManageAccountsAction = Boolean(
		showManageAccounts && onManageAccounts,
	);
	const showAddAccountAction = Boolean(showAddAccount && onAddAccount);
	const showSetupAnotherDeviceAction = Boolean(
		showSetupAnotherDevice && onSetupAnotherDevice,
	);
	const showSettingsAction = Boolean(showSettings && onSettings);
	const showLockAllAction = Boolean(
		showLockAll && accounts.length > 0 && unlockedAccountIds.length > 0,
	);
	const hasPrimaryActions =
		showManageAccountsAction ||
		showAddAccountAction ||
		showSetupAnotherDeviceAction ||
		showSettingsAction ||
		showLockAllAction;
	const hasActionsBeforeLockAll =
		showManageAccountsAction ||
		showAddAccountAction ||
		showSetupAnotherDeviceAction ||
		showSettingsAction;

	// Default trigger: Avatar with email
	const defaultTrigger = (
		<Button
			variant="ghost"
			className="flex items-center gap-2 px-2 text-foreground hover:bg-accent"
			disabled={isLoading}
		>
			<Avatar className="size-8 rounded-md">
				{activeAccount?.teamAvatarUrl && (
					<AvatarImage
						src={activeAccount.teamAvatarUrl}
						alt={activeAccount.teamName || activeAccount.name}
					/>
				)}
				<AvatarFallback
					className={cn("rounded-md text-xs", avatarFallbackClassName)}
				>
					{activeAccount ? getAccountInitials(activeAccount) : "?"}
				</AvatarFallback>
			</Avatar>
			<div className="flex flex-col items-start text-left">
				<span className="font-medium text-sm">
					{activeAccount?.name ||
						activeAccount?.email ||
						resolvedLabels.noAccountLabel}
				</span>
				{activeAccount && (
					<span className="text-muted-foreground text-xs">
						{activeAccount.email}
					</span>
				)}
			</div>
		</Button>
	);

	return (
		<DropdownMenu open={open} onOpenChange={setOpen}>
			<DropdownMenuTrigger asChild>
				{trigger || defaultTrigger}
			</DropdownMenuTrigger>

			<DropdownMenuContent
				align={align}
				className="relative w-[272px] overflow-hidden"
			>
				{/* Brand moment: faint purple gradient wash at the top of the menu */}
				<div
					aria-hidden
					className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-linear-to-b from-primary-deep/10 to-transparent dark:from-primary-deep/20"
				/>
				<div
					aria-hidden
					className="pointer-events-none absolute top-0 right-[8%] left-[8%] h-px bg-linear-to-r from-transparent via-primary/55 to-transparent"
				/>

				<DropdownMenuLabel className="relative font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.05em]">
					{resolvedLabels.accountsLabel}
				</DropdownMenuLabel>

				{/* Account list */}
				{accounts.map((account) => {
					const isActive = account.accountId === activeAccountId;
					const isUnlocked = unlockedAccountIds.includes(account.accountId);
					const displayName =
						account.teamName || account.name || account.email.split("@")[0];

					return (
						<DropdownMenuItem
							key={account.accountId}
							onClick={() => onAccountSelect(account.accountId)}
							className="relative flex cursor-pointer items-center gap-2.5 py-1.5"
						>
							<Avatar className="size-6 rounded-md">
								{account.teamAvatarUrl && (
									<AvatarImage
										src={account.teamAvatarUrl}
										alt={account.teamName || account.name}
									/>
								)}
								<AvatarFallback
									className={cn(
										"rounded-md text-[10px]",
										avatarFallbackClassName,
									)}
								>
									{getAccountInitials(account)}
								</AvatarFallback>
							</Avatar>

							<div className="flex min-w-0 flex-1 flex-col">
								<div className="flex items-center gap-1.5">
									<span className="truncate font-medium text-sm leading-tight">
										{displayName}
									</span>
									{isActive && (
										<CheckIcon className="size-3.5 shrink-0 text-primary drop-shadow-[0_0_4px_var(--color-primary)]" />
									)}
								</div>
								<span className="truncate text-[11px] text-muted-foreground leading-tight">
									{account.email}
								</span>
							</div>

							{/* Quiet lock-state indicator */}
							<span
								aria-hidden
								className={cn(
									"size-1.5 shrink-0 rounded-full",
									isUnlocked
										? "bg-emerald-400 shadow-[0_0_6px_oklch(0.72_0.14_160/0.6)]"
										: "bg-muted-foreground/50",
								)}
							/>

						</DropdownMenuItem>
					);
				})}

				{/* No accounts message */}
				{accounts.length === 0 && (
					<div className="px-2 py-6 text-center text-muted-foreground text-sm">
						{resolvedLabels.noAccountsAdded}
					</div>
				)}

				{hasPrimaryActions && <DropdownMenuSeparator />}

				{/* Manage Accounts (optional) */}
				{showManageAccountsAction && (
					<DropdownMenuItem
						onClick={onManageAccounts!}
						className="flex cursor-pointer items-center gap-2"
					>
						<UsersIcon className="size-4" />
						<span className="text-sm">
							{resolvedLabels.manageAccountsLabel}
						</span>
					</DropdownMenuItem>
				)}

				{/* Add Account (optional) */}
				{showAddAccountAction && (
					<DropdownMenuItem
						onClick={onAddAccount!}
						className="flex cursor-pointer items-center gap-2"
					>
						<PlusIcon className="size-4" />
						<span className="text-sm">{resolvedLabels.addAccountLabel}</span>
					</DropdownMenuItem>
				)}

				{/* Set up another device (optional) */}
				{showSetupAnotherDeviceAction && (
					<DropdownMenuItem
						onClick={onSetupAnotherDevice!}
						className="flex cursor-pointer items-center gap-2"
					>
						<SmartphoneIcon className="size-4" />
						<span className="text-sm">
							{resolvedLabels.setupAnotherDeviceLabel}
						</span>
					</DropdownMenuItem>
				)}

				{/* Settings (optional) */}
				{showSettingsAction && (
					<DropdownMenuItem
						onClick={onSettings!}
						className="flex cursor-pointer items-center gap-2"
					>
						<SettingsIcon className="size-4" />
						<span className="text-sm">{resolvedLabels.settingsLabel}</span>
					</DropdownMenuItem>
				)}

				{showLockAllAction && hasActionsBeforeLockAll && (
					<DropdownMenuSeparator />
				)}

				{/* Lock All */}
				{showLockAllAction && (
					<DropdownMenuItem
						onClick={onLockAll}
						className="flex cursor-pointer items-center gap-2"
					>
						<LockIcon className="size-4" />
						<span className="text-sm">
							{resolvedLabels.lockAllAccountsLabel}
						</span>
					</DropdownMenuItem>
				)}

			</DropdownMenuContent>
		</DropdownMenu>
	);
}
