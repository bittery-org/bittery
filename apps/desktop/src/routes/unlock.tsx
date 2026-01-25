import {
	deriveKeys,
	deriveClientSession,
	generateClientEphemeral,
	verifyServerSession,
} from "../lib/tauri-crypto";
import { storage, type AccountMetadata } from "@/lib/storage";
import { useTRPCClient } from "@bittery/shared/trpc";
import {
	Button,
	Card,
	Input,
	Label,
	toast,
	VaultIcon,
	type VaultIconState,
} from "@bittery/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ChevronDown, Fingerprint } from "lucide-react";
import { useState } from "react";
import { AccountAvatar } from "../components/account-avatar";
import { useAccount } from "../contexts/account-context";

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
	const trpcClient = useTRPCClient();
	const navigate = useNavigate();
	const { email: emailParam } = Route.useSearch();
	const { allAccounts, activeAccount, refreshAccounts } = useAccount();
	const [password, setPassword] = useState("");
	const [loading, setLoading] = useState(false);
	const [showAccountPicker, setShowAccountPicker] = useState(false);
	const [vaultState, setVaultState] = useState<VaultIconState>("locked");

	// Determine which account to unlock
	const targetEmail = emailParam || activeAccount?.email;
	const targetAccount = allAccounts.find(
		(a) => a.email.toLowerCase() === targetEmail?.toLowerCase(),
	);

	const { data: sessionState } = useQuery({
		queryKey: ["biometry-status", targetEmail],
		queryFn: async () => {
			if (!targetEmail) return null;

			const available = await storage.isBiometricAvailable();
			const storedData = await storage.getStoredSessionData(targetEmail);

			return {
				available,
				enabled: storedData?.biometricEnabled ?? false,
				data: storedData,
			};
		},
		enabled: !!targetEmail,
	});

	const handleBiometricUnlock = async () => {
		if (!targetEmail) return;

		setLoading(true);
		setVaultState("unlocking");
		try {
			const success = await storage.unlockWithBiometric(targetEmail);
			if (success) {
				// Restore auth token and vault keys
				const token = await storage.getAuthToken(targetEmail);
				const vaultKeys = await storage.getVaultKeys(targetEmail);

				if (token && vaultKeys) {
					// Set as active account
					await storage.setActiveAccount(targetEmail);
					await refreshAccounts();
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
			} else {
				setVaultState("locked");
				toast.error("Biometric authentication failed");
			}
		} catch (error) {
			console.error("Biometric unlock error:", error);
			setVaultState("locked");
			toast.error("Biometric unlock failed");
		} finally {
			setLoading(false);
		}
	};

	const handlePasswordUnlock = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!targetEmail) return;

		setLoading(true);
		setVaultState("unlocking");

		try {
			const secretKey = await storage.getStoredSecretKey(targetEmail);
			if (!secretKey) {
				toast.error("Secret key not found. Please log in again.");
				await storage.clearAllStoredData(targetEmail);
				navigate({ to: "/login" });
				return;
			}

			if (!sessionState?.data) {
				toast.error("Session data not found. Please log in again.");
				await storage.clearAllStoredData(targetEmail);
				navigate({ to: "/login" });
				return;
			}

			// 1. Derive keys from password + secret key
			const { authKey, masterUnlockKey } = await deriveKeys(
				password,
				secretKey,
				targetEmail,
			);

			// Convert authKey to password string for SRP
			const srpPassword = new TextDecoder().decode(authKey);

			// 2. Generate client ephemeral key pair
			const clientEphemeral = await generateClientEphemeral();

			// 3. Send client public key to server and get challenge
			const startResult = await trpcClient.auth.startLogin.mutate({
				email: targetEmail,
				clientPublicKey: clientEphemeral.publicKey,
			});

			// 4. Derive session and compute proof
			const clientSession = await deriveClientSession(
				clientEphemeral.secret,
				{
					salt: startResult.salt,
					serverPublicKey: startResult.serverPublicKey,
				},
				srpPassword,
			);

			// 5. Send proof to server and get session
			const finishResult = await trpcClient.auth.finishLogin.mutate({
				userId: startResult.userId,
				serverSecret: startResult.serverSecret,
				clientPublicKey: clientEphemeral.publicKey,
				clientProof: clientSession.proof,
			});

			if (!finishResult.serverProof) {
				toast.error("Unlock failed");
				setLoading(false);
				return;
			}

			// 6. Verify server's proof (completes mutual authentication)
			await verifyServerSession(
				clientEphemeral.publicKey,
				clientSession,
				finishResult.serverProof,
			);

			// Update session with fresh data
			await storage.storeAuthToken(finishResult.token, targetEmail);
			await storage.storeVaultKeys(finishResult.vaultKeys, targetEmail);
			// Store encrypted private key for RSA decryption of shared vault keys
			if (finishResult.user.encryptedPrivateKey) {
				await storage.storeEncryptedPrivateKey(
					finishResult.user.encryptedPrivateKey,
					targetEmail,
				);
			}
			await storage.storeSessionData(
				masterUnlockKey,
				targetEmail,
				finishResult.user.id,
			);
			await storage.storeMasterUnlockKey(masterUnlockKey, targetEmail);

			// Update account metadata with latest team name from server
			if (targetAccount) {
				const updatedMetadata: AccountMetadata = {
					...targetAccount,
					teamName: finishResult.user.teamName,
					lastActiveAt: Date.now(),
				};
				await storage.addAccountToList(updatedMetadata);
			}

			// Set as active account
			await storage.setActiveAccount(targetEmail);
			await refreshAccounts();

			setVaultState("unlocked");
			toast.success("Vault unlocked");
			// Delay navigation to show unlock animation
			setTimeout(() => {
				navigate({ to: "/vault" });
			}, 600);
		} catch (error) {
			console.error("Unlock error:", error);
			setVaultState("locked");
			toast.error(error instanceof Error ? error.message : "Unlock failed");
		} finally {
			setLoading(false);
		}
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
										<div className="-translate-x-1/2 absolute left-1/2 z-10 mt-2 w-64 rounded-lg border bg-white py-1 shadow-lg">
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

				{sessionState?.available && sessionState?.enabled && (
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
