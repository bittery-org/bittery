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

import { CheckIcon, LockIcon, PlusIcon, UserIcon } from "lucide-react";
import type React from "react";
import { cn } from "../lib/utils.js";
import { Avatar, AvatarFallback } from "./avatar.js";
import { Badge } from "./badge.js";
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
}

export interface AccountSwitcherProps {
	/** List of all accounts */
	accounts: AccountSwitcherAccount[];

	/** Currently active account email */
	activeEmail: string | null;

	/** List of unlocked account emails (with MUKs in memory) */
	unlockedEmails: string[];

	/** Loading state */
	isLoading?: boolean;

	/** Callback when user selects an account */
	onAccountSelect: (email: string) => void;

	/** Callback when user clicks "Add Account" */
	onAddAccount: () => void;

	/** Callback when user clicks "Lock All" */
	onLockAll: () => void;

	/** Optional: show "All Accounts" option */
	showAllAccountsOption?: boolean;

	/** Optional: callback when user selects "All Accounts" */
	onAllAccountsSelect?: () => void;

	/** Optional: custom trigger element */
	trigger?: React.ReactNode;

	/** Optional: align menu to start or end */
	align?: "start" | "end";
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
	showAllAccountsOption = false,
	onAllAccountsSelect,
	trigger,
	align = "start",
}: AccountSwitcherProps) {
	const activeAccount = accounts.find((a) => a.email === activeEmail);

	// Default trigger: Avatar with email
	const defaultTrigger = (
		<Button
			variant="ghost"
			className="flex items-center gap-2 px-2 hover:bg-accent"
			disabled={isLoading}
		>
			<Avatar className="size-8">
				<AvatarFallback className="text-xs">
					{activeAccount?.email.slice(0, 2).toUpperCase() ?? "?"}
				</AvatarFallback>
			</Avatar>
			<div className="flex flex-col items-start text-left">
				<span className="font-medium text-sm">
					{activeAccount?.name || activeAccount?.email || "No account"}
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
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				{trigger || defaultTrigger}
			</DropdownMenuTrigger>

			<DropdownMenuContent align={align} className="w-[280px]">
				<DropdownMenuLabel className="text-muted-foreground text-xs">
					Accounts
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
								"flex cursor-pointer items-center gap-2",
								isActive && "bg-accent",
							)}
						>
							<Avatar className="size-6">
								<AvatarFallback className="text-xs">
									{account.email.slice(0, 2).toUpperCase()}
								</AvatarFallback>
							</Avatar>

							<div className="flex min-w-0 flex-1 flex-col gap-0.5">
								<div className="flex items-center gap-1.5">
									<span className="truncate font-medium text-sm">
										{account.name || account.email}
									</span>
									{isActive && (
										<CheckIcon className="size-3 shrink-0 text-primary" />
									)}
								</div>
								<span className="truncate text-muted-foreground text-xs">
									{account.email}
								</span>
								{account.teamName && (
									<span className="truncate text-muted-foreground text-xs">
										{account.teamName}
									</span>
								)}
							</div>

							{isUnlocked && (
								<Badge variant="secondary" className="shrink-0 text-xs">
									Unlocked
								</Badge>
							)}
						</DropdownMenuItem>
					);
				})}

				{/* No accounts message */}
				{accounts.length === 0 && (
					<div className="px-2 py-6 text-center text-muted-foreground text-sm">
						No accounts added
					</div>
				)}

				<DropdownMenuSeparator />

				{/* All Accounts option (optional) */}
				{showAllAccountsOption && onAllAccountsSelect && (
					<>
						<DropdownMenuItem
							onClick={onAllAccountsSelect}
							className="flex cursor-pointer items-center gap-2"
						>
							<UserIcon className="size-4" />
							<span className="text-sm">All Accounts</span>
						</DropdownMenuItem>
						<DropdownMenuSeparator />
					</>
				)}

				{/* Add Account */}
				<DropdownMenuItem
					onClick={onAddAccount}
					className="flex cursor-pointer items-center gap-2"
				>
					<PlusIcon className="size-4" />
					<span className="text-sm">Add Account</span>
				</DropdownMenuItem>

				{/* Lock All */}
				{accounts.length > 0 && unlockedEmails.length > 0 && (
					<DropdownMenuItem
						onClick={onLockAll}
						variant="destructive"
						className="flex cursor-pointer items-center gap-2"
					>
						<LockIcon className="size-4" />
						<span className="text-sm">Lock All Accounts</span>
					</DropdownMenuItem>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
