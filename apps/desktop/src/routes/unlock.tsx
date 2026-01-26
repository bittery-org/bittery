import {
	useAccountSwitcher,
	useBiometricUnlock,
	useQuickUnlock,
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
import { ChevronDown, Fingerprint, KeyRound } from "lucide-react";
import { useState } from "react";
import { type AccountMetadata, storage } from "@/lib/storage";
import { AccountAvatar } from "../components/account-avatar";

interface UnlockSearchParams {
	email?: string;
}

export const Route = createFileRoute("/unlock")({
	component: UnlockPage,
	validateSearch: (search: Record<string, unknown>): UnlockSearchParams => {
		return {
			email: typeof search.email === "string" ? search.email : undefined,
		};
	},
});

export function UnlockPage() {
	const navigate = useNavigate();
	const { email: emailParam } = Route.useSearch();
	const { accounts, activeEmail } = useAccountSwitcher();
	const queryClient = useQueryClient();
	const [password, setPassword] = useState("");
	const [showAccountPicker, setShowAccountPicker] = useState(false);
	const [vaultState, setVaultState] = useState<VaultIconState>("locked");

	const allAccounts = accounts.data ?? [];
	const activeAccount = allAccounts.find(
		(a) => a.email === activeEmail.data,
	);

	// Determine which account to unlock
	const targetEmail = emailParam || activeAccount?.email;
	const targetAccount = allAccounts.find(
		(a) => a.email.toLowerCase() === targetEmail?.toLowerCase(),
	);

	// Get session state for the target account
	const { data: sessionState } = useSessionState(targetEmail);

	// Biometric unlock hook
	const biometricUnlock = useBiometricUnlock({
		onSuccess: async () => {
			if (targetEmail) {
				// Restore auth token and vault keys
				const token = await storage.getAuthToken(targetEmail);
				const vaultKeys = await storage.getVaultKeys(targetEmail);

				if (token && vaultKeys) {
					// Set as active account
					await storage.setActiveAccount(targetEmail);
					await queryClient.invalidateQueries({ queryKey: ["accounts"] });
					setVaultState("unlocked");
					toast.success("Unlocked with biometric");
					// Delay navigation to show unlock animation
					setTimeout(() => {
						navigate({ to: "/vault" });
					}, 600);
				} else {
					setVaultState("locked");
					toast.error("Session data missing, please log in again");
					await storage.clearAllStoredData(targetEmail);
					navigate({ to: "/login" });
				}
			}
		},
		onError: (error) => {
			console.error("Biometric unlock error:", error);
			setVaultState("locked");
			toast.error(error.message || "Biometric unlock failed");
		},
	});

	// Quick unlock (password) hook
	const quickUnlock = useQuickUnlock({
		onSuccess: async (result) => {
			// Update account metadata with latest team name from server
			if (targetAccount) {
				const updatedMetadata: AccountMetadata = {
					...targetAccount,
					teamName: result.user.teamName,
					lastActiveAt: Date.now(),
				};
				await storage.addAccountToList(updatedMetadata);
			}

			// Refresh accounts queries
			await queryClient.invalidateQueries({ queryKey: ["accounts"] });

			setVaultState("unlocked");
			toast.success("Vault unlocked");
			// Delay navigation to show unlock animation
			setTimeout(() => {
				navigate({ to: "/vault" });
			}, 600);
		},
		onError: (error) => {
			console.error("Unlock error:", error);
			setVaultState("locked");
			toast.error(error instanceof Error ? error.message : "Unlock failed");
		},
	});

	const handleBiometricUnlock = async () => {
		if (!targetEmail) return;

		setVaultState("unlocking");
		biometricUnlock.mutate({ email: targetEmail });
	};

	const handlePasswordUnlock = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!targetEmail) return;

		setVaultState("unlocking");

		// Check for stored secret key
		const secretKey = await storage.getStoredSecretKey(targetEmail);
		if (!secretKey) {
			setVaultState("locked");
			toast.error("Secret key not found. Please log in again.");
			await storage.clearAllStoredData(targetEmail);
			navigate({ to: "/login" });
			return;
		}

		// Check for session data
		if (!sessionState?.isValid && !sessionState?.canQuickUnlock) {
			setVaultState("locked");
			toast.error("Session data not found. Please log in again.");
			await storage.clearAllStoredData(targetEmail);
			navigate({ to: "/login" });
			return;
		}

		quickUnlock.mutate({
			email: targetEmail,
			password,
		});
	};

	const handleSwitchAccount = async (email: string) => {
		setShowAccountPicker(false);
		navigate({ to: "/unlock", search: { email } });
	};

	// If no accounts, redirect to login
	if (allAccounts.length === 0) {
		navigate({ to: "/login" });
		return null;
	}

	const loading = biometricUnlock.isPending || quickUnlock.isPending;
	const requiresPasswordReentry =
		sessionState?.requiresPasswordReentry ?? false;
	const canUseBiometric =
		sessionState?.canBiometricUnlock && !requiresPasswordReentry;

	return (
		<div className="flex h-full items-center justify-center bg-gray-50 p-4">
			<Card className="w-full max-w-md p-8">
				<div className="mb-8 text-center">
					<VaultIcon state={vaultState} className="mx-auto" size={140} />
					<h1 className="mt-6 font-bold text-2xl">Unlock Bittery</h1>

					{/* Account selector */}
					{targetAccount && (
						<div className="mt-4">
							{allAccounts.length > 1 ? (
								<div className="relative">
									<button
										type="button"
										onClick={() => setShowAccountPicker(!showAccountPicker)}
										className="mx-auto flex items-center gap-2 rounded-lg border px-3 py-2 hover:bg-gray-50"
									>
										<AccountAvatar account={targetAccount} size="sm" />
										<span className="text-sm">{targetAccount.email}</span>
										<ChevronDown className="h-4 w-4 text-gray-400" />
									</button>

									{showAccountPicker && (
										<div className="absolute left-1/2 z-10 mt-2 w-64 -translate-x-1/2 rounded-lg border bg-white py-1 shadow-lg">
											{allAccounts.map((account) => (
												<button
													key={account.email}
													type="button"
													onClick={() => handleSwitchAccount(account.email)}
													className="flex w-full items-center gap-3 px-4 py-2 hover:bg-gray-50"
												>
													<AccountAvatar account={account} size="sm" />
													<div className="text-left">
														<div className="font-medium text-sm">
															{account.teamName ||
																account.name ||
																account.email.split("@")[0]}
														</div>
														<div className="text-gray-500 text-xs">
															{account.email}
														</div>
													</div>
												</button>
											))}
										</div>
									)}
								</div>
							) : (
								<p className="text-gray-600 text-sm">{targetAccount.email}</p>
							)}
						</div>
					)}
				</div>

				{/* Master Password Required Notice */}
				{requiresPasswordReentry && (
					<div className="mb-4 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
						<KeyRound className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-600" />
						<div>
							<p className="font-medium text-amber-800">Password Required</p>
							<p className="text-amber-700 text-sm">
								For your security, please enter your master password. This is
								required every 30 days.
							</p>
						</div>
					</div>
				)}

				{canUseBiometric && (
					<div className="mb-4">
						<Button
							type="button"
							onClick={handleBiometricUnlock}
							className="w-full"
							variant="outline"
							disabled={loading}
						>
							<Fingerprint className="mr-2 h-4 w-4" />
							{loading ? "Authenticating..." : "Unlock with Biometric"}
						</Button>
						<div className="my-4 text-center text-gray-500 text-sm">or</div>
					</div>
				)}

				<form onSubmit={handlePasswordUnlock} className="space-y-4">
					<div>
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
						{loading ? "Unlocking..." : "Unlock"}
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
