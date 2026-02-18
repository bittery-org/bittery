import {
	useAccountSwitcher,
	useQuickUnlockAll,
	useSessionState,
} from "@bittery/core/hooks";
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
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { AuthDoorsLayout } from "@/components/auth/auth-doors-layout";
import { triggerAuthRevealToVault } from "@/lib/auth-reveal-transition";
import { storage } from "@/lib/storage";

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
	const navigate = useNavigate();
	const { accounts } = useAccountSwitcher();
	const queryClient = useQueryClient();
	const [password, setPassword] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const hasAttemptedBiometric = useRef(false);
	const { autoTrigger, autoTriggerId } = Route.useSearch();

	const allAccounts = accounts.data ?? [];

	// Get session state for first account (to check biometric availability)
	const { data: sessionState } = useSessionState(
		allAccounts.length > 0 ? allAccounts[0].email : undefined,
	);

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
					email: allAccounts[0].email,
				});
			}

			if (result.failed.length === 0) {
				if (allAccounts.length === 1) {
					toast.success("Vault unlocked");
				} else {
					toast.success(`All ${result.unlocked.length} accounts unlocked`);
				}
			} else {
				toast.warning(
					`Unlocked ${result.unlocked.length} of ${allAccounts.length} accounts`,
				);
			}

			triggerAuthRevealToVault();
		},
		onPartialSuccess: async (result) => {
			await queryClient.invalidateQueries({ queryKey: ["accounts"] });

			if (allAccounts.length > 1) {
				await storage.setActiveAccount({ type: "all" });
			}
			toast.warning(
				`Unlocked ${result.unlocked.length} of ${allAccounts.length} accounts`,
			);
			triggerAuthRevealToVault();
		},
		onError: (error) => {
			console.error("Unlock all error:", error);
			toast.error(error.message || "Failed to unlock accounts");
		},
	});

	// Biometric unlock all accounts with ONE prompt
	const handleBiometricUnlockAll = async () => {
		try {
			// Use the unified biometric unlock method that shows ONE prompt for all accounts
			if (!storage.unlockAllAccountsWithBiometric) {
				throw new Error("Biometric unlock not supported on this platform");
			}

			const { unlocked, failed } =
				await storage.unlockAllAccountsWithBiometric();

			if (unlocked.length === 0) {
				throw new Error("Failed to unlock any accounts with biometric");
			}

			// Set active mode
			if (allAccounts.length > 1) {
				await storage.setActiveAccount({ type: "all" });
			} else {
				await storage.setActiveAccount({
					type: "single",
					email: allAccounts[0].email,
				});
			}

			await queryClient.invalidateQueries({ queryKey: ["accounts"] });

			if (failed.length === 0) {
				if (allAccounts.length === 1) {
					toast.success("Unlocked with biometric");
				} else {
					toast.success(`All ${unlocked.length} accounts unlocked`);
				}
			} else {
				toast.warning(
					`Unlocked ${unlocked.length} of ${allAccounts.length} accounts`,
				);
			}

			triggerAuthRevealToVault();
		} catch (error) {
			console.error("Biometric unlock error:", error);
			toast.error(
				error instanceof Error ? error.message : "Biometric unlock failed",
			);
		}
	};

	const handlePasswordUnlock = async (e: React.FormEvent) => {
		e.preventDefault();

		// Unlock all accounts with the same password
		quickUnlockAll.mutate({ password });
	};

	const loading = quickUnlockAll.isPending;
	const requiresPasswordReentry =
		sessionState?.requiresPasswordReentry ?? false;
	const canUseBiometric =
		sessionState?.canBiometricUnlock && !requiresPasswordReentry;

	// Reset attempt flag on each extension trigger event.
	useEffect(() => {
		if (autoTrigger) {
			hasAttemptedBiometric.current = false;
		}
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
						throw new Error("Biometric unlock not supported on this platform");
					}

					const { unlocked, failed } =
						await storage.unlockAllAccountsWithBiometric();

					if (unlocked.length === 0) {
						throw new Error("Failed to unlock any accounts with biometric");
					}

					// Set active mode
					if (allAccounts.length > 1) {
						await storage.setActiveAccount({ type: "all" });
					} else {
						await storage.setActiveAccount({
							type: "single",
							email: allAccounts[0].email,
						});
					}

					await queryClient.invalidateQueries({ queryKey: ["accounts"] });

					if (failed.length === 0) {
						if (allAccounts.length === 1) {
							toast.success("Unlocked with biometric");
						} else {
							toast.success(`All ${unlocked.length} accounts unlocked`);
						}
					} else {
						toast.warning(
							`Unlocked ${unlocked.length} of ${allAccounts.length} accounts`,
						);
					}

					triggerAuthRevealToVault();
				} catch (error) {
					console.error("Biometric unlock error:", error);
					// Don't show toast on auto-trigger failure - user can manually try
				}
			}, 100);

			return () => clearTimeout(timeout);
		}
	}, [autoTrigger, allAccounts, queryClient]);

	// Show loading state while accounts are being fetched
	if (accounts.isLoading) {
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
							<p className="font-medium text-amber-800">Password Required</p>
							<p className="text-amber-700 text-sm">
								For your security, please enter your master password. This is
								required every 30 days.
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
							placeholder="Enter your password"
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
									aria-label={showPassword ? "Hide password" : "Show password"}
								>
									{showPassword ? (
										<IconEyeSlashOutlineDuo18 className="h-4 w-4" strokeWidth={1} />
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
										aria-label="Unlock with biometric"
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
						? "Bittery was locked due to inactivity."
						: `Bittery was locked with ${allAccounts.length} accounts.`}
				</p>
			</div>
		</AuthDoorsLayout>
	);
}
