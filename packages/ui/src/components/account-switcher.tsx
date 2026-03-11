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
	LockOpenIcon,
	LogOutIcon,
	PlusIcon,
	SettingsIcon,
	SmartphoneIcon,
	UsersIcon,
} from "lucide-react";
import type React from "react";
import { cn } from "../lib/utils.js";
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
	allAccountsLabel?: string;
	unlockedCount?: (params: { count: number }) => string;
	viewItemsFromAccounts?: (params: { count: number }) => string;
	manageAccountsLabel?: string;
	addAccountLabel?: string;
	setupAnotherDeviceLabel?: string;
	settingsLabel?: string;
	lockAllAccountsLabel?: string;
	removeAccountLabel?: string;
}

export interface AccountSwitcherProps {
	/** List of all accounts */
	accounts: AccountSwitcherAccount[];

	/** Currently active account email (or "all" for All Accounts mode) */
	activeEmail: string | null;

	/** List of unlocked account emails (with MUKs in memory) */
	unlockedEmails: string[];

	/** Loading state */
	isLoading?: boolean;

	/** Callback when user selects an account */
	onAccountSelect: (email: string) => void;

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

	/** Optional: show "All Accounts" option */
	showAllAccountsOption?: boolean;

	/** Optional: callback when user selects "All Accounts" */
	onAllAccountsSelect?: () => void;

	/** Optional: show "Settings" option */
	showSettings?: boolean;

	/** Optional: callback when user clicks "Settings" */
	onSettings?: () => void;

	/** Optional: show "Set up another device" option */
	showSetupAnotherDevice?: boolean;

	/** Optional: callback when user clicks "Set up another device" */
	onSetupAnotherDevice?: () => void;

	/** Optional: show "Remove Account" option */
	showRemoveAccount?: boolean;

	/** Optional: callback when user clicks "Remove Account" */
	onRemoveAccount?: (email: string) => void;

	/** Optional: custom trigger element */
	trigger?: React.ReactNode;

	/** Optional: align menu to start or end */
	align?: "start" | "end";

	/** Optional: localized/overridden labels */
	labels?: AccountSwitcherLabels;
}

/**
 * Account switcher dropdown for multi-account platforms.
 *
 * @example
 * ```tsx
 * <AccountSwitcher
 *   accounts={accounts.data ?? []}
 *   activeEmail={activeEmail.data}
 *   unlockedEmails={unlockedEmails.data ?? []}
 *   onAccountSelect={(email) => switchAccount.mutate(email)}
 *   onAddAccount={() => navigate('/login?add=true')}
 *   onLockAll={() => lockAllAccounts.mutate()}
 * />
 * ```
 */
