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
	VaultIcon,
	type VaultIconState,
} from "@bittery/ui";
import {
	IconEyeOutlineDuo18,
	IconEyeSlashOutlineDuo18,
	IconFingerprintOutlineDuo18,
	IconKeyOutlineDuo18,
} from "@bittery/ui/icons";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { storage } from "@/lib/storage";

interface UnlockSearchParams {
	email?: string;
	autoTrigger?: boolean;
}

export const Route = createFileRoute("/unlock")({
	component: UnlockPage,
	validateSearch: (search: Record<string, unknown>): UnlockSearchParams => {
		return {
			email: typeof search.email === "string" ? search.email : undefined,
			autoTrigger: search.autoTrigger === true || search.autoTrigger === "true",
		};
	},
});

export function UnlockPage() {
	const navigate = useNavigate();
	const { accounts } = useAccountSwitcher();
	const queryClient = useQueryClient();
	const [password, setPassword] = useState("");
	const [vaultState, setVaultState] = useState<VaultIconState>("locked");
	const [showPassword, setShowPassword] = useState(false);
	const hasAttemptedBiometric = useRef(false);
	const { autoTrigger } = Route.useSearch();

	// Track window focus so biometric only auto-triggers when the app is in the foreground
	const [isWindowFocused, setIsWindowFocused] = useState(
		() => document.hasFocus(),
	);

	useEffect(() => {
		const handleFocus = () => setIsWindowFocused(true);
		const handleBlur = () => setIsWindowFocused(false);

		window.addEventListener("focus", handleFocus);
		window.addEventListener("blur", handleBlur);

		return () => {
			window.removeEventListener("focus", handleFocus);
			window.removeEventListener("blur", handleBlur);
		};
	}, []);

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

			setVaultState("unlocked");

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

			setTimeout(() => {
				navigate({ to: "/vault" });
			}, 600);
		},
		onPartialSuccess: async (result) => {
			await queryClient.invalidateQueries({ queryKey: ["accounts"] });

			if (allAccounts.length > 1) {
				await storage.setActiveAccount({ type: "all" });
			}

			setVaultState("unlocked");
			toast.warning(
				`Unlocked ${result.unlocked.length} of ${allAccounts.length} accounts`,
			);

			setTimeout(() => {
				navigate({ to: "/vault" });
			}, 600);
		},
		onError: (error) => {
			console.error("Unlock all error:", error);
			setVaultState("locked");
			toast.error(error.message || "Failed to unlock accounts");
		},
	});

	// Biometric unlock all accounts with ONE prompt
	const handleBiometricUnlockAll = async () => {
		setVaultState("unlocking");

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
			setVaultState("unlocked");

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

			setTimeout(() => {
				navigate({ to: "/vault" });
			}, 600);
		} catch (error) {
			console.error("Biometric unlock error:", error);
			setVaultState("locked");
			toast.error(
				error instanceof Error ? error.message : "Biometric unlock failed",
			);
		}
	};

	const handlePasswordUnlock = async (e: React.FormEvent) => {
		e.preventDefault();
		setVaultState("unlocking");

		// Unlock all accounts with the same password
		quickUnlockAll.mutate({ password });
	};

	const loading = quickUnlockAll.isPending;
	const requiresPasswordReentry =
		sessionState?.requiresPasswordReentry ?? false;
	const canUseBiometric =
		sessionState?.canBiometricUnlock && !requiresPasswordReentry;

	// Reset attempt flag when autoTrigger changes to true (extension triggered unlock)
	useEffect(() => {
		if (autoTrigger) {
			hasAttemptedBiometric.current = false;
		}
	}, [autoTrigger]);

	// Auto-trigger biometric unlock when available AND window is focused
	// OR if triggered by extension (autoTrigger=true)
	useEffect(() => {
		if (
			(canUseBiometric || autoTrigger) &&
			!hasAttemptedBiometric.current &&
			allAccounts.length > 0 &&
			isWindowFocused
		) {
			hasAttemptedBiometric.current = true;
			// Small delay to ensure everything is initialized
			const timeout = setTimeout(async () => {
				setVaultState("unlocking");

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
					setVaultState("unlocked");

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

					setTimeout(() => {
						navigate({ to: "/vault" });
					}, 600);
				} catch (error) {
					console.error("Biometric unlock error:", error);
					setVaultState("locked");
					// Don't show toast on auto-trigger failure - user can manually try
				}
			}, 100);

			return () => clearTimeout(timeout);
		}
	}, [canUseBiometric, autoTrigger, allAccounts, queryClient, navigate, isWindowFocused]);

	// Show loading state while accounts are being fetched
	if (accounts.isLoading) {
		return (
			<div className="flex h-full items-center justify-center">
				<div className="text-gray-600">Loading...</div>
			</div>
		);
	}

	// If no accounts, redirect to login
	if (allAccounts.length === 0) {
		navigate({ to: "/login" });
		return null;
	}

	return (
		<div className="flex h-full items-center justify-center bg-gray-50 p-4">
			<div className="w-full max-w-2xl">
				<div className="flex items-start gap-12">
					{/* Left side - Vault Icon */}
					<div className="shrink-0">
						<VaultIcon state={vaultState} size={180} />
					</div>

					{/* Right side - Unlock Form */}
					<div className="flex-1 pt-6">
						{/* Account Avatars */}
						<div className="mb-5">
							<AvatarGroup accounts={allAccounts} maxVisible={3} size="lg" />
						</div>

						{/* Master Password Required Notice */}
						{requiresPasswordReentry && (
							<div className="mb-6 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
								<IconKeyOutlineDuo18 className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
								<div>
									<p className="font-medium text-amber-800">
										Password Required
									</p>
									<p className="text-amber-700 text-sm">
										For your security, please enter your master password. This
										is required every 30 days.
									</p>
								</div>
							</div>
						)}

						{/* Password Input with Eye and Fingerprint */}
						<form onSubmit={handlePasswordUnlock} className="w-80">
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
											aria-label={
												showPassword ? "Hide password" : "Show password"
											}
										>
											{showPassword ? (
												<IconEyeSlashOutlineDuo18
													className="h-4 w-4"
													strokeWidth={1}
												/>
											) : (
												<IconEyeOutlineDuo18
													className="h-4 w-4"
													strokeWidth={1}
												/>
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

						{/* Lock message */}
						<p className="mt-4 w-80 text-muted-foreground text-sm">
							{allAccounts.length === 1
								? "Bittery was locked due to inactivity."
								: `Bittery was locked with ${allAccounts.length} accounts.`}
						</p>
					</div>
				</div>
			</div>
		</div>
	);
}
