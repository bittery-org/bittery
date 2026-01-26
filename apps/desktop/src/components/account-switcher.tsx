import {
	Badge,
	Button,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
	toast,
} from "@bittery/ui";
import { useAccountSwitcher } from "@bittery/hooks";
import { useNavigate } from "@tanstack/react-router";
import { Check, ChevronDown, Lock, LogOut, Plus, Settings } from "lucide-react";
import { useState } from "react";
import { storage } from "@/lib/storage";
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
	const navigate = useNavigate();
	const [accountToRemove, setAccountToRemove] = useState<string | null>(null);
	const [showSettings, setShowSettings] = useState(false);

	const accountsData = accounts.data ?? [];
	const unlockedEmailsList = unlockedEmails.data ?? [];
	const activeAccount = accountsData.find(
		(a) => a.email === activeEmail.data,
	);

	const handleSwitchAccount = async (email: string) => {
		if (email === activeEmail.data) return;

		try {
			await switchAccount.mutateAsync(email);

			// Check if session is valid for the switched account
			const sessionValid = await storage.isSessionValid(email);
			if (!sessionValid) {
				navigate({ to: "/unlock", search: { email } });
			} else {
				navigate({ to: "/vault" });
			}
		} catch (error) {
			console.error("Failed to switch account:", error);
			toast.error("Failed to switch account");
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
						disabled={switchAccount.isPending}
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
					{/* Account List */}
					{accountsData.map((account) => {
						const isActive = account.email === activeEmail.data;
						const isUnlocked = unlockedEmailsList.includes(account.email);

						return (
							<DropdownMenuItem
								key={account.email}
								onClick={() => handleSwitchAccount(account.email)}
								className="flex items-center gap-3 py-2"
							>
								<AccountAvatar account={account} size="sm" />
								<div className="flex flex-1 flex-col overflow-hidden">
									<div className="flex items-center gap-1.5">
										<span className="truncate font-medium">
											{account.teamName ||
												account.name ||
												account.email.split("@")[0]}
										</span>
										{isActive && <Check className="h-4 w-4 text-primary" />}
									</div>
									<span className="truncate text-muted-foreground text-xs">
										{account.email}
									</span>
								</div>
								{isUnlocked && (
									<Badge variant="secondary" className="shrink-0 text-xs">
										Unlocked
									</Badge>
								)}
							</DropdownMenuItem>
						);
					})}

					<DropdownMenuSeparator />

					{/* Add Account */}
					<DropdownMenuItem onClick={handleAddAccount} className="gap-2">
						<Plus className="h-4 w-4" />
						Add Account
					</DropdownMenuItem>

					{/* Account Settings */}
					<DropdownMenuItem
						onClick={() => setShowSettings(true)}
						className="gap-2"
					>
						<Settings className="h-4 w-4" />
						Account Settings
					</DropdownMenuItem>

					<DropdownMenuSeparator />

					{/* Lock All Accounts */}
					{accountsData.length > 0 && unlockedEmailsList.length > 0 && (
						<DropdownMenuItem onClick={handleLockAll} className="gap-2">
							<Lock className="h-4 w-4" />
							Lock All Accounts
						</DropdownMenuItem>
					)}

					<DropdownMenuSeparator />

					{/* Remove Current Account */}
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

			<AccountSettingsDialog
				open={showSettings}
				onOpenChange={setShowSettings}
				email={activeAccount.email}
			/>
		</>
	);
}