export function AccountSwitcher({
	accounts,
	activeEmail,
	unlockedEmails,
	isLoading = false,
	onAccountSelect,
	onAddAccount,
	onLockAll,
	showLockAll = true,
	showManageAccounts = false,
	onManageAccounts,
	showAddAccount = true,
	showAllAccountsOption = false,
	onAllAccountsSelect,
	showSettings = false,
	onSettings,
	showSetupAnotherDevice = false,
	onSetupAnotherDevice,
	showRemoveAccount = false,
	onRemoveAccount,
	trigger,
	align = "start",
	labels,
}: AccountSwitcherProps) {
	const activeAccount = accounts.find((a) => a.email === activeEmail);
	const isAllAccountsMode = activeEmail === "all";
	const resolvedLabels: Required<AccountSwitcherLabels> = {
		accountsLabel: "Accounts",
		noAccountLabel: "No account",
		noAccountsAdded: "No accounts added",
		allAccountsLabel: "All Accounts",
		unlockedCount: ({ count }) =>
			count === 1 ? `${count} unlocked` : `${count} unlocked`,
		viewItemsFromAccounts: ({ count }) =>
			count === 1
				? `View items from ${count} account`
				: `View items from ${count} accounts`,
		manageAccountsLabel: "Manage Accounts",
		addAccountLabel: "Add Account",
		setupAnotherDeviceLabel: "Set up another device",
		settingsLabel: "Settings",
		lockAllAccountsLabel: "Lock All Accounts",
		removeAccountLabel: "Remove Account",
		...labels,
	};
	const showAllAccountsAction = Boolean(
		showAllAccountsOption &&
			onAllAccountsSelect &&
			accounts.length > 1 &&
			unlockedEmails.length > 1,
	);
	const showManageAccountsAction = Boolean(
		showManageAccounts && onManageAccounts,
	);
	const showAddAccountAction = Boolean(showAddAccount && onAddAccount);
	const showSetupAnotherDeviceAction = Boolean(
		showSetupAnotherDevice && onSetupAnotherDevice,
	);
	const showSettingsAction = Boolean(showSettings && onSettings);
	const showLockAllAction = Boolean(
		showLockAll && accounts.length > 0 && unlockedEmails.length > 0,
	);
	const showRemoveAccountAction = Boolean(
		showRemoveAccount &&
			onRemoveAccount &&
			activeAccount &&
			!isAllAccountsMode,
	);
	const hasPrimaryActions =
		showAllAccountsAction ||
		showManageAccountsAction ||
		showAddAccountAction ||
		showSetupAnotherDeviceAction ||
		showSettingsAction ||
		showLockAllAction;
	const hasActionsBeforeLockAll =
		showAllAccountsAction ||
		showManageAccountsAction ||
		showAddAccountAction ||
		showSetupAnotherDeviceAction ||
		showSettingsAction;

	// Default trigger: Avatar with email or "All Accounts"
	const defaultTrigger = (
		<Button
			variant="ghost"
			className="flex items-center gap-2 px-2 hover:bg-accent"
			disabled={isLoading}
		>
			{isAllAccountsMode ? (
				<>
					<div className="flex size-8 items-center justify-center rounded-full bg-primary/10">
						<UsersIcon className="size-4 text-primary" />
					</div>
					<div className="flex flex-col items-start text-left">
						<span className="font-medium text-sm">
							{resolvedLabels.allAccountsLabel}
						</span>
						<span className="text-muted-foreground text-xs">
							{resolvedLabels.unlockedCount({
								count: unlockedEmails.length,
							})}
						</span>
					</div>
				</>
			) : (
				<>
					<Avatar className="size-8">
						{activeAccount?.teamAvatarUrl && (
							<AvatarImage
								src={activeAccount.teamAvatarUrl}
								alt={activeAccount.teamName || activeAccount.name}
							/>
						)}
						<AvatarFallback className="text-xs">
							{activeAccount?.email.slice(0, 2).toUpperCase() ?? "?"}
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
				</>
			)}
		</Button>
	);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				{trigger || defaultTrigger}
			</DropdownMenuTrigger>

			<DropdownMenuContent align={align} className="w-[280px]">
				<DropdownMenuLabel className="text-muted-foreground text-xs">
					{resolvedLabels.accountsLabel}
				</DropdownMenuLabel>

				{/* Account list */}
				{accounts.map((account) => {
					const isActive = account.email === activeEmail;
					const isUnlocked = unlockedEmails.includes(account.email);

					return (
						<DropdownMenuItem
							key={account.email}
							onClick={() => onAccountSelect(account.email)}
							className={cn(
								"flex cursor-pointer items-center gap-2 py-1.5",
								isActive && "bg-accent",
							)}
						>
							<Avatar className="size-5">
								{account.teamAvatarUrl && (
									<AvatarImage
										src={account.teamAvatarUrl}
										alt={account.teamName || account.name}
									/>
								)}
								<AvatarFallback className="text-[10px]">
									{account.email.slice(0, 2).toUpperCase()}
								</AvatarFallback>
							</Avatar>

							<div className="flex min-w-0 flex-1 flex-col">
								<div className="flex items-center gap-1.5">
									<span className="truncate font-medium text-xs">
										{account.email}
									</span>
									{isActive && (
										<CheckIcon className="size-3 shrink-0 text-primary" />
									)}
								</div>
								{account.teamName && (
									<span className="truncate text-[10px] text-muted-foreground">
										{account.teamName}
									</span>
								)}
							</div>

							{isUnlocked ? (
								<LockOpenIcon className="size-3.5 shrink-0 text-green-600" />
							) : (
								<LockIcon className="size-3.5 shrink-0 text-muted-foreground" />
							)}
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

				{/* All Accounts option (optional) */}
				{showAllAccountsAction && (
						<>
							<DropdownMenuItem
								onClick={onAllAccountsSelect!}
								className={cn(
									"flex cursor-pointer items-center gap-2",
									isAllAccountsMode && "bg-accent",
								)}
							>
								<div className="flex size-6 items-center justify-center rounded-full bg-primary/10">
									<UsersIcon className="size-4 text-primary" />
								</div>
								<div className="flex min-w-0 flex-1 flex-col gap-0.5">
									<div className="flex items-center gap-1.5">
										<span className="font-medium text-sm">
											{resolvedLabels.allAccountsLabel}
										</span>
										{isAllAccountsMode && (
											<CheckIcon className="size-3 shrink-0 text-primary" />
										)}
									</div>
									<span className="text-muted-foreground text-xs">
										{resolvedLabels.viewItemsFromAccounts({
											count: unlockedEmails.length,
										})}
									</span>
								</div>
							</DropdownMenuItem>
							<DropdownMenuSeparator />
						</>
					)}

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

				{/* Remove Account (optional) */}
				{showRemoveAccountAction && (
						<>
							<DropdownMenuSeparator />
							<DropdownMenuItem
								onClick={() => onRemoveAccount!(activeAccount!.email)}
								className="flex cursor-pointer items-center gap-2 text-destructive focus:text-destructive"
							>
								<LogOutIcon className="size-4" />
								<span className="text-sm">
									{resolvedLabels.removeAccountLabel}
								</span>
							</DropdownMenuItem>
						</>
					)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
