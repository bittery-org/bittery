import {
	useAccountSwitcher,
	useQuickUnlockAll,
} from "@bittery/core/hooks";
import { getBiometricUnlockAvailability } from "@bittery/core";
import { peekAccountSessionManager } from "@bittery/core/services/account-session-manager";
import {
	AccountAvatarGroup as AvatarGroup,
	ButtonGroup,
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
	toast,
} from "@bittery/ui";
import {
	IconEyeOutlineDuo18,
	IconEyeSlashOutlineDuo18,
	IconFingerprintOutlineDuo18,
	IconKeyOutlineDuo18,
	IconLoader2Fill18,
} from "@bittery/ui/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { AuthDoorsLayout } from "@/components/auth/auth-doors-layout";
import { triggerAuthRevealToVault } from "@/lib/auth-reveal-transition";
import { storage } from "@/lib/storage";
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

			// Set active account to "all" mode if multiple accounts
			if (allAccounts.length > 1) {
				await storage.setActiveAccount({ type: "all" });
			} else if (allAccounts.length === 1) {
				await storage.setActiveAccount({
					type: "single",
					accountId: allAccounts[0].accountId,
				});
			}

			showUnlockToast({
				unlockedCount: result.unlocked.length,
				failedCount: result.failed.length,
			});

			await peekAccountSessionManager()?.refresh();
			triggerAuthRevealToVault();
		},
		onPartialSuccess: async (result) => {
			await queryClient.invalidateQueries({ queryKey: ["accounts"] });

			if (allAccounts.length > 1) {
				await storage.setActiveAccount({ type: "all" });
			}
			toast.warning(getPartialUnlockMessage(result.unlocked.length));
			await peekAccountSessionManager()?.refresh();
			triggerAuthRevealToVault();
		},
		onError: (error) => {
			console.error("Unlock all error:", error);
			toast.error(m.toast_auth_unlock_error_failed());
		},
	});

	// Biometric unlock all accounts with ONE prompt
	const handleBiometricUnlockAll = async () => {
		try {
			// Use the unified biometric unlock method that shows ONE prompt for all accounts
			if (!storage.unlockAllAccountsWithBiometric) {
				throw new Error(m.toast_auth_unlock_error_biometric_not_supported());
			}

			const { unlocked, failed } =
				await storage.unlockAllAccountsWithBiometric();

			if (unlocked.length === 0) {
				throw new Error(m.toast_auth_unlock_error_biometric_none_unlocked());
			}

			// Set active mode
			if (allAccounts.length > 1) {
				await storage.setActiveAccount({ type: "all" });
			} else {
				await storage.setActiveAccount({
					type: "single",
					accountId: allAccounts[0].accountId,
				});
			}

			await queryClient.invalidateQueries({ queryKey: ["accounts"] });

			showUnlockToast({
				unlockedCount: unlocked.length,
				failedCount: failed.length,
				biometric: true,
			});

			await peekAccountSessionManager()?.refresh();
			triggerAuthRevealToVault();
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
					if (!storage.unlockAllAccountsWithBiometric) {
						throw new Error(
							m.toast_auth_unlock_error_biometric_not_supported(),
						);
					}

					const { unlocked, failed } =
						await storage.unlockAllAccountsWithBiometric();

					if (unlocked.length === 0) {
						throw new Error(
							m.toast_auth_unlock_error_biometric_none_unlocked(),
						);
					}

					// Set active mode
					if (allAccounts.length > 1) {
						await storage.setActiveAccount({ type: "all" });
					} else {
						await storage.setActiveAccount({
							type: "single",
							accountId: allAccounts[0].accountId,
						});
					}

					await queryClient.invalidateQueries({ queryKey: ["accounts"] });

					showUnlockToast({
						unlockedCount: unlocked.length,
						failedCount: failed.length,
						biometric: true,
					});

					await peekAccountSessionManager()?.refresh();
					triggerAuthRevealToVault();
				} catch (error) {
					console.error("Biometric unlock error:", error);
					// Don't show toast on auto-trigger failure - user can manually try
				}
			}, 100);

			return () => clearTimeout(timeout);
		}
	}, [autoTrigger, allAccounts, queryClient, m, showUnlockToast]);

	// Show loading state while accounts are being fetched
	if (!isInitialized) {
		return (
			<AuthDoorsLayout showFooter={false}>
				<div className="flex items-center justify-center rounded-full border border-border bg-white p-4 shadow-sm dark:bg-gray-900">
					<IconLoader2Fill18 className="size-7 animate-spin text-primary" />
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

				{requiresPasswordReentry && (
					<div className="mb-6 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
						<IconKeyOutlineDuo18 className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
						<div>
							<p className="font-medium text-amber-800">
								{m.auth_unlock_password_required_title()}
							</p>
							<p className="text-amber-700 text-sm">
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
							className="text-base"
							onKeyDown={(e) => {
								if (e.key === "Enter" && !loading) {
									handlePasswordUnlock(e as unknown as React.FormEvent);
								}
							}}
						/>
						<InputGroupAddon align="inline-end">
							<ButtonGroup>
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
										<IconEyeSlashOutlineDuo18
											className="h-4 w-4"
											strokeWidth={1}
										/>
									) : (
										<IconEyeOutlineDuo18 className="h-4 w-4" strokeWidth={1} />
									)}
								</InputGroupButton>
								{canUseBiometric && (
									<InputGroupButton
										type="button"
										size="icon-sm"
										onClick={handleBiometricUnlockAll}
										disabled={loading}
										aria-label={m.auth_unlock_action_biometric()}
										className="text-primary hover:text-primary/80"
									>
										<IconFingerprintOutlineDuo18 className="h-5 w-5" />
									</InputGroupButton>
								)}
							</ButtonGroup>
						</InputGroupAddon>
					</InputGroup>
				</form>

				<p className="mt-4 text-muted-foreground text-sm">
					{allAccounts.length === 1
						? m.auth_unlock_description_single()
						: m.auth_unlock_description_multiple({
								count: allAccounts.length,
							})}
				</p>
			</div>
		</AuthDoorsLayout>
	);
}
