import { useAccountSwitcher } from "@bittery/core/hooks";
import {
	AccountSwitcher,
	Avatar,
	AvatarFallback,
	AvatarImage,
	Button,
	toast,
} from "@bittery/ui";
import { IconChevronDown } from "@bittery/ui/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { lockVaultThroughWorker } from "@/lib/lock-vault";
import { sendMessage } from "@/lib/messaging";
import { createExtensionInvalidator } from "@/lib/query-invalidation";
import { useSessionStatus } from "@/lib/session-status";
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
		switchAccount,
	} = useAccountSwitcher();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { m } = useI18n();
	const [isLockingAll, setIsLockingAll] = useState(false);
	const invalidator = useMemo(
		() => createExtensionInvalidator(queryClient),
		[queryClient],
	);

	// Query desktop sync status to get unlocked accounts from desktop
	const desktopStatus = useQuery({
		queryKey: ["desktop-sync-status"],
		queryFn: async () => {
			const response = await sendMessage({
				type: "CHECK_DESKTOP_STATUS",
			}).catch(() => null);
			return response?.success ? response : null;
		},
		refetchInterval: 5000, // Poll every 5 seconds
		staleTime: 2000,
	});

	const sessionStatus = useSessionStatus();
	// Shown until the worker says a desktop owns the lock, so the button does not
	// flicker on first paint; the refusal toast covers the remaining race window.
	const showLockAll = sessionStatus.data?.canLockLocally !== false;

	const accountsData = accounts;
	const localUnlockedAccountIds = unlockedAccountIds;

	// Merge local unlocked IDs with desktop unlocked accounts
	const desktopUnlockedAccountIds = desktopStatus.data?.available
		? (desktopStatus.data.unlockedAccounts ?? [])
		: [];

	// Combine and deduplicate
	const unlockedAccountIdsList = Array.from(
		new Set([...localUnlockedAccountIds, ...desktopUnlockedAccountIds]),
	);

	const activeAccountId = activeSelection ?? null;

	const handleSwitchAccount = async (accountId: string) => {
		if (accountId === activeAccountId) return;

		const account = accountsData.find((item) => item.accountId === accountId);
		if (!account) return;

		try {
			await switchAccount.mutateAsync(accountId);

			// Check if desktop is available and has this account unlocked
			const desktopStatus = await sendMessage({ type: "CHECK_DESKTOP_STATUS" });

			const isUnlockedInDesktop =
				desktopStatus.success &&
				desktopStatus.available &&
				desktopStatus.unlockedAccounts?.includes(accountId);

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
		if (isLockingAll) return;
		setIsLockingAll(true);
		// A refused lock resolves, it does not reject — branch on the decision, never on catch.
		const decision = await lockVaultThroughWorker();
		setIsLockingAll(false);

		if (!decision.ok) {
			toast.error(
				decision.code === "desktop_owns_lock"
					? m.ext_lock_refused_desktop_owns()
					: m.ext_account_switcher_toast_lock_failed(),
			);
			return;
		}

		queryClient.clear();
		navigate({ to: "/unlock" });
		toast.success(m.ext_account_switcher_toast_all_locked());
	};

	// Get active account for trigger display
	const activeAccount = accountsData.find(
		(a) => a.accountId === activeAccountId,
	);

	// Same initials precedence as the desktop app's AccountAvatar:
	// team name → personal name → email prefix.
	const getInitials = (account: {
		teamName?: string;
		name?: string;
		email: string;
	}) => {
		const source = account.teamName || account.name;
		if (source) {
			return source
				.split(" ")
				.map((part) => part[0])
				.join("")
				.toUpperCase()
				.slice(0, 2);
		}
		return account.email.substring(0, 2).toUpperCase();
	};

	// Custom trigger with AvatarGroup support
	const trigger = (
		<Button
			variant="ghost"
			size="sm"
			className="gap-2"
			disabled={switchAccount.isPending || isLockingAll}
		>
			{activeAccount ? (
				<>
					<Avatar className="size-6 rounded-md text-[10px]">
						{activeAccount.teamAvatarUrl && (
							<AvatarImage
								src={activeAccount.teamAvatarUrl}
								alt={activeAccount.teamName || activeAccount.name}
							/>
						)}
						<AvatarFallback className="size-6 rounded-md bg-linear-to-br from-primary to-primary-deep font-semibold text-[10px] text-primary-foreground shadow-[inset_0_0_0_1px_oklch(1_0_0/0.15)]">
							{getInitials(activeAccount)}
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
			<IconChevronDown className="h-4 w-4 opacity-50" />
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
			showLockAll={showLockAll}
			showSetupAnotherDevice={!desktopStatus.data?.available}
			isLoading={switchAccount.isPending || isLockingAll}
			trigger={trigger}
		/>
	);
}
