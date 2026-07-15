import { useAccountSwitcher } from "@bittery/core/hooks";
import { createAccountRpcClient } from "@bittery/shared/rpc-client-factory";
import {
	AccountAvatarGroup,
	AccountSwitcher,
	Avatar,
	AvatarFallback,
	AvatarImage,
	Button,
	toast,
} from "@bittery/ui";
import { IconChevronDownOutlineDuo18 } from "@bittery/ui/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { createExtensionInvalidator } from "@/lib/query-invalidation";
import { storage } from "@/lib/storage";
import { useI18n } from "@/providers/i18n-provider";

/**
 * Extension-specific account switcher wrapper
 * Handles navigation and state management for multi-account support
 */
export function ExtensionAccountSwitcher() {
	const {
		accounts,
		activeAccount: activeSelection,
		unlockedAccountIds,
		refresh,
		switchAccount,
		lockAllAccounts,
	} = useAccountSwitcher();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { m } = useI18n();
	const invalidator = useMemo(
		() => createExtensionInvalidator(queryClient),
		[queryClient],
	);

	// Query desktop sync status to get unlocked accounts from desktop
	const desktopStatus = useQuery({
		queryKey: ["desktop-sync-status"],
		queryFn: async () => {
			try {
				const response = await chrome.runtime.sendMessage({
					type: "CHECK_DESKTOP_STATUS",
				});
				return response;
			} catch {
				return null;
			}
		},
		refetchInterval: 5000, // Poll every 5 seconds
		staleTime: 2000,
	});

	const accountsData = accounts;
	const localUnlockedAccountIds = unlockedAccountIds;

	// Merge local unlocked IDs with desktop unlocked accounts
	const desktopUnlockedAccountIds =
		desktopStatus.data?.success && desktopStatus.data?.available
			? (desktopStatus.data?.unlockedAccounts ?? [])
			: [];

	// Combine and deduplicate
	const unlockedAccountIdsList = Array.from(
		new Set([...localUnlockedAccountIds, ...desktopUnlockedAccountIds]),
	);

	const activeAccountId =
		activeSelection?.type === "single"
			? activeSelection.accountId
			: activeSelection?.type === "all"
				? "all"
				: null;
	// Update team names for accounts that don't have them
	useEffect(() => {
		const updateMissingTeamNames = async () => {
			for (const account of accountsData) {
				// Skip if account already has team name
				if (account.teamName) continue;

				try {
					// Get auth token for this account
					const authToken = await storage.getAuthToken(account.accountId);
					if (!authToken) continue;

					const serverUrl =
						(await storage.getServerUrl(account.accountId)) ||
						"http://localhost:3000";
					const client = createAccountRpcClient(authToken, serverUrl);

					const userData = await client.auth.me.query();

					// Update account with team name and avatar
					await storage.addAccount({
						...account,
						teamName: userData.teamName ?? undefined,
						teamAvatarUrl: userData.teamAvatarUrl ?? undefined,
					});

					// Refresh accounts list
					await refresh();
				} catch (error) {
					console.error(
						`[account-switcher] Failed to fetch team name for ${account.email}:`,
						error,
					);
				}
			}
		};

		if (accountsData.length > 0) {
			updateMissingTeamNames();
		}
	}, [accountsData, refresh]);

	const handleSwitchAccount = async (accountId: string) => {
		if (accountId === activeAccountId) return;

		const account = accountsData.find((item) => item.accountId === accountId);
		if (!account) return;

		try {
			await switchAccount.mutateAsync({
				type: "single",
				accountId,
			});

			// Check if desktop is available and has this account unlocked
			const desktopStatus = await chrome.runtime.sendMessage({
				type: "CHECK_DESKTOP_STATUS",
			});

			const isUnlockedInDesktop =
				desktopStatus?.success &&
				desktopStatus?.available &&
				desktopStatus?.unlockedAccounts?.includes(accountId);

			// Check local session validity
			const sessionValid = await storage.isSessionValid(accountId);

			// If account is unlocked in desktop OR has valid local session, just switch
			if (isUnlockedInDesktop || sessionValid) {
				// Invalidate account-related data to clear cache from previous account
				await Promise.all([
					invalidator.invalidateVaultKeys(),
					queryClient.invalidateQueries({ queryKey: ["vault-items"] }),
					queryClient.invalidateQueries({ queryKey: ["items"] }),
					queryClient.invalidateQueries({ queryKey: ["accounts"] }),
				]);
			} else {
				// Need to unlock - redirect to unlock screen with the account email
				navigate({ to: "/unlock", search: { email: account.email } });
			}
		} catch (error) {
			console.error("Failed to switch account:", error);
			toast.error(m.ext_account_switcher_toast_switch_failed());
		}
	};

	const handleAddAccount = () => {
		// Navigate to login with addingAccount flag
		navigate({ to: "/login", search: { addingAccount: true } });
	};

	const handleLockAll = async () => {
		try {
			await lockAllAccounts.mutateAsync();
			navigate({ to: "/unlock" });
			toast.success(m.ext_account_switcher_toast_all_locked());
		} catch (error) {
			console.error("Failed to lock all accounts:", error);
			toast.error(m.ext_account_switcher_toast_lock_failed());
		}
	};

	const handleAllAccountsSelect = async () => {
		// Check if we have any unlocked accounts
		if (unlockedAccountIdsList.length === 0) {
			toast.error(m.ext_account_switcher_toast_no_unlocked());
			return;
		}

		try {
			await switchAccount.mutateAsync({ type: "all" });
			// Invalidate account-related data to refresh multi-account view
			await Promise.all([
				invalidator.invalidateVaultKeys(),
				queryClient.invalidateQueries({ queryKey: ["vault-items"] }),
				queryClient.invalidateQueries({ queryKey: ["items"] }),
				queryClient.invalidateQueries({ queryKey: ["accounts"] }),
			]);
		} catch (error) {
			console.error("Failed to switch to All Accounts mode:", error);
			toast.error(m.ext_account_switcher_toast_all_accounts_failed());
		}
	};

	// Get active account for trigger display
	const activeAccount = accountsData.find(
		(a) => a.accountId === activeAccountId,
	);
	const isAllAccountsMode = activeAccountId === "all";

	// Helper to get avatar color
	const getAvatarColor = (email: string) => {
		let hash = 0;
		for (let i = 0; i < email.length; i++) {
			hash = email.charCodeAt(i) + ((hash << 5) - hash);
		}
		const hue = hash % 360;
		return `hsl(${hue}, 70%, 50%)`;
	};

	// Custom trigger with AvatarGroup support
	const trigger = (
		<Button
			variant="ghost"
			size="sm"
			className="gap-2"
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
						<span className="max-w-32 truncate font-medium text-sm">
							{m.ext_account_switcher_all_accounts()}
						</span>
						<span className="text-muted-foreground text-xs">
							{m.ext_account_switcher_unlocked_count({
								count: unlockedAccountIdsList.length,
							})}
						</span>
					</div>
				</>
			) : activeAccount ? (
				<>
					<Avatar className="h-6 w-6">
						{activeAccount.teamAvatarUrl && (
							<AvatarImage
								src={activeAccount.teamAvatarUrl}
								alt={activeAccount.teamName || activeAccount.name}
							/>
						)}
						<AvatarFallback
							className="font-medium text-white text-xs"
							style={{ backgroundColor: getAvatarColor(activeAccount.email) }}
						>
							{activeAccount.email.slice(0, 2).toUpperCase()}
						</AvatarFallback>
					</Avatar>
					<div className="flex flex-col items-start overflow-hidden">
						<span className="max-w-32 truncate font-medium text-sm">
							{activeAccount.teamName ||
								activeAccount.name ||
								activeAccount.email.split("@")[0]}
						</span>
					</div>
				</>
			) : null}
			<IconChevronDownOutlineDuo18 className="h-4 w-4 opacity-50" />
		</Button>
	);

	return (
		<AccountSwitcher
			accounts={accountsData}
			activeAccountId={activeAccountId}
			unlockedAccountIds={unlockedAccountIdsList}
			onAccountSelect={handleSwitchAccount}
			onAddAccount={handleAddAccount}
			showAddAccount={!desktopStatus.data?.available}
			onLockAll={handleLockAll}
			showLockAll={!desktopStatus.data?.available}
			showAllAccountsOption={true}
			showSetupAnotherDevice={!desktopStatus.data?.available}
			onAllAccountsSelect={handleAllAccountsSelect}
			isLoading={switchAccount.isPending}
			trigger={trigger}
		/>
	);
}
