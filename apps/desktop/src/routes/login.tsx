import {
	deriveClientSession,
	deriveKeys,
	generateClientEphemeral,
	validateSecretKey,
	verifyServerSession,
} from "@bittery/crypto";
import * as tauriStorage from "@bittery/crypto/storage-tauri";
import type { AccountMetadata } from "@bittery/crypto/storage-tauri";
import { useTRPCClient } from "@bittery/shared/trpc";
import { Button, Card, Input, Label, toast } from "@bittery/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Fingerprint } from "lucide-react";
import { useState } from "react";
import { useAccount } from "../contexts/account-context";

interface LoginSearchParams {
	addingAccount?: boolean;
}

export const Route = createFileRoute("/login")({
	component: LoginPage,
	validateSearch: (search: Record<string, unknown>): LoginSearchParams => {
		return {
			addingAccount: search.addingAccount === true || search.addingAccount === "true",
		};
	},
});

export function LoginPage() {
	const trpcClient = useTRPCClient();
	const navigate = useNavigate();
	const { addingAccount } = Route.useSearch();
	const { refreshAccounts } = useAccount();
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [secretKey, setSecretKey] = useState("");
	const [loading, setLoading] = useState(false);
	const [enableBiometric, setEnableBiometric] = useState(false);

	const { data: biometricAvailable } = useQuery({
		queryKey: ["biometry-available"],
		queryFn: async () => {
			return await tauriStorage.isBiometricAvailable();
		},
	});

	const handleBackToVault = () => {
		navigate({ to: "/vault" });
	};

	const handleLogin = async (e: React.FormEvent) => {
		e.preventDefault();

		if (!validateSecretKey(secretKey)) {
			toast.error("Invalid Secret Key format");
			return;
		}

		setLoading(true);

		try {
			// 1. Derive keys from password + secret key
			const { authKey, masterUnlockKey } = await deriveKeys(
				password,
				secretKey,
				email,
			);

			// Convert authKey to password string for SRP
			const srpPassword = new TextDecoder().decode(authKey);

			// 2. Generate client ephemeral key pair
			const clientEphemeral = generateClientEphemeral();

			// 3. Send client public key to server and get challenge
			const startResult = await trpcClient.auth.startLogin.mutate({
				email,
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
				toast.error("Login failed");
				return;
			}

			// 6. Verify server's proof (completes mutual authentication)
			await verifyServerSession(
				clientEphemeral.publicKey,
				clientSession,
				finishResult.serverProof,
			);

			const normalizedEmail = email.toLowerCase();

			// Enable biometric if requested
			if (enableBiometric && biometricAvailable) {
				await tauriStorage.enableBiometric(normalizedEmail);
			}

			// Store auth data (email is used to namespace storage)
			await tauriStorage.storeAuthToken(finishResult.token, normalizedEmail);
			await tauriStorage.storeVaultKeys(finishResult.vaultKeys, normalizedEmail);
			await tauriStorage.storeSecretKey(secretKey, normalizedEmail);
			await tauriStorage.storeSessionData(
				masterUnlockKey,
				normalizedEmail,
				finishResult.user.id,
			);
			await tauriStorage.storeMasterUnlockKey(masterUnlockKey, normalizedEmail);

			// Create account metadata
			const secretKeyHint = `${secretKey.substring(0, 5)}...`;
			const accountMetadata: AccountMetadata = {
				email: normalizedEmail,
				userId: finishResult.user.id,
				name: finishResult.user.name || normalizedEmail.split("@")[0],
				secretKeyHint,
				addedAt: Date.now(),
				lastActiveAt: Date.now(),
				biometricEnabled: enableBiometric && !!biometricAvailable,
			};

			// Add to accounts list
			await tauriStorage.addAccountToList(accountMetadata);

			// Set as active account
			await tauriStorage.setActiveAccount(normalizedEmail);

			// Refresh account context
			await refreshAccounts();

			toast.success(addingAccount ? "Account added successfully" : "Login successful");
			navigate({ to: "/vault" });
		} catch (error) {
			console.error("Login error:", error);
			toast.error(error instanceof Error ? error.message : "Login failed");
		} finally {
			setLoading(false);
		}
	};

	return (
		<div className="flex h-full items-center justify-center bg-gray-50 p-4">
			<Card className="w-full max-w-md p-6">
				{addingAccount && (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={handleBackToVault}
						className="mb-4 -ml-2 gap-1"
					>
						<ArrowLeft className="h-4 w-4" />
						Back to Vault
					</Button>
				)}

				<div className="mb-6 text-center">
					<h1 className="font-bold text-2xl">
						{addingAccount ? "Add Account" : "Bittery"}
					</h1>
					<p className="text-gray-600 text-sm">
						{addingAccount
							? "Sign in to add another account"
							: "Password Manager"}
					</p>
				</div>

				<form onSubmit={handleLogin} className="space-y-4">
					<div>
						<Label htmlFor="email">Email</Label>
						<Input
							id="email"
							type="email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							required
							placeholder="you@example.com"
						/>
					</div>

					<div>
						<Label htmlFor="password">Password</Label>
						<Input
							id="password"
							type="password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							required
							placeholder="••••••••"
						/>
					</div>

					<div>
						<Label htmlFor="secretKey">Secret Key</Label>
						<Input
							id="secretKey"
							type="text"
							value={secretKey}
							onChange={(e) => setSecretKey(e.target.value)}
							required
							placeholder="A3-XXXXXX-XXXXXX-XXXXX"
							className="font-mono"
						/>
						<p className="mt-1 text-gray-500 text-xs">
							Your Secret Key was provided when you created your account
						</p>
					</div>

					{biometricAvailable && (
						<div className="flex items-center space-x-2">
							<input
								type="checkbox"
								id="biometric"
								checked={enableBiometric}
								onChange={(e) => setEnableBiometric(e.target.checked)}
								className="h-4 w-4 rounded border-gray-300"
							/>
							<Label htmlFor="biometric" className="flex items-center gap-2">
								<Fingerprint className="h-4 w-4" />
								Enable biometric unlock
							</Label>
						</div>
					)}

					<Button type="submit" className="w-full" disabled={loading}>
						{loading ? "Logging in..." : "Log In"}
					</Button>
				</form>
			</Card>
		</div>
	);
}
