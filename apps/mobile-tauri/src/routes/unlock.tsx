import { useAccountSwitcher, useQuickUnlockAll } from "@bittery/core/hooks";
import { getBiometricUnlockAvailability } from "@bittery/core/services/auth-service";
import { unlockAllWithBiometric } from "@bittery/core/services/unlock";
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
	const [showPassword, setShowPassword] = useState(false);
	const hasAttemptedBiometric = useRef(false);
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
			<div className="flex min-h-dvh items-center justify-center">
				<div className="flex items-center justify-center rounded-full border border-border bg-background p-4 shadow-sm">
					<IconLoaderCircle className="size-7 animate-spin text-primary" />
				</div>
			</div>
		);
	}

	// If no accounts, redirect to login
	if (allAccounts.length === 0) {
		navigate({ to: "/login" });
		return null;
	}

	return (
		<div className="flex min-h-dvh flex-col overflow-y-auto px-6 py-10">
			<div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-2">
				<div className="mb-5 flex justify-center">
					<AvatarGroup accounts={allAccounts} maxVisible={3} size="lg" />
				</div>

				<h1 className="text-center font-semibold text-lg tracking-tight">
					{m.auth_signin_title_quick_unlock()}
				</h1>
				<p className="mb-6 text-center text-muted-foreground text-sm">
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

				{/* Biometric is the primary path on a phone — large, first, and prominent.
				    On desktop it is the secondary "or" option under the password field. */}
				{canUseBiometric && (
					<div className="mb-6 flex flex-col items-center gap-3">
						<Button
							type="button"
							variant="outline"
							className="h-20 w-20 rounded-full p-0"
							onClick={handleBiometricUnlockAll}
							disabled={loading}
							aria-label={m.auth_unlock_action_biometric()}
						>
							<IconFingerprint className="size-9 text-primary dark:drop-shadow-[0_0_5px_color-mix(in_oklab,var(--color-primary)_45%,transparent)]" />
						</Button>
						<p className="font-medium text-sm">
							{m.auth_unlock_action_biometric()}
						</p>
					</div>
				)}

				{canUseBiometric && (
					<div className="my-2 flex items-center gap-2.5">
						<span aria-hidden className="h-px flex-1 bg-border" />
						<span className="font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
							{m.auth_unlock_divider_or()}
						</span>
						<span aria-hidden className="h-px flex-1 bg-border" />
					</div>
				)}

				<form onSubmit={handlePasswordUnlock} className="w-full">
					<InputGroup className="h-12">
						<InputGroupInput
							id="password"
							type={showPassword ? "text" : "password"}
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							required
							placeholder={m.auth_signin_placeholder_password()}
							autoFocus={!canUseBiometric}
							disabled={loading}
							className="text-base"
							autoComplete="current-password"
							autoCapitalize="none"
							autoCorrect="off"
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

					<Button
						type="submit"
						className="mt-3 h-12 w-full text-base"
						disabled={loading}
					>
						{loading && <IconLoaderCircle className="size-4 animate-spin" />}
						{m.auth_unlock_action_unlock()}
					</Button>
				</form>
			</div>
		</div>
	);
}
