import { useTRPC, useTRPCClient } from "@bittery/shared/trpc";
import { DEFAULT_SESSION_EXPIRY_MS } from "@bittery/storage";
import {
	Badge,
	Button,
	Card,
	CardContent,
	cn,
	Input,
	Label,
	toast,
} from "@bittery/ui";
import {
	IconCircleCheck2OutlineDuo18 as CheckCircle2,
	IconClipboardArrowInOutlineDuo18 as Download,
	IconEyeOutlineDuo18 as Eye,
	IconEyeSlashOutlineDuo18 as EyeOff,
	IconLoader2OutlineDuo18 as Loader2,
	IconUsers6OutlineDuo18 as Users,
} from "@bittery/ui/icons";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { resolveActiveAuthServerUrl } from "@/lib/auth-server";
import { downloadRecoveryKit } from "@/lib/recovery-kit";
import { storage } from "@/lib/storage";
import {
	generateRecoveryKeyAsync,
	generateSecretKeyAsync,
} from "@/lib/wasm-crypto";
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
	const [secretKey, setSecretKey] = useState<string>("");
	const [recoveryKey, setRecoveryKey] = useState<string>("");
	const [hasDownloadedKit, setHasDownloadedKit] = useState(false);
	const [showPassword, setShowPassword] = useState(false);
	const [isEncrypting, setIsEncrypting] = useState(false);

	// Query invitation details if token is provided
	const invitationQuery = useQuery({
		...trpc.team.invitations.getByToken.queryOptions({
			token: invitationToken || "",
		}),
		enabled: !!invitationToken,
	});
	const registrationStatusQuery = useQuery(
		trpc.auth.registrationStatus.queryOptions(),
	);

	const invitation = invitationQuery.data;
	const hasInvitationToken = !!invitationToken;
	const isInvitationSignup = hasInvitationToken && !!invitation;
	const registrationStatus = registrationStatusQuery.data;
	const isSelfHostedMode = registrationStatus?.mode === "self-hosted";
	const allowPublicSignup = registrationStatus?.allowPublicSignup ?? true;
	const signupHeading = isInvitationSignup
		? "Accept Invitation"
		: isSelfHostedMode
			? "Create admin account"
			: "Create an account";
	const signupDescription = isInvitationSignup
		? "Create your account to securely join the invited workspace."
		: isSelfHostedMode
			? "Set up the first admin account for this server."
			: "Create your encrypted account and start protecting your vaults.";

	// Generate Secret Key + Recovery Key on mount (WASM auto-initializes)
	useEffect(() => {
		Promise.all([generateSecretKeyAsync(), generateRecoveryKeyAsync()]).then(
			([generatedSecretKey, generatedRecoveryKey]) => {
				setSecretKey(generatedSecretKey);
				setRecoveryKey(generatedRecoveryKey);
			},
		);
	}, []);

	const signupMutation = useMutation({
		mutationFn: async (input: {
			email: string;
			name: string;
			secretKeyHint: string;
			srpSalt: string;
			srpVerifier: string;
			publicKey: string;
			encryptedPrivateKey: string;
			encryptedMasterKey: string;
			recoveryKeyHint: string;
			encryptedVaultKey: string;
			organizationName?: string;
			token?: string;
		}) => {
			if (isInvitationSignup) {
				return trpcClient.auth.signupWithInvitation.mutate({
					token: input.token || "",
					email: input.email,
					name: input.name,
					secretKeyHint: input.secretKeyHint,
					srpSalt: input.srpSalt,
					srpVerifier: input.srpVerifier,
					publicKey: input.publicKey,
					encryptedPrivateKey: input.encryptedPrivateKey,
					encryptedMasterKey: input.encryptedMasterKey,
					recoveryKeyHint: input.recoveryKeyHint,
					encryptedVaultKey: input.encryptedVaultKey,
				});
			}

			return trpcClient.auth.signup.mutate({
				email: input.email,
				name: input.name,
				organizationName: input.organizationName,
				secretKeyHint: input.secretKeyHint,
				srpSalt: input.srpSalt,
				srpVerifier: input.srpVerifier,
				publicKey: input.publicKey,
				encryptedPrivateKey: input.encryptedPrivateKey,
				encryptedMasterKey: input.encryptedMasterKey,
				recoveryKeyHint: input.recoveryKeyHint,
				encryptedVaultKey: input.encryptedVaultKey,
			});
		},
		onSuccess: async (data) => {
			// Store auth token and vault keys
			await storage.storeAuthToken(data.token);
			await storage.storeVaultKeys(data.vaultKeys);

			toast.success("Account created successfully!");
			// Invitation signup is accepted server-side.
			if (isInvitationSignup) {
				navigate({ to: "/team" });
			} else if (redirectTo) {
				// Navigate to redirect URL (invitation page) if provided, otherwise go to home
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
			await resolveActiveAuthServerUrl();

			if (!hasDownloadedKit) {
				toast.error("Please download your Emergency Kit before continuing");
				return;
			}

			setIsEncrypting(true);
			const workerCrypto = new WorkerCrypto();
			try {
				// Use invitation email if signing up via invitation
				const email = isInvitationSignup
					? invitation?.email || value.email
					: value.email;

				// All heavy crypto runs in a Web Worker via WorkerCrypto,
				// keeping the main thread responsive with the spinner.

				// 1. Derive raw master key, then split into auth + unlock keys
				const masterKey = await workerCrypto.deriveMasterKey(
					value.password,
					secretKey,
					email,
				);
				const { authKey, masterUnlockKey } =
					await workerCrypto.deriveKeysFromMasterKey(masterKey, email);

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
				const vaultKeyBase64 = btoa(String.fromCharCode(...vaultKey));
				const encryptedVaultKey = await workerCrypto.encrypt(
					vaultKeyBase64,
					masterUnlockKey,
				);

				// 6. Get secret key hint
				const secretKeyHint = await workerCrypto.getSecretKeyHint(secretKey);

				// 7. Encrypt raw master key with recovery key material
				const encryptedMasterKey = await workerCrypto.encryptMasterKey(
					masterKey,
					recoveryKey,
					email,
				);
				const recoveryKeyHint =
					recoveryKey.split("-").slice(0, 2).join("-") || "R1";

				// 8. Call signup mutation
				const result = await signupMutation.mutateAsync({
					email,
					name: value.name,
					...(!isSelfHostedMode &&
					value.accountType === "organization" &&
					value.organizationName
						? { organizationName: value.organizationName }
						: {}),
					...(isInvitationSignup ? { token: invitationToken } : {}),
					secretKeyHint,
					srpSalt: salt,
					srpVerifier: verifier,
					publicKey,
					encryptedPrivateKey: JSON.stringify(encryptedPrivateKey),
					encryptedMasterKey: JSON.stringify(encryptedMasterKey),
					recoveryKeyHint,
					encryptedVaultKey: JSON.stringify(encryptedVaultKey),
				});

				// 9. Store Master Unlock Key in memory
				await storage.setMasterUnlockKey(masterUnlockKey);

				// 10. Store encrypted private key for RSA decryption of shared vault keys
				await storage.storeEncryptedPrivateKey(
					JSON.stringify(encryptedPrivateKey),
				);

				// 11. Store secret key and encrypted session for quick unlock
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

	const downloadEmergencyKit = async () => {
		if (!secretKey || !recoveryKey) {
			toast.error("Still generating account keys. Please try again.");
			return;
		}

		const result = await downloadRecoveryKit({
			fileName: "bittery-emergency-kit",
			title: "Bittery Emergency Kit",
			subtitle:
				"Contains your Secret Key and Recovery Key for offline storage.",
			entries: [
				{
					label: "Secret Key",
					value: secretKey,
					description:
						"Required with your master password to unlock your account.",
				},
				{
					label: "Recovery Key",
					value: recoveryKey,
					description: "Required to reset your password if forgotten.",
				},
			],
			cautions: [
				"Store this kit offline in a secure location you trust.",
				"Do not save this file in shared folders or chats.",
				"If Secret Key, Recovery Key, and password are all lost, your vault cannot be recovered.",
			],
			footerNote:
				"Bittery is zero-knowledge: recovery material is generated and handled locally in your browser.",
			includeHandwrittenPasswordSection: true,
		});

		setHasDownloadedKit(true);
		if (result === "pdf-downloaded") {
			toast.success("Emergency Kit PDF downloaded.");
			return;
		}

		toast.success("PDF failed. Emergency Kit downloaded as text backup.");
	};

	if (hasInvitationToken && invitationQuery.isError) {
		return (
			<div className="w-full">
				<h1 className="text-center font-semibold text-2xl tracking-tight">
					Invitation Required
				</h1>
				<Card className="mt-6">
					<CardContent>
						<div className="space-y-4">
							<p className="text-muted-foreground text-sm leading-relaxed">
								This invitation link is invalid or expired. Ask your admin to
								send a new invite link.
							</p>
							<Button
								type="button"
								onClick={onSwitchToSignIn}
								className="w-full"
							>
								Back to Sign In
							</Button>
						</div>
					</CardContent>
				</Card>
			</div>
		);
	}

	if (hasInvitationToken && invitationQuery.isLoading) {
		return (
			<div className="w-full">
				<h1 className="text-center font-semibold text-2xl tracking-tight">
					Loading invitation
				</h1>
				<Card className="mt-6">
					<CardContent>
						<div className="flex items-center justify-center gap-2 text-muted-foreground text-sm">
							<Loader2 className="h-4 w-4 animate-spin" />
							Verifying invitation link...
						</div>
					</CardContent>
				</Card>
			</div>
		);
	}

	if (
		!hasInvitationToken &&
		!registrationStatusQuery.isLoading &&
		!allowPublicSignup
	) {
		return (
			<div className="w-full">
				<h1 className="text-center font-semibold text-2xl tracking-tight">
					Invite-Only Registration
				</h1>
				<Card className="mt-6">
					<CardContent>
						<div className="space-y-4">
							<p className="text-muted-foreground text-sm leading-relaxed">
								Registration is closed on this server. Ask an admin for an
								invite link.
							</p>
							<Button
								type="button"
								onClick={onSwitchToSignIn}
								className="w-full"
							>
								Back to Sign In
							</Button>
						</div>
					</CardContent>
				</Card>
			</div>
		);
	}

	const hasAllKeyMaterial = Boolean(secretKey) && Boolean(recoveryKey);

	return (
		<div className="w-full">
			<h1 className="text-center font-semibold text-2xl tracking-tight">
				{signupHeading}
			</h1>
			<p className="mx-auto mt-2 max-w-80 text-center text-muted-foreground text-sm">
				{signupDescription}
			</p>
			<Card className="mt-6">
				<CardContent>
					<form
						onSubmit={(e) => {
							e.preventDefault();
							e.stopPropagation();
							form.handleSubmit();
						}}
						className="space-y-4"
					>
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
												{invitation?.teamName}
											</span>
										</p>
										<div className="flex items-center gap-2 text-muted-foreground text-xs">
											<span>Invited by {invitation?.invitedByName}</span>
											<span>·</span>
											<Badge variant="secondary" className="text-xs">
												{invitation?.role}
											</Badge>
										</div>
									</div>
								</div>
							</div>
						) : !isSelfHostedMode ? (
							<div className="space-y-4">
								<form.Field name="accountType">
									{(field) => (
										<div className="space-y-3">
											<Label>Account Type</Label>
											<div className="grid gap-3 sm:grid-cols-2">
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
						) : null}

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
													? invitation?.email || field.state.value
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

						<button
							type="button"
							disabled={!hasAllKeyMaterial}
							onClick={downloadEmergencyKit}
							className={cn(
								"flex w-full items-center gap-2.5 rounded-lg border px-3.5 py-3 text-left transition-colors",
								hasDownloadedKit
									? "border-emerald-200 bg-emerald-50/50 dark:border-emerald-900/40 dark:bg-emerald-950/20"
									: "hover:bg-muted/50",
							)}
						>
							{hasDownloadedKit ? (
								<CheckCircle2
									size={16}
									className="shrink-0 text-emerald-600 dark:text-emerald-400"
								/>
							) : (
								<Download
									size={16}
									className="shrink-0 text-muted-foreground"
								/>
							)}
							<div className="min-w-0 flex-1">
								<p className="font-medium text-sm">
									{hasDownloadedKit
										? "Emergency Kit saved"
										: "Download Emergency Kit"}
								</p>
								<p className="text-muted-foreground text-xs">
									Secret Key & Recovery Key for account recovery
								</p>
							</div>
						</button>

						<div className="pt-1">
							<Button
								type="submit"
								className="h-10 w-full"
								disabled={
									isEncrypting || signupMutation.isPending || !hasDownloadedKit
								}
							>
								{isEncrypting || signupMutation.isPending ? (
									<>
										<Loader2 size={16} className="mr-2 animate-spin" />
										{isEncrypting
											? "Setting up encryption..."
											: "Creating account..."}
									</>
								) : !hasDownloadedKit ? (
									<>
										<Download size={16} className="mr-2" />
										Download Emergency Kit to continue
									</>
								) : (
									"Create Account"
								)}
							</Button>
						</div>

						<Button
							type="button"
							variant="ghost"
							onClick={onSwitchToSignIn}
							className="w-full"
						>
							Already have an account? Sign in
						</Button>
					</form>
				</CardContent>
			</Card>
		</div>
	);
}
