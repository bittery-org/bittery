import {
	useAccountSwitcher,
	useQuickUnlockAll,
	useSessionState,
} from "@bittery/hooks";
import {
	Button,
	Card,
	Input,
	Label,
	toast,
	VaultIcon,
	type VaultIconState,
} from "@bittery/ui";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Fingerprint, KeyRound } from "lucide-react";
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
	const hasAttemptedBiometric = useRef(false);
	const { autoTrigger } = Route.useSearch();

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

	// Auto-trigger biometric unlock on mount if available
	// OR if triggered by extension (autoTrigger=true)
	useEffect(() => {
		if (
			(canUseBiometric || autoTrigger) &&
			!hasAttemptedBiometric.current &&
			allAccounts.length > 0
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
	}, [canUseBiometric, autoTrigger, allAccounts, queryClient, navigate]);

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
			<Card className="w-full max-w-md gap-0 p-8">
				<div className="mb-8 text-center">
					<VaultIcon state={vaultState} className="mx-auto" size={140} />
					<h1 className="mt-6 font-bold text-2xl">Unlock Bittery</h1>

					{/* Show account info */}
					<div className="mt-4">
						{allAccounts.length === 1 ? (
							<p className="text-gray-600 text-sm">{allAccounts[0].email}</p>
						) : (
							<p className="text-gray-600 text-sm">
								{allAccounts.length} accounts
							</p>
						)}
					</div>
				</div>

				{/* Master Password Required Notice */}
				{requiresPasswordReentry && (
					<div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
						<KeyRound className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
						<div>
							<p className="font-medium text-amber-800">Password Required</p>
							<p className="text-amber-700 text-sm">
								For your security, please enter your master password. This is
								required every 30 days.
							</p>
						</div>
					</div>
				)}

				{/* Biometric unlock button */}
				{canUseBiometric && (
					<div className="mb-4">
						<Button
							type="button"
							onClick={handleBiometricUnlockAll}
							className="w-full"
							variant="outline"
							disabled={loading}
						>
							<Fingerprint className="mr-2 h-4 w-4" />
							{loading
								? "Authenticating..."
								: allAccounts.length === 1
									? "Unlock with Biometric"
									: "Unlock All with Biometric"}
						</Button>
						<div className="mt-4 text-center text-gray-500 text-sm">or</div>
					</div>
				)}

				<form onSubmit={handlePasswordUnlock} className="space-y-4">
					<div className="grid gap-2">
						<Label htmlFor="password">Password</Label>
						<Input
							id="password"
							type="password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							required
							placeholder="Enter your password"
							autoFocus
						/>
					</div>

					<Button type="submit" className="w-full" disabled={loading}>
						{loading
							? "Unlocking..."
							: allAccounts.length === 1
								? "Unlock"
								: `Unlock All (${allAccounts.length})`}
					</Button>
				</form>

				<div className="mt-4 text-center">
					<button
						type="button"
						onClick={() =>
							navigate({ to: "/login", search: { addingAccount: true } })
						}
						className="text-gray-600 text-sm hover:text-gray-900"
					>
						Sign in with different account
					</button>
				</div>
			</Card>
		</div>
	);
}
