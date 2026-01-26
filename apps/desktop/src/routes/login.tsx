import { useLogin } from "@bittery/hooks";
import { normalizeServerUrl } from "@bittery/shared/server-url";
import { Button, Input, Label, toast, VaultIcon } from "@bittery/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Fingerprint } from "lucide-react";
import { useEffect, useState } from "react";
import { type AccountMetadata, storage } from "@/lib/storage";
import { useAccount } from "../contexts/account-context";

interface LoginSearchParams {
	addingAccount?: boolean;
}

export const Route = createFileRoute("/login")({
	component: LoginPage,
	validateSearch: (search: Record<string, unknown>): LoginSearchParams => {
		return {
			addingAccount:
				search.addingAccount === true || search.addingAccount === "true",
		};
	},
});

export function LoginPage() {
	const navigate = useNavigate();
	const { addingAccount } = Route.useSearch();
	const { refreshAccounts } = useAccount();
	const fallbackServerUrl =
		normalizeServerUrl(import.meta.env.VITE_SERVER_URL ?? "") ??
		"http://localhost:3000";
	const [serverUrl, setServerUrl] = useState(fallbackServerUrl);
	const [webAppUrl, setWebAppUrl] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [secretKey, setSecretKey] = useState("");
	const [enableBiometric, setEnableBiometric] = useState(true);

	const { data: biometricAvailable } = useQuery({
		queryKey: ["biometry-available"],
		queryFn: async () => {
			return await storage.isBiometricAvailable();
		},
	});

	useEffect(() => {
		let active = true;
		// Try to get server URL from legacy storage (fallback for login page)
		storage.getLegacyServerUrl().then((stored) => {
			if (!active || !stored) return;
			setServerUrl(stored);
		});
		return () => {
			active = false;
		};
	}, []);

	const handleBackToVault = () => {
		navigate({ to: "/vault" });
	};

	// Use the shared login hook
	const loginMutation = useLogin({
		enableBiometric: enableBiometric && !!biometricAvailable,
		onSuccess: async (result, input) => {
			const normalizedEmail = input.email.toLowerCase();
			const normalizedServerUrl = normalizeServerUrl(serverUrl);

			// Store server URL per-account (desktop-specific)
			if (normalizedServerUrl) {
				await storage.storeServerUrl(normalizedServerUrl, normalizedEmail);
			}

			// Store web app URL if provided, otherwise clear it to use derived URL (desktop-specific)
			if (webAppUrl.trim()) {
				const normalizedWebAppUrl = normalizeServerUrl(webAppUrl);
				if (normalizedWebAppUrl) {
					await storage.storeWebAppUrl(normalizedWebAppUrl, normalizedEmail);
				}
			} else {
				await storage.clearWebAppUrl(normalizedEmail);
			}

			// Create account metadata (desktop-specific multi-account support)
			const secretKeyHint = `${input.secretKey.substring(0, 5)}...`;
			const accountMetadata: AccountMetadata = {
				email: normalizedEmail,
				userId: result.user.id,
				name: result.user.name || normalizedEmail.split("@")[0],
				teamName: result.user.teamName,
				secretKeyHint,
				addedAt: Date.now(),
				lastActiveAt: Date.now(),
				biometricEnabled: enableBiometric && !!biometricAvailable,
			};

			// Add to accounts list
			await storage.addAccountToList(accountMetadata);

			// Refresh account context
			await refreshAccounts();

			toast.success(
				addingAccount ? "Account added successfully" : "Login successful",
			);
			navigate({ to: "/vault" });
		},
		onError: (error) => {
			console.error("Login error:", error);
			toast.error(error instanceof Error ? error.message : "Login failed");
		},
	});

	const handleLogin = async (e: React.FormEvent) => {
		e.preventDefault();

		const normalizedServerUrl = normalizeServerUrl(serverUrl);
		if (!normalizedServerUrl) {
			toast.error("Invalid server URL");
			return;
		}
		if (normalizedServerUrl !== serverUrl) {
			setServerUrl(normalizedServerUrl);
		}

		await loginMutation.mutateAsync({
			email,
			password,
			secretKey,
			enableBiometric: enableBiometric && !!biometricAvailable,
		});
	};

	return (
		<div className="flex h-full w-full items-center justify-center overflow-y-auto bg-background">
			<div className="grid h-full w-full lg:grid-cols-2">
				{/* Left side - Branding */}
				<div className="hidden flex-col items-center justify-center bg-sidebar p-12 lg:flex">
					<div className="flex max-w-md flex-col items-center space-y-8 text-center">
						<VaultIcon state="locked" size={120} />
						<div className="space-y-4">
							<h1 className="font-bold text-4xl text-sidebar-foreground tracking-tight">
								Secure by design.
								<br />
								<span className="text-primary">Private by default.</span>
							</h1>
							<p className="text-lg text-sidebar-foreground/70">
								Your passwords are encrypted client-side and never leave your
								device unencrypted.
							</p>
						</div>
						<div className="grid gap-3 pt-4">
							{[
								"Zero-knowledge architecture",
								"Client-side AES-256 encryption",
								"Secure Remote Password protocol",
								"Cross-platform sync",
							].map((item) => (
								<div
									key={item}
									className="flex items-center gap-3 font-medium text-sidebar-foreground/80 text-sm"
								>
									<div className="h-1.5 w-1.5 rounded-full bg-primary" />
									{item}
								</div>
							))}
						</div>
					</div>
				</div>

				{/* Right side - Form */}
				<div className="flex flex-col items-center justify-center p-6 lg:p-12">
					<div className="w-full max-w-md space-y-6">
						{addingAccount && (
							<button
								type="button"
								onClick={handleBackToVault}
								className="flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground"
							>
								<ArrowLeft className="h-3.5 w-3.5" />
								Back to Vault
							</button>
						)}

						<div>
							<h2 className="font-semibold text-xl">
								{addingAccount ? "Add Account" : "Sign in to your vault"}
							</h2>
							<p className="mt-1 text-muted-foreground text-sm">
								{addingAccount
									? "Sign in to add another account"
									: "Enter your credentials to access your passwords"}
							</p>
						</div>

						<form onSubmit={handleLogin} className="space-y-5">
							<div className="grid gap-1">
								<Label htmlFor="serverUrl">Server URL</Label>
								<Input
									id="serverUrl"
									type="url"
									value={serverUrl}
									onChange={(e) => setServerUrl(e.target.value)}
									onBlur={() => {
										const normalized = normalizeServerUrl(serverUrl);
										if (!normalized) {
											toast.error("Invalid server URL");
											return;
										}
										if (normalized !== serverUrl) {
											setServerUrl(normalized);
										}
									}}
									required
									placeholder="https://your-server.com"
								/>
								<p className="mt-1 text-muted-foreground text-xs">
									Use your self-hosted Bittery server URL.
								</p>
							</div>

							<div className="grid gap-1">
								<Label htmlFor="webAppUrl">Web App URL (Optional)</Label>
								<Input
									id="webAppUrl"
									type="url"
									value={webAppUrl}
									onChange={(e) => setWebAppUrl(e.target.value)}
									placeholder={
										normalizeServerUrl(serverUrl)
											?.replace(/\/api.*$/, "")
											.replace(/\/$/, "") || "https://app.bittery.io"
									}
								/>
								<p className="mt-1 text-muted-foreground text-xs">
									URL for shareable links. Leave empty to derive from server
									URL.
								</p>
							</div>

							<div className="grid gap-1">
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

							<div className="grid gap-1">
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

							<div className="grid gap-1">
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
								<p className="mt-1 text-muted-foreground text-xs">
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
										className="h-4 w-4 rounded border-border"
									/>
									<Label
										htmlFor="biometric"
										className="flex items-center gap-2"
									>
										<Fingerprint className="h-4 w-4" />
										Enable biometric unlock
									</Label>
								</div>
							)}

							<Button
								type="submit"
								className="w-full"
								disabled={loginMutation.isPending}
							>
								{loginMutation.isPending ? "Logging in..." : "Log In"}
							</Button>
						</form>
					</div>
				</div>
			</div>
		</div>
	);
}
