import { getBiometricUnlockAvailability } from "@bittery/core";
import { useAccountSwitcher, useQuickUnlockAll } from "@bittery/core/hooks";
import { createStoredAccountRpcClient } from "@bittery/core/services/account-resolver";
import { peekAccountSessionManager } from "@bittery/core/services/account-session-manager";
import { selectActiveAccountAfterUnlock } from "@bittery/core/services/select-active-account";
import { getTravelModeEnforcer } from "@bittery/core/services/travel-mode-enforcer";
import {
	AccountAvatarGroup as AvatarGroup,
	Button,
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
	toast,
} from "@bittery/ui";
import {
	IconEye,
	IconEyeOff,
	IconFingerprint,
	IconKey,
	IconLoaderCircle,
} from "@bittery/ui/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AuthDoorsLayout } from "@/components/auth/auth-doors-layout";
import { triggerAuthRevealToVault } from "@/lib/auth-reveal-transition";
import { itemCache, storage } from "@/lib/storage";
import { useI18n } from "@/providers/i18n-provider";

interface UnlockSearchParams {
	email?: string;
	autoTrigger?: boolean;
	autoTriggerId?: string;
}

export const Route = createFileRoute("/unlock")({
	component: UnlockPage,
	validateSearch: (search: Record<string, unknown>): UnlockSearchParams => {
		return {
			email: typeof search.email === "string" ? search.email : undefined,
			autoTrigger: search.autoTrigger === true || search.autoTrigger === "true",
			autoTriggerId:
				typeof search.autoTriggerId === "string"
					? search.autoTriggerId
					: undefined,
		};
	},
});

