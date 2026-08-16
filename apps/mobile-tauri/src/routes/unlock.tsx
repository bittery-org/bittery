import { useAccountSwitcher, useQuickUnlockAll } from "@bittery/core/hooks";
import { getBiometricUnlockAvailability } from "@bittery/core/services/auth-service";
import { unlockAllWithBiometric } from "@bittery/core/services/unlock";
import { toast } from "@bittery/ui";
import {
	IconFingerprint,
	IconKey,
	IconLock,
	IconUser,
} from "@bittery/ui/icons";
import { cn } from "@bittery/ui/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	AuthDivider,
	AuthTextAction,
	BrandSplash,
	InlineNotice,
	PasswordField,
	submitForm,
	UnlockLockup,
} from "@/components/auth-kit";
import {
	AccountAvatar,
	BrandButton,
	getAccountLabel,
	iconClass,
	Pressable,
	Screen,
	ScreenScroll,
} from "@/components/ui";
import { useMobileAccountRuntime } from "@/contexts/account-context";
import { mirrorBorrowedMasterUnlockKeysToCredentialProvider } from "@/lib/credential-provider-master-unlock-key";
import { lifecycleDeps } from "@/lib/lifecycle";
import { itemCache, storage } from "@/lib/storage";
import { useI18n } from "@/providers/i18n-provider";

interface UnlockSearchParams {
	autoTrigger?: boolean;
	autoTriggerId?: string;
}

