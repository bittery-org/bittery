import * as tauriStorage from "@bittery/crypto/storage-tauri";
import {
	Button,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
	toast,
} from "@bittery/ui";
import { useNavigate } from "@tanstack/react-router";
import { Check, ChevronDown, Lock, LogOut, Plus } from "lucide-react";
import { useState } from "react";
import { useAccount } from "../contexts/account-context";
import { AccountAvatar } from "./account-avatar";
import { RemoveAccountDialog } from "./remove-account-dialog";

export function AccountSwitcher() {
	const {
		activeAccount,
		allAccounts,
		switchAccount,
		removeAccount,
		lockAccount,
		lockAllAccounts,
	} = useAccount();
	const navigate = useNavigate();
	const [isSwitching, setIsSwitching] = useState(false);
	const [accountToRemove, setAccountToRemove] = useState<string | null>(null);

	const handleSwitchAccount = async (email: string) => {
		if (email === activeAccount?.email) return;

		setIsSwitching(true);
		try {
			await switchAccount(email);

			// Check if session is valid for the switched account
			const sessionValid = await tauriStorage.isSessionValid(email);
			if (!sessionValid) {
				navigate({ to: "/unlock", search: { email } });
			} else {
				navigate({ to: "/vault" });
			}
		} catch (error) {
			console.error("Failed to switch account:", error);
			toast.error("Failed to switch account");
		} finally {
			setIsSwitching(false);
		}
	};

	const handleAddAccount = () => {
		navigate({ to: "/login", search: { addingAccount: true } });
	};

	const handleLockAccount = async (email: string) => {
		try {
			await lockAccount(email);
			if (email === activeAccount?.email) {
				navigate({ to: "/unlock", search: { email } });
			}
			toast.success("Account locked");
		} catch (error) {
			console.error("Failed to lock account:", error);
			toast.error("Failed to lock account");
		}
	};

	const handleLockAll = async () => {
		try {
			await lockAllAccounts();
			navigate({ to: "/unlock" });
			toast.success("All accounts locked");
		} catch (error) {
			console.error("Failed to lock all accounts:", error);
			toast.error("Failed to lock accounts");
		}
	};

	const handleRemoveAccount = async (email: string) => {
		try {
			await removeAccount(email);

			// Check if there are any accounts left
			const accountsList = await tauriStorage.getAccountsList();
			if (accountsList.accounts.length === 0) {
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

	const handleLogout = async () => {
		if (!activeAccount) return;

		try {
			await tauriStorage.clearAllStoredData(activeAccount.email);
			const accountsList = await tauriStorage.getAccountsList();

			if (accountsList.accounts.length === 0) {
				navigate({ to: "/login" });
			} else {
				// Switch to first remaining account
				await switchAccount(accountsList.accounts[0].email);
				navigate({ to: "/vault" });
			}
			toast.success("Logged out successfully");
		} catch (error) {
			console.error("Logout error:", error);
			toast.error("Failed to logout");
		}
	};

	if (!activeAccount) {
		return null;
	}

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="ghost"
						size="sm"
						className="gap-2"
						disabled={isSwitching}
					>
						<AccountAvatar account={activeAccount} size="sm" />
						<div className="flex flex-col items-start overflow-hidden">
							<span className="max-w-32 truncate font-medium text-sm">
								{activeAccount.teamName ||
									activeAccount.name ||
									activeAccount.email.split("@")[0]}
							</span>
						</div>
						<ChevronDown className="h-4 w-4 opacity-50" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="w-72">
					{allAccounts.map((account) => {
						const isActive =
							account.email.toLowerCase() === activeAccount.email.toLowerCase();

						return (
							<DropdownMenuItem
								key={account.email}
								onClick={() => handleSwitchAccount(account.email)}
								className="flex items-center gap-3 py-2"
							>
								<AccountAvatar account={account} size="sm" />
								<div className="flex flex-1 flex-col overflow-hidden">
									<span className="truncate font-medium">
										{account.teamName ||
											account.name ||
											account.email.split("@")[0]}
									</span>
									<span className="truncate text-muted-foreground text-xs">
										{account.email}
									</span>
								</div>
								{isActive && <Check className="h-4 w-4 text-primary" />}
							</DropdownMenuItem>
						);
					})}

					<DropdownMenuSeparator />

					<DropdownMenuItem onClick={handleAddAccount} className="gap-2">
						<Plus className="h-4 w-4" />
						Add Account
					</DropdownMenuItem>

					<DropdownMenuSeparator />

					<DropdownMenuItem
						onClick={() => handleLockAccount(activeAccount.email)}
						className="gap-2"
					>
						<Lock className="h-4 w-4" />
						Lock Current Account
					</DropdownMenuItem>

					{allAccounts.length > 1 && (
						<DropdownMenuItem onClick={handleLockAll} className="gap-2">
							<Lock className="h-4 w-4" />
							Lock All Accounts
						</DropdownMenuItem>
					)}

					<DropdownMenuSeparator />

					<DropdownMenuItem
						onClick={() => setAccountToRemove(activeAccount.email)}
						className="gap-2 text-destructive focus:text-destructive"
					>
						<LogOut className="h-4 w-4" />
						Remove Account
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>

			<RemoveAccountDialog
				email={accountToRemove}
				onConfirm={handleRemoveAccount}
				onCancel={() => setAccountToRemove(null)}
			/>
		</>
	);
}
