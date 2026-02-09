import { normalizeServerUrl } from "@bittery/shared/server-url";
import { useTRPC, useTRPCClient } from "@bittery/shared/trpc";
import { DEFAULT_SESSION_EXPIRY_MS } from "@bittery/storage";
import {
	Badge,
	Button,
	Card,
	cn,
	copyWithToast,
	Input,
	Label,
	toast,
} from "@bittery/ui";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Copy, Download, Eye, EyeOff, Loader2, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { storage } from "@/lib/storage";
import { generateSecretKeyAsync } from "@/lib/wasm-crypto";
import { WorkerCrypto } from "@/lib/worker-crypto";

export default function SignUpForm({
	onSwitchToSignIn,
	invitationToken,
	redirectTo,
}: {
	onSwitchToSignIn: () => void;
	invitationToken?: string;
	redirectTo?: string;
}) {
	const navigate = useNavigate();
	const trpc = useTRPC();
	const trpcClient = useTRPCClient();
	const defaultServerUrl = import.meta.env.VITE_SERVER_URL ?? "";
	const [secretKey, setSecretKey] = useState<string>("");
	const [showSecretKey, setShowSecretKey] = useState(true);
	const [hasAcknowledged, setHasAcknowledged] = useState(false);
	const [showPassword, setShowPassword] = useState(false);
	const [serverUrl, setServerUrl] = useState(defaultServerUrl);
	const [isEncrypting, setIsEncrypting] = useState(false);

	// Load server URL on mount
	useEffect(() => {
		storage.getServerUrl().then((url) => {
			if (url) setServerUrl(url);
		});
	}, []);

	// Query invitation details if token is provided
	const invitationQuery = useQuery({
		...trpc.team.invitations.getByToken.queryOptions({
			token: invitationToken || "",
		}),
		enabled: !!invitationToken,
	});

	const invitation = invitationQuery.data;
	const isInvitationSignup = !!invitationToken && !!invitation;

	// Generate Secret Key on mount (WASM auto-initializes)
	useEffect(() => {
		generateSecretKeyAsync().then(setSecretKey);
	}, []);

	const signupMutation = useMutation({
		mutationFn: async (input: any) => {
			return await trpcClient.auth.signup.mutate(input);
		},
		onSuccess: async (data) => {
			// Store auth token and vault keys
			await storage.storeAuthToken(data.token);
			await storage.storeVaultKeys(data.vaultKeys);

			toast.success("Account created successfully!");
			// Navigate to redirect URL (invitation page) if provided, otherwise go to home
			if (redirectTo) {
				navigate({ to: redirectTo });
			} else {
				navigate({ to: "/home" });
			}
		},
		onError: (error: any) => {
			toast.error(error.message || "Failed to create account");
		},
	});

	const form = useForm({
		defaultValues: {
			email: "",
			password: "",
			name: "",
			accountType: "personal" as "personal" | "organization",
			organizationName: "",
		},
		onSubmit: async ({ value }) => {
			const normalizedServerUrl = normalizeServerUrl(serverUrl);
			if (!normalizedServerUrl) {
				toast.error("Invalid server URL");
				return;
			}
			await storage.storeServerUrl(normalizedServerUrl);
			if (normalizedServerUrl !== serverUrl) {
				setServerUrl(normalizedServerUrl);
			}

			if (!hasAcknowledged) {
				toast.error("Please save your Secret Key before continuing");
				return;
			}

			setIsEncrypting(true);
			const workerCrypto = new WorkerCrypto();
			try {
				// Use invitation email if signing up via invitation
				const email = isInvitationSignup ? invitation.email : value.email;

				// All heavy crypto runs in a Web Worker via WorkerCrypto,
				// keeping the main thread responsive with the spinner.

				// 1. Derive keys (PBKDF2 310k iterations)
				const { authKey, masterUnlockKey } = await workerCrypto.deriveKeys(
					value.password,
					secretKey,
					email,
				);

				// 2. Generate SRP credentials
				const srpPassword = new TextDecoder().decode(authKey);
				const { salt, verifier } =
					await workerCrypto.generateSRPRegistration(srpPassword);

				// 3. Generate RSA-4096 key pair
				const { publicKey, privateKey } =
					await workerCrypto.generateRSAKeyPair();

				// 4. Encrypt private key with Master Unlock Key
				const encryptedPrivateKey = await workerCrypto.encrypt(
					privateKey,
					masterUnlockKey,
				);

				// 5. Generate vault key and encrypt it
				const vaultKey = await workerCrypto.generateEncryptionKey();
				const vaultKeyBase64 = btoa(
					String.fromCharCode(...vaultKey),
				);
				const encryptedVaultKey = await workerCrypto.encrypt(
					vaultKeyBase64,
					masterUnlockKey,
				);

				// 6. Get secret key hint
				const secretKeyHint =
					await workerCrypto.getSecretKeyHint(secretKey);

				// 7. Call signup mutation
				const result = await signupMutation.mutateAsync({
					email,
					name: value.name,
					...(value.accountType === "organization" && value.organizationName
						? { organizationName: value.organizationName }
						: {}),
					secretKeyHint,
					srpSalt: salt,
					srpVerifier: verifier,
					publicKey,
					encryptedPrivateKey: JSON.stringify(encryptedPrivateKey),
					encryptedVaultKey: JSON.stringify(encryptedVaultKey),
				});

				// 8. Store Master Unlock Key in memory
				await storage.setMasterUnlockKey(masterUnlockKey);

				// 9. Store encrypted private key for RSA decryption of shared vault keys
				await storage.storeEncryptedPrivateKey(
					JSON.stringify(encryptedPrivateKey),
				);

				// 10. Store secret key and encrypted session for quick unlock
				await storage.storeSecretKey(secretKey);
				await storage.storeSessionData(
					masterUnlockKey,
					email,
					result.userId,
					undefined,
					result.sessionId,
				);

				const daysUntil = Math.floor(
					DEFAULT_SESSION_EXPIRY_MS / (1000 * 60 * 60 * 24),
				);

				toast.success(
					`Account created! Quick unlock available for ${daysUntil} days.`,
				);
			} catch (error: any) {
				console.error("Signup error:", error);
				toast.error(error.message || "Failed to create account");
			} finally {
				workerCrypto.terminate();
				setIsEncrypting(false);
			}
		},
	});

	const copySecretKey = () => {
		copyWithToast(secretKey, "Secret Key", { showAutoClearMessage: false });
	};

	const downloadEmergencyKit = () => {
		const content = `
BITTERY EMERGENCY KIT
====================

IMPORTANT: Keep this information safe and private!

Secret Key: ${secretKey}

This Secret Key is required to access your account along with your Account Password.
Store it in a safe place - you cannot recover your account without it.

Generated: ${new Date().toLocaleString()}
		`;

		const blob = new Blob([content], { type: "text/plain" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "bittery-emergency-kit.txt";
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
		toast.success("Emergency Kit downloaded");
	};

	return (
		<div className="w-full space-y-4">
			<div className="flex flex-col space-y-2 text-center">
				<h1 className="font-semibold text-xl tracking-tight">
					{isInvitationSignup ? "Accept Invitation" : "Create an account"}
				</h1>
				<p className="text-muted-foreground text-sm">
					{isInvitationSignup
						? `Create an account to join ${invitation.teamName}`
						: "Get started with secure password management"}
				</p>
			</div>

			{!hasAcknowledged ? (
				<Card className="space-y-4 border-0 bg-transparent p-6 shadow-none sm:border sm:bg-card sm:shadow-sm">
					<div className="space-y-2">
						<h2 className="font-medium text-base">Save your Secret Key</h2>
						<p className="text-muted-foreground text-sm leading-relaxed">
							This key is required to access your account. We cannot recover it
							for you.
						</p>
					</div>

					<div className="space-y-4">
						<div className="relative rounded-xl border bg-muted/30 p-4">
							<div className="absolute top-3 right-3">
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="h-8 w-8 text-muted-foreground hover:text-foreground"
									onClick={() => setShowSecretKey(!showSecretKey)}
								>
									{showSecretKey ? <EyeOff size={16} /> : <Eye size={16} />}
								</Button>
							</div>
							<div className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wider">
								Your Secret Key
							</div>
							<div className="break-all pr-8 font-mono text-sm tracking-wide">
								{showSecretKey ? secretKey : "••••••-••••••-•••••-•••••-•••••"}
							</div>
						</div>

						<div className="grid grid-cols-2 gap-3">
							<Button
								type="button"
								variant="outline"
								className="w-full"
								onClick={copySecretKey}
							>
								<Copy size={16} className="mr-2" />
								Copy
							</Button>
							<Button
								type="button"
								variant="outline"
								className="w-full"
								onClick={downloadEmergencyKit}
							>
								<Download size={16} className="mr-2" />
								Download Kit
							</Button>
						</div>
					</div>

					<div className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/30">
						<div className="flex gap-3">
							<div className="text-amber-600 dark:text-amber-400">⚠️</div>
							<div className="space-y-1">
								<p className="font-medium text-amber-900 text-sm dark:text-amber-100">
									There is no account recovery
								</p>
								<p className="text-amber-700 text-xs leading-relaxed dark:text-amber-300">
									If you lose this Secret Key, you will lose access to your
									vault forever. Please save it in a safe place.
								</p>
							</div>
						</div>
					</div>

					<div className="space-y-3">
						<Button
							type="button"
							className="w-full"
							onClick={() => setHasAcknowledged(true)}
						>
							I have saved my Secret Key
						</Button>

						<Button
							type="button"
							variant="ghost"
							onClick={onSwitchToSignIn}
							className="w-full"
						>
							Already have an account? Sign in
						</Button>
					</div>
				</Card>
			) : (
				<Card className="border-0 bg-transparent p-8 shadow-none sm:border sm:bg-card sm:shadow-sm">
					<form
						onSubmit={(e) => {
							e.preventDefault();
							e.stopPropagation();
							form.handleSubmit();
						}}
						className="space-y-4"
					>
						<div>
							<div className="space-y-2">
								<Label htmlFor="serverUrl">Server URL</Label>
								<Input
									id="serverUrl"
									name="serverUrl"
									type="url"
									placeholder="https://your-server.com"
									value={serverUrl}
									onBlur={async () => {
										const normalized = normalizeServerUrl(serverUrl);
										if (!normalized) {
											toast.error("Invalid server URL");
											return;
										}
										await storage.storeServerUrl(normalized);
										if (normalized !== serverUrl) {
											setServerUrl(normalized);
										}
									}}
									onChange={(e) => setServerUrl(e.target.value)}
									required
									className="h-10"
								/>
								<p className="text-muted-foreground text-xs">
									Use your self-hosted Bittery server URL.
								</p>
							</div>
						</div>

						<div>
							<form.Field name="name">
								{(field) => (
									<div className="space-y-2">
										<Label htmlFor={field.name}>Full Name</Label>
										<Input
											id={field.name}
											name={field.name}
											placeholder="John Doe"
											value={field.state.value}
											onBlur={field.handleBlur}
											onChange={(e) => field.handleChange(e.target.value)}
											required
											className="h-10"
										/>
									</div>
								)}
							</form.Field>
						</div>

						{isInvitationSignup ? (
							<div className="rounded-lg border bg-muted/30 p-4">
								<div className="flex items-start gap-3">
									<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10">
										<Users className="h-5 w-5 text-primary" />
									</div>
									<div className="space-y-1">
										<p className="font-medium text-sm">
											You've been invited to join{" "}
											<span className="text-primary">
												{invitation.teamName}
											</span>
										</p>
										<div className="flex items-center gap-2 text-muted-foreground text-xs">
											<span>Invited by {invitation.invitedByName}</span>
											<span>·</span>
											<Badge variant="secondary" className="text-xs">
												{invitation.role}
											</Badge>
										</div>
									</div>
								</div>
							</div>
						) : (
							<div className="space-y-4">
								<form.Field name="accountType">
									{(field) => (
										<div className="space-y-3">
											<Label>Account Type</Label>
											<div className="grid grid-cols-2 gap-3">
												<Button
													type="button"
													variant={
														field.state.value === "personal"
															? "default"
															: "outline"
													}
													className="h-auto flex-col items-start gap-1 p-4"
													onClick={() => field.handleChange("personal")}
												>
													<span className="font-medium">Personal</span>
													<span
														className={cn(
															"text-left font-normal text-xs",
															field.state.value === "personal"
																? "text-primary-foreground"
																: "text-muted-foreground",
														)}
													>
														For individual use
													</span>
												</Button>
												<Button
													type="button"
													variant={
														field.state.value === "organization"
															? "default"
															: "outline"
													}
													className="h-auto flex-col items-start gap-1 p-4"
													onClick={() => field.handleChange("organization")}
												>
													<span className="font-medium">Organization</span>
													<span
														className={cn(
															"text-left font-normal text-xs",
															field.state.value === "organization"
																? "text-primary-foreground"
																: "text-muted-foreground",
														)}
													>
														For teams and companies
													</span>
												</Button>
											</div>
										</div>
									)}
								</form.Field>

								<form.Subscribe selector={(state) => state.values.accountType}>
									{(accountType) =>
										accountType === "organization" ? (
											<form.Field name="organizationName">
												{(field) => (
													<div className="space-y-2">
														<Label htmlFor={field.name}>
															Organization Name
														</Label>
														<Input
															id={field.name}
															name={field.name}
															placeholder="Acme Inc."
															value={field.state.value}
															onBlur={field.handleBlur}
															onChange={(e) =>
																field.handleChange(e.target.value)
															}
															required
															className="h-10"
														/>
														<p className="text-[0.8rem] text-muted-foreground">
															This will be the name of your team workspace
														</p>
													</div>
												)}
											</form.Field>
										) : null
									}
								</form.Subscribe>
							</div>
						)}

						<div>
							<form.Field name="email">
								{(field) => (
									<div className="space-y-2">
										<Label htmlFor={field.name}>Email</Label>
										<Input
											id={field.name}
											name={field.name}
											type="email"
											placeholder="name@example.com"
											value={
												isInvitationSignup
													? invitation.email
													: field.state.value
											}
											onBlur={field.handleBlur}
											onChange={(e) => field.handleChange(e.target.value)}
											required
											disabled={isInvitationSignup}
											className="h-10"
										/>
										{isInvitationSignup && (
											<p className="text-muted-foreground text-xs">
												This email was used to invite you and cannot be changed.
											</p>
										)}
									</div>
								)}
							</form.Field>
						</div>

						<div>
							<form.Field name="password">
								{(field) => (
									<div className="space-y-2">
										<Label htmlFor={field.name}>Master Password</Label>
										<div className="relative">
											<Input
												id={field.name}
												name={field.name}
												type={showPassword ? "text" : "password"}
												value={field.state.value}
												onBlur={field.handleBlur}
												onChange={(e) => field.handleChange(e.target.value)}
												required
												className="h-10 pr-10"
											/>
											<Button
												type="button"
												variant="ghost"
												size="icon"
												className="absolute top-0 right-0 h-10 w-10 text-muted-foreground hover:text-foreground"
												onClick={() => setShowPassword(!showPassword)}
											>
												{showPassword ? (
													<EyeOff size={16} />
												) : (
													<Eye size={16} />
												)}
											</Button>
										</div>
										<p className="text-[0.8rem] text-muted-foreground">
											Must be at least 8 characters long.
										</p>
									</div>
								)}
							</form.Field>
						</div>

						<div className="pt-2">
							<Button
								type="submit"
								className="h-10 w-full"
								disabled={isEncrypting || signupMutation.isPending}
							>
								{isEncrypting || signupMutation.isPending ? (
									<>
										<Loader2 size={16} className="mr-2 animate-spin" />
										{isEncrypting
											? "Setting up encryption..."
											: "Creating account..."}
									</>
								) : (
									"Create Account"
								)}
							</Button>
						</div>

						<Button
							type="button"
							variant="link"
							onClick={() => setHasAcknowledged(false)}
							className="w-full text-muted-foreground"
						>
							← Back to Secret Key
						</Button>
					</form>
				</Card>
			)}
		</div>
	);
}