export const Route = createFileRoute("/unlock")({
	component: UnlockPage,
	validateSearch: (search: Record<string, unknown>): UnlockSearchParams => {
		return {
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
	const { manager } = useMobileAccountRuntime();
	const [password, setPassword] = useState("");
	const hasAttemptedBiometric = useRef(false);
	// See `submitForm`: the gradient button is not a native submit control.
	const formRef = useRef<HTMLFormElement>(null);
	const lastAutoTriggerId = useRef<string | undefined>(undefined);
	const { autoTrigger, autoTriggerId } = Route.useSearch();

	const allAccounts = accounts;
	/**
	 * `apps/mobile/app/(auth)/unlock.tsx` mirrors the freshly borrowed MUKs into the
	 * credential provider on every unlock path, before it navigates. The sync hook would
	 * get there on its own a debounce later; doing it here is what makes autofill work
	 * *immediately* after an unlock.
	 *
	 * It never fails the unlock. A rejected mirror means autofill has stale keys for a few
	 * seconds until `useCredentialProviderSync` retries — a locked-out user would be worse.
	 */
	const mirrorUnlockedMuks = useCallback(async (unlocked: string[]) => {
		try {
			await mirrorBorrowedMasterUnlockKeysToCredentialProvider(unlocked);
		} catch (error) {
			console.warn(
				"[Unlock] Failed to mirror MUKs to credential provider",
				error,
			);
		}
	}, []);
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
			await mirrorUnlockedMuks(result.unlocked);
			await queryClient.invalidateQueries({ queryKey: ["accounts"] });

			showUnlockToast({
				unlockedCount: result.unlocked.length,
				failedCount: result.failed.length,
			});

			await manager.refresh();
			// No doors/reveal animation on mobile — go straight to the vault.
			navigate({ to: "/vault" });
		},
		onPartialSuccess: async (result) => {
			await mirrorUnlockedMuks(result.unlocked);
			await queryClient.invalidateQueries({ queryKey: ["accounts"] });

			toast.warning(getPartialUnlockMessage(result.unlocked.length));
			await manager.refresh();
			navigate({ to: "/vault" });
		},
		onError: (error) => {
			console.error("Unlock all error:", error);
			toast.error(m.toast_auth_unlock_error_failed());
		},
	});

	const performBiometricUnlockAll = useCallback(async () => {
		const { unlocked, failed } = await unlockAllWithBiometric(
			{
				// The reason is what the OS biometric dialog displays, so it is user-facing
				// copy and has to be translated here — storage's default is an English fallback.
				promptMessage: m.biometric_prompt_unlock_all_accounts(),
			},
			{
				storage,
				itemCache,
				credentialMirror: lifecycleDeps.credentialMirror,
			},
		);

		if (unlocked.length === 0) {
			throw new Error(m.toast_auth_unlock_error_biometric_none_unlocked());
		}

		await mirrorUnlockedMuks(unlocked);
		await queryClient.invalidateQueries({ queryKey: ["accounts"] });

		showUnlockToast({
			unlockedCount: unlocked.length,
			failedCount: failed.length,
			biometric: true,
		});

		await manager.refresh();
		navigate({ to: "/vault" });
	}, [m, manager, mirrorUnlockedMuks, navigate, queryClient, showUnlockToast]);

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

	// Auto-trigger biometric only for extension-initiated unlock requests. Nothing raises
	// this on mobile in M1 — there is no extension — but the param and its handling stay:
	// removing them would change `validateSearch`, and the desktop behaviour costs nothing
	// to keep dormant here.
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
			<Screen aurora>
				<BrandSplash />
			</Screen>
		);
	}

	// If no accounts, redirect to login
	if (allAccounts.length === 0) {
		navigate({ to: "/login" });
		return null;
	}

	const isSingleAccount = allAccounts.length === 1;
	const singleAccount = allAccounts[0];
	const accountFallback = m.mob_settings_account_fallback();

	return (
		<Screen aurora>
			<ScreenScroll inset="plain">
				{/* `min-h-full` + `justify-center` centres the form on a tall phone but lets it
				    grow past the fold once the keyboard is up. */}
				<div className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center gap-6 px-4 py-8">
					<UnlockLockup
						title={m.auth_signin_title_quick_unlock()}
						subtitle={
							isSingleAccount
								? m.auth_unlock_description_single()
								: m.auth_unlock_description_multiple({
										count: allAccounts.length,
									})
						}
					/>

					{/* Whose vault this is. One password unlocks every account, so several accounts
					    stack their avatars into the same card rather than each getting a row. */}
					<div className="flex items-center gap-3 rounded-2xl border border-border bg-surface p-3 shadow-surface">
						{isSingleAccount ? (
							<AccountAvatar account={singleAccount} />
						) : (
							<div className="flex shrink-0 items-center">
								{allAccounts.slice(0, 3).map((account, index) => (
									<AccountAvatar
										key={account.accountId}
										account={account}
										size={40}
										className={cn("ring-2 ring-surface", index > 0 && "-ml-4")}
									/>
								))}
							</div>
						)}
						<div className="min-w-0 flex-1">
							<p className="truncate font-medium text-base text-foreground">
								{isSingleAccount && singleAccount
									? getAccountLabel(singleAccount, accountFallback)
									: m.mob_unlock_all_accounts()}
							</p>
							<p className="truncate text-muted-foreground text-sm">
								{isSingleAccount && singleAccount
									? singleAccount.email
									: m.mob_unlock_accounts_count({
											count: String(allAccounts.length),
										})}
							</p>
						</div>
					</div>

					{requiresPasswordReentry && (
						<InlineNotice
							tone="warning"
							icon={IconKey}
							title={m.auth_unlock_password_required_title()}
							description={m.auth_unlock_password_required_description()}
						/>
					)}

					{/* The two ways in, on one rhythm. Biometric is the primary path on a phone —
					    first, and the one purple thing on the screen. On desktop it is the
					    secondary "or" option under the field. */}
					<div className="flex flex-col gap-4">
						{canUseBiometric && (
							<>
								<BrandButton
									size="lg"
									label={m.auth_unlock_action_biometric()}
									leading={<IconFingerprint className={iconClass.bar} />}
									onClick={handleBiometricUnlockAll}
									disabled={loading}
								/>
								<AuthDivider label={m.auth_unlock_divider_or()} />
							</>
						)}

						<form
							ref={formRef}
							onSubmit={handlePasswordUnlock}
							className="flex flex-col gap-4"
						>
							<PasswordField
								id="password"
								label={m.auth_signin_label_password()}
								icon={IconLock}
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								required
								placeholder={m.auth_signin_placeholder_password()}
								autoFocus={!canUseBiometric}
								disabled={loading}
								autoComplete="current-password"
								autoCapitalize="none"
								autoCorrect="off"
							/>

							{/* One primary action per screen: when biometric owns the gradient, the
							    password submit steps down to a neutral card button. */}
							{canUseBiometric ? (
								<Pressable
									onClick={() => submitForm(formRef.current)}
									disabled={loading}
									scale
									className="flex h-13 w-full items-center justify-center rounded-xl border border-border bg-surface font-semibold text-base text-foreground shadow-surface"
								>
									{m.auth_unlock_action_unlock()}
								</Pressable>
							) : (
								<BrandButton
									size="lg"
									label={m.auth_unlock_action_unlock()}
									onClick={() => submitForm(formRef.current)}
									isLoading={loading}
								/>
							)}
						</form>
					</div>

					{/*
					 * The way out. Without it a locked device with a stored account can only ever
					 * reach that account: `/login` is otherwise only reachable from the account
					 * sheet, which lives behind the unlock this screen is asking for. Matches
					 * `apps/mobile/app/(auth)/unlock.tsx`.
					 */}
					<AuthTextAction
						icon={IconUser}
						label={m.mob_unlock_different_account()}
						onPress={() => navigate({ to: "/login" })}
					/>
				</div>
			</ScreenScroll>
		</Screen>
	);
}
