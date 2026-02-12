import { useLogin } from "@bittery/core/hooks";
import { normalizeServerUrl } from "@bittery/shared/server-url";
import {
	Button,
	Checkbox,
	Input,
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
	Label,
	toast,
} from "@bittery/ui";
import {
	IconConnectedDots3OutlineDuo18,
	IconEyeOutlineDuo18,
	IconEyeSlashOutlineDuo18,
	IconFingerprintOutlineDuo18,
	IconKeyOutlineDuo18,
	IconLockOutlineDuo18,
	IconMagicShieldOutlineDuo18,
} from "@bittery/ui/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { type AccountMetadata, storage } from "@/lib/storage";

interface LoginSearchParams {
	prefillEmail?: string;
}

export const Route = createFileRoute("/login")({
	component: LoginPage,
	validateSearch: (search: Record<string, unknown>): LoginSearchParams => ({
		prefillEmail:
			typeof search.prefillEmail === "string" ? search.prefillEmail : undefined,
	}),
});

const features = [
	{
		icon: IconMagicShieldOutlineDuo18,
		label: "Zero-knowledge architecture",
	},
	{
		icon: IconLockOutlineDuo18,
		label: "Client-side AES-256 encryption",
	},
	{
		icon: IconKeyOutlineDuo18,
		label: "Secure Remote Password protocol",
	},
	{
		icon: IconConnectedDots3OutlineDuo18,
		label: "Cross-platform sync",
	},
];

