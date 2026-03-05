import { useAccountSwitcher } from "@bittery/core/hooks";
import { createAccountTrpcClient } from "@bittery/shared/trpc-client-factory";
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

/**
 * Extension-specific account switcher wrapper
 * Handles navigation and state management for multi-account support
 */
export function ExtensionAccountSwitcher() {
	const {
		accounts,
		activeAccount: activeAccountQuery,
		unlockedEmails,
		switchAccount,
		lockAllAccounts,
	} = useAccountSwitcher();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
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

	const accountsData = accounts.data ?? [];
	const localUnlockedEmails = unlockedEmails.data ?? [];

	// Merge local unlocked emails with desktop unlocked accounts
	const desktopUnlockedEmails =
		desktopStatus.data?.success && desktopStatus.data?.available
			? (desktopStatus.data?.unlockedAccounts ?? [])
			: [];

	// Combine and deduplicate
	const unlockedEmailsList = Array.from(
		new Set([...localUnlockedEmails, ...desktopUnlockedEmails]),
	);

	const activeAccountEmail =
		activeAccountQuery.data?.type === "single"
			? activeAccountQuery.data.email
			: activeAccountQuery.data?.type === "all"
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
					const authToken = await storage.getAuthToken(account.email);
					if (!authToken) continue;

					// Fetch user data from server
					const serverUrl =
						(await storage.getServerUrl(account.email)) ||
						"http://localhost:3000";
					const client = createAccountTrpcClient(authToken, serverUrl);

					const userData = await client.auth.me.query();

					// Update account with team name and avatar
					await storage.addAccount({
						...account,
						teamName: userData.teamName,
						teamAvatarUrl: userData.teamAvatarUrl,
					});

					// Refresh accounts list
					accounts.refetch();
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
	}, [accountsData, accounts]);

	const handleSwitchAccount = async (email: string) => {
		if (email === activeAccountEmail) return;

		try {
			await switchAccount.mutateAsync({ type: "single", email });

			// Check if desktop is available and has this account unlocked
			const desktopStatus = await chrome.runtime.sendMessage({
				type: "CHECK_DESKTOP_STATUS",
			});

			const isUnlockedInDesktop =
				desktopStatus?.success &&
				desktopStatus?.available &&
				desktopStatus?.unlockedAccounts?.includes(email);

			// Check local session validity
			const sessionValid = await storage.isSessionValid(email);

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
				navigate({ to: "/unlock", search: { email } });
			}
		} catch (error) {
			console.error("Failed to switch account:", error);
			toast.error("Failed to switch account");
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
			toast.success("All accounts locked");
		} catch (error) {
			console.error("Failed to lock all accounts:", error);
			toast.error("Failed to lock accounts");
		}
	};

	const handleAllAccountsSelect = async () => {
		// Check if we have any unlocked accounts
		if (unlockedEmailsList.length === 0) {
			toast.error(
				"No accounts are unlocked. Please unlock at least one account.",
			);
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
			toast.error("Failed to switch to All Accounts mode");
		}
	};

	// Get active account for trigger display
	const activeAccount = accountsData.find(
		(a) => a.email === activeAccountEmail,
	);
	const isAllAccountsMode = activeAccountEmail === "all";

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
							unlockedEmailsList.includes(a.email),
						)}
						maxVisible={2}
						size="sm"
					/>
					<div className="flex flex-col items-start overflow-hidden">
						<span className="max-w-32 truncate font-medium text-sm">
							All Accounts
						</span>
						<span className="text-muted-foreground text-xs">
							{unlockedEmailsList.length} unlocked
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
			activeEmail={activeAccountEmail}
			unlockedEmails={unlockedEmailsList}
			onAccountSelect={handleSwitchAccount}
			onAddAccount={handleAddAccount}
			showAddAccount={!desktopStatus.data?.available}
			onLockAll={handleLockAll}
			showAllAccountsOption={true}
			showSetupAnotherDevice={!desktopStatus.data?.available}
			onAllAccountsSelect={handleAllAccountsSelect}
			isLoading={accounts.isLoading || switchAccount.isPending}
			trigger={trigger}
		/>
	);
}