export function UnlockPage() {
	const { m } = useI18n();
	const navigate = useNavigate();
	const { accounts, isInitialized } = useAccountSwitcher();
	const queryClient = useQueryClient();
	const [password, setPassword] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const hasAttemptedBiometric = useRef(false);
	const lastAutoTriggerId = useRef<string | undefined>(undefined);
	const { autoTrigger, autoTriggerId } = Route.useSearch();

	const allAccounts = accounts;
	const getPartialUnlockMessage = useCallback(
		(unlockedCount: number) =>
			m.toast_auth_unlock_warning_partial({
				unlockedCount,
				totalCount: allAccounts.length,
			}),
		[allAccounts.length, m],
	);
	const showUnlockToast = useCallback(
		({
			unlockedCount,
			failedCount,
			biometric = false,
		}: {
			unlockedCount: number;
			failedCount: number;
			biometric?: boolean;
		}) => {
			if (failedCount === 0) {
				if (allAccounts.length === 1) {
					toast.success(
						biometric
							? m.toast_auth_unlock_success_biometric_single()
							: m.toast_auth_unlock_success_single(),
					);
					return;
				}

				toast.success(
					m.toast_auth_unlock_success_all({ count: unlockedCount }),
				);
				return;
			}

			toast.warning(getPartialUnlockMessage(unlockedCount));
		},
		[allAccounts.length, getPartialUnlockMessage, m],
	);

	// Unlocking may free several accounts, but the app operates on a single
	// active one. Return the user to whichever account they were last using;
	// callers pass only the accounts that are actually usable.
	const applyActiveAccountAfterUnlock = useCallback(
		async (unlockedAccountIds: string[]) => {
			const previousActive = await storage.getActiveAccount();
			const activeId = selectActiveAccountAfterUnlock({
				previousActive,
				unlockedAccountIds,
				accounts: allAccounts,
			});
			const unchanged =
				previousActive?.type === "single" &&
				previousActive.accountId === activeId;
			if (activeId && !unchanged) {
				await storage.setActiveAccount({ type: "single", accountId: activeId });
			}
		},
		[allAccounts],
	);

	const accountIds = allAccounts.map((account) => account.accountId);
	const biometricAvailability = useQuery({
		queryKey: ["auth", "biometricAvailability", ...accountIds],
		queryFn: () => getBiometricUnlockAvailability(storage, accountIds),
		enabled: accountIds.length > 0,
		staleTime: 5 * 1000,
	});

	// Unlock all accounts at once with password
	const quickUnlockAll = useQuickUnlockAll({
		onSuccess: async (result) => {
			await queryClient.invalidateQueries({ queryKey: ["accounts"] });

			await applyActiveAccountAfterUnlock(result.unlocked);

			showUnlockToast({
				unlockedCount: result.unlocked.length,
				failedCount: result.failed.length,
			});

			await peekAccountSessionManager()?.refresh();
			triggerAuthRevealToVault();
		},
		onPartialSuccess: async (result) => {
			await queryClient.invalidateQueries({ queryKey: ["accounts"] });

			await applyActiveAccountAfterUnlock(result.unlocked);
			toast.warning(getPartialUnlockMessage(result.unlocked.length));
			await peekAccountSessionManager()?.refresh();
			triggerAuthRevealToVault();
		},
		onError: (error) => {
			console.error("Unlock all error:", error);
			toast.error(m.toast_auth_unlock_error_failed());
		},
	});

	// Biometric unlock all accounts with ONE prompt.
	// Travel mode is a SECURITY feature and MUST fail closed: after the
	// biometric MUK restore we verify the server-side travel mode policy for
	// every unlocked account (mirroring the single-account biometric path) and
	// tear down the session for any account whose policy cannot be verified so
	// its hidden vaults are never exposed.
	const performBiometricUnlockAll = useCallback(async () => {
		// One prompt for every account. `AccountStore` is total, so there is nothing to
		// feature-detect: on a machine without biometrics this simply reports every account
		// as failed.
		//
		// The reason is what the OS biometric dialog displays, so it is user-facing copy and
		// has to be translated here — storage's own default is an English fallback.
		const { unlocked, failed } = await storage.unlockAllAccountsWithBiometric(
			m.biometric_prompt_unlock_all_accounts(),
		);

		// Enforce travel mode per unlocked accountId. verifyForUnlock fetches
		// (or, offline, hydrates the verified) policy and purges hidden vaults.
		const verified: string[] = [];
		let travelModeFailures = 0;
		for (const accountId of unlocked) {
			const client = await createStoredAccountRpcClient(
				storage,
				accountId,
			).catch(() => null);
			try {
				await getTravelModeEnforcer(storage, itemCache).verifyForUnlock(
					accountId,
					client,
				);
				verified.push(accountId);
			} catch {
				// Fail closed: never leave this account's hidden vaults exposed.
				await storage.clearSession(accountId);
				travelModeFailures += 1;
			}
		}

		if (verified.length === 0) {
			throw new Error(m.toast_auth_unlock_error_biometric_none_unlocked());
		}

		// Only `verified` may be selected from: an account that failed travel
		// mode verification must never become active.
		await applyActiveAccountAfterUnlock(verified);

		await queryClient.invalidateQueries({ queryKey: ["accounts"] });

		showUnlockToast({
			unlockedCount: verified.length,
			failedCount: failed.length + travelModeFailures,
			biometric: true,
		});

		await peekAccountSessionManager()?.refresh();
		triggerAuthRevealToVault();
	}, [applyActiveAccountAfterUnlock, m, queryClient, showUnlockToast]);

	const handleBiometricUnlockAll = async () => {
		try {
			await performBiometricUnlockAll();
		} catch (error) {
			console.error("Biometric unlock error:", error);
			toast.error(
				error instanceof Error
					? error.message
					: m.toast_auth_unlock_error_biometric_failed(),
			);
		}
	};

	const handlePasswordUnlock = async (e: React.FormEvent) => {
		e.preventDefault();

		// Unlock all accounts with the same password
		quickUnlockAll.mutate({ password });
	};

	const loading = quickUnlockAll.isPending;
	const canUseBiometric = biometricAvailability.data?.canUnlock ?? false;
	const requiresPasswordReentry =
		biometricAvailability.data?.requiresPasswordReentry ?? false;

	// Reset attempt flag on each extension trigger event.
	useEffect(() => {
		if (!autoTrigger) {
			return;
		}
		if (lastAutoTriggerId.current === autoTriggerId) {
			return;
		}
		lastAutoTriggerId.current = autoTriggerId;
		hasAttemptedBiometric.current = false;
	}, [autoTrigger, autoTriggerId]);

	// Auto-trigger biometric only for extension-initiated unlock requests.
	// Manual/app-initiated locks should remain locked until user action.
	useEffect(() => {
		if (
			autoTrigger &&
			!hasAttemptedBiometric.current &&
			allAccounts.length > 0
		) {
			hasAttemptedBiometric.current = true;
			// Small delay to ensure everything is initialized
			const timeout = setTimeout(async () => {
				try {
					await performBiometricUnlockAll();
				} catch (error) {
					console.error("Biometric unlock error:", error);
					// Don't show toast on auto-trigger failure - user can manually try
				}
			}, 100);

			return () => clearTimeout(timeout);
		}
	}, [autoTrigger, allAccounts, performBiometricUnlockAll]);

	// Show loading state while accounts are being fetched
	if (!isInitialized) {
		return (
			<AuthDoorsLayout showFooter={false}>
				<div className="flex items-center justify-center rounded-full border border-border bg-background p-4 shadow-sm">
					<IconLoaderCircle className="size-7 animate-spin text-primary" />
				</div>
			</AuthDoorsLayout>
		);
	}

	// If no accounts, redirect to login
	if (allAccounts.length === 0) {
		navigate({ to: "/login" });
		return null;
	}

	return (
		<AuthDoorsLayout showFooter={false}>
			<div className="w-full max-w-sm lg:pt-6">
				<div className="mb-5">
					<AvatarGroup accounts={allAccounts} maxVisible={3} size="lg" />
				</div>

				<h1 className="font-semibold text-lg tracking-tight">
					{m.auth_signin_title_quick_unlock()}
				</h1>
				<p className="mt-1 mb-6 text-muted-foreground text-sm">
					{allAccounts.length === 1
						? m.auth_unlock_description_single()
						: m.auth_unlock_description_multiple({
								count: allAccounts.length,
							})}
				</p>

				{requiresPasswordReentry && (
					<div className="mb-6 flex items-start gap-3 rounded-lg border border-amber-200/60 bg-amber-50/50 p-4 dark:border-amber-500/20 dark:bg-amber-950/20">
						<IconKey className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
						<div>
							<p className="font-medium text-amber-900 text-sm dark:text-amber-200">
								{m.auth_unlock_password_required_title()}
							</p>
							<p className="mt-0.5 text-amber-800/70 text-xs dark:text-amber-300/70">
								{m.auth_unlock_password_required_description()}
							</p>
						</div>
					</div>
				)}

				<form onSubmit={handlePasswordUnlock} className="w-full">
					<InputGroup>
						<InputGroupInput
							id="password"
							type={showPassword ? "text" : "password"}
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							required
							placeholder={m.auth_signin_placeholder_password()}
							autoFocus
							disabled={loading}
						/>
						<InputGroupAddon align="inline-end">
							<InputGroupButton
								type="button"
								size="icon-sm"
								onClick={() => setShowPassword(!showPassword)}
								disabled={loading}
								aria-label={
									showPassword
										? m.vaults_detail_items_form_login_action_hide_password()
										: m.vaults_detail_items_form_login_action_show_password()
								}
							>
								{showPassword ? (
									<IconEyeOff className="h-4 w-4" strokeWidth={1} />
								) : (
									<IconEye className="h-4 w-4" strokeWidth={1} />
								)}
							</InputGroupButton>
						</InputGroupAddon>
					</InputGroup>

					<Button type="submit" className="mt-3 w-full" disabled={loading}>
						{loading && <IconLoaderCircle className="size-4 animate-spin" />}
						{m.auth_unlock_action_unlock()}
					</Button>
				</form>

				{canUseBiometric && (
					<>
						<div className="my-4 flex items-center gap-2.5">
							<span aria-hidden className="h-px flex-1 bg-border" />
							<span className="font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
								{m.auth_unlock_divider_or()}
							</span>
							<span aria-hidden className="h-px flex-1 bg-border" />
						</div>

						<Button
							type="button"
							variant="outline"
							className="w-full"
							onClick={handleBiometricUnlockAll}
							disabled={loading}
						>
							<IconFingerprint className="size-4.5 text-primary dark:drop-shadow-[0_0_5px_color-mix(in_oklab,var(--color-primary)_45%,transparent)]" />
							{m.auth_unlock_action_biometric()}
						</Button>
					</>
				)}
			</div>
		</AuthDoorsLayout>
	);
}