export function LoginPage() {
	const navigate = useNavigate();
	const { prefillEmail } = Route.useSearch();
	const queryClient = useQueryClient();
	const fallbackServerUrl =
		normalizeServerUrl(import.meta.env.VITE_SERVER_URL ?? "") ??
		"http://localhost:3000";

	const [serverUrl, setServerUrl] = useState(fallbackServerUrl);
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [secretKey, setSecretKey] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [showSecretKey, setShowSecretKey] = useState(false);
	const [enableBiometric, setEnableBiometric] = useState(true);
	const [isPrefilled, setIsPrefilled] = useState(false);

	const { data: biometricAvailable } = useQuery({
		queryKey: ["biometry-available"],
		queryFn: async () => {
			return await storage.isBiometricAvailable();
		},
	});

	// Prefill from account data when redirected from unauthorized error
	useEffect(() => {
		let active = true;

		const prefill = async () => {
			if (prefillEmail) {
				const [storedSecretKey, storedServerUrl] = await Promise.all([
					storage.getStoredSecretKey(prefillEmail),
					storage.getServerUrl(prefillEmail),
				]);
				if (!active) return;

				setEmail(prefillEmail);
				if (storedSecretKey) setSecretKey(storedSecretKey);
				if (storedServerUrl) setServerUrl(storedServerUrl);
				setIsPrefilled(true);
			} else {
				// Fallback: try legacy server URL
				const stored = await storage.getLegacyServerUrl();
				if (active && stored) setServerUrl(stored);
			}
		};

		prefill();
		return () => {
			active = false;
		};
	}, [prefillEmail]);

	const loginMutation = useLogin({
		enableBiometric: enableBiometric && !!biometricAvailable,
		onSuccess: async (result, input) => {
			const normalizedEmail = input.email.toLowerCase();
			const normalizedServerUrl = normalizeServerUrl(serverUrl);

			if (normalizedServerUrl) {
				await storage.storeServerUrl(normalizedServerUrl, normalizedEmail);
			}

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

			await storage.addAccountToList(accountMetadata);

			// Clear stale item cache for this account (e.g. from a previous session)
			if (storage.clearItemCache) {
				await storage.clearItemCache(normalizedEmail);
			}

			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["accounts"] }),
				queryClient.invalidateQueries({ queryKey: ["items"] }),
				queryClient.invalidateQueries({ queryKey: ["vault-items"] }),
				queryClient.invalidateQueries({ queryKey: ["decrypted-item"] }),
			]);

			toast.success("Login successful");
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
			<div className="grid h-full w-full md:grid-cols-2">
				{/* Left side - Branding */}
				<div className="relative hidden flex-col items-center justify-center overflow-hidden bg-sidebar p-12 md:flex">
					{/* Subtle gradient accent */}
					<div className="pointer-events-none absolute inset-0 bg-linear-to-br from-primary/4 via-transparent to-primary/2" />

					<div className="relative flex max-w-sm flex-col items-center space-y-10 text-center">
						<img
							src="/logo.png"
							alt="Bittery"
							className="h-14 object-contain"
						/>

						<div className="space-y-3">
							<h1 className="font-bold text-3xl text-sidebar-foreground tracking-tight">
								Secure by design.
								<br />
								<span className="text-primary">Private by default.</span>
							</h1>
							<p className="text-sidebar-foreground/60 text-sm leading-relaxed">
								Your passwords are encrypted client-side and never leave your
								device unencrypted.
							</p>
						</div>

						<div className="w-full space-y-3 pt-2">
							{features.map(({ icon: Icon, label }) => (
								<div
									key={label}
									className="flex items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-sidebar-accent/50"
								>
									<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10">
										<Icon className="h-4 w-4 text-primary" />
									</div>
									<span className="font-medium text-sidebar-foreground/80 text-sm">
										{label}
									</span>
								</div>
							))}
						</div>
					</div>
				</div>

				{/* Right side - Form */}
				<div className="flex flex-col items-center justify-center p-6 md:p-12">
					<div className="w-full max-w-sm space-y-6">
						{/* Logo for mobile */}
						<div className="flex justify-center md:hidden">
							<img
								src="/logo.png"
								alt="Bittery"
								className="h-10 object-contain"
							/>
						</div>

						{isPrefilled && (
							<div className="rounded-lg border border-amber-200/60 bg-amber-50/50 px-4 py-3 dark:border-amber-500/20 dark:bg-amber-950/20">
								<p className="font-medium text-amber-900 text-sm dark:text-amber-200">
									Session expired
								</p>
								<p className="mt-0.5 text-amber-800/70 text-xs dark:text-amber-300/70">
									Please enter your password to sign in again.
								</p>
							</div>
						)}

						<div>
							<h2 className="font-semibold text-xl tracking-tight">
								Sign in to your vault
							</h2>
							<p className="mt-1 text-muted-foreground text-sm">
								Enter your credentials to access your passwords
							</p>
						</div>

						<form onSubmit={handleLogin} className="space-y-4">
							<div className="grid gap-1.5">
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
							</div>

							<div className="grid gap-1.5">
								<Label htmlFor="email">Email</Label>
								<Input
									id="email"
									type="email"
									value={email}
									onChange={(e) => setEmail(e.target.value)}
									required
									placeholder="you@example.com"
									disabled={isPrefilled}
								/>
							</div>

							<div className="grid gap-1.5">
								<Label htmlFor="secretKey">Secret Key</Label>
								<InputGroup>
									<InputGroupInput
										id="secretKey"
										type={showSecretKey ? "text" : "password"}
										value={secretKey}
										onChange={(e) => setSecretKey(e.target.value)}
										required
										placeholder="A3-XXXXXX-XXXXXX-XXXXX"
										className="font-mono"
										disabled={isPrefilled && !!secretKey}
									/>
									<InputGroupAddon align="inline-end">
										<InputGroupButton
											size="icon-xs"
											onClick={() => setShowSecretKey(!showSecretKey)}
										>
											{showSecretKey ? (
												<IconEyeSlashOutlineDuo18 className="h-3.5 w-3.5" />
											) : (
												<IconEyeOutlineDuo18 className="h-3.5 w-3.5" />
											)}
										</InputGroupButton>
									</InputGroupAddon>
								</InputGroup>
								<p className="text-muted-foreground text-xs">
									Your Secret Key was provided when you created your account
								</p>
							</div>

							<div className="grid gap-1.5">
								<Label htmlFor="password">Password</Label>
								<InputGroup>
									<InputGroupInput
										id="password"
										type={showPassword ? "text" : "password"}
										value={password}
										onChange={(e) => setPassword(e.target.value)}
										required
										placeholder="Enter your password"
									/>
									<InputGroupAddon align="inline-end">
										<InputGroupButton
											size="icon-xs"
											onClick={() => setShowPassword(!showPassword)}
										>
											{showPassword ? (
												<IconEyeSlashOutlineDuo18 className="h-3.5 w-3.5" />
											) : (
												<IconEyeOutlineDuo18 className="h-3.5 w-3.5" />
											)}
										</InputGroupButton>
									</InputGroupAddon>
								</InputGroup>
							</div>

							{biometricAvailable && (
								<div className="flex items-center gap-2">
									<Checkbox
										id="biometric"
										checked={enableBiometric}
										onCheckedChange={(checked) =>
											setEnableBiometric(checked === true)
										}
									/>
									<Label
										htmlFor="biometric"
										className="flex items-center gap-2 font-normal"
									>
										<IconFingerprintOutlineDuo18 className="h-4 w-4 text-muted-foreground" />
										Enable biometric unlock
									</Label>
								</div>
							)}

							<Button
								type="submit"
								className="w-full"
								disabled={loginMutation.isPending}
							>
								{loginMutation.isPending ? "Signing in..." : "Sign In"}
							</Button>
						</form>
					</div>
				</div>
			</div>
		</div>
	);
}
