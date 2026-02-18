import { useTRPC, useTRPCClient } from "@bittery/shared/trpc";
import { DEFAULT_SESSION_EXPIRY_MS } from "@bittery/storage";
import { Badge, Button, cn, Input, Label, toast } from "@bittery/ui";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
	CheckCircle2,
	Download,
	Eye,
	EyeOff,
	KeyRound,
	Loader2,
	ShieldAlert,
	Users,
} from "lucide-react";
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
	const [hasAcknowledged, setHasAcknowledged] = useState(false);
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

			if (!hasAcknowledged) {
				toast.error("Please save your Emergency Kit before continuing");
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
				<h1 className="mb-6 text-center font-semibold text-2xl tracking-tight">
					Invitation Required
				</h1>
				<div className="space-y-4">
					<p className="text-muted-foreground text-sm leading-relaxed">
						This invitation link is invalid or expired. Ask your admin to send a
						new invite link.
					</p>
					<Button type="button" onClick={onSwitchToSignIn} className="w-full">
						Back to Sign In
					</Button>
				</div>
			</div>
		);
	}

	if (hasInvitationToken && invitationQuery.isLoading) {
		return (
			<div className="w-full">
				<h1 className="mb-6 text-center font-semibold text-2xl tracking-tight">
					Loading invitation
				</h1>
				<div className="space-y-4">
					<div className="flex items-center justify-center gap-2 text-muted-foreground text-sm">
						<Loader2 className="h-4 w-4 animate-spin" />
						Verifying invitation link...
					</div>
				</div>
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
				<h1 className="mb-6 text-center font-semibold text-2xl tracking-tight">
					Invite-Only Registration
				</h1>
				<div className="space-y-4">
					<p className="text-muted-foreground text-sm leading-relaxed">
						Registration is closed on this server. Ask an admin for an invite
						link.
					</p>
					<Button type="button" onClick={onSwitchToSignIn} className="w-full">
						Back to Sign In
					</Button>
				</div>
			</div>
		);
	}

	const signupHeading = isInvitationSignup
		? "Accept Invitation"
		: isSelfHostedMode
			? "Create admin account"
			: "Create an account";
	const hasAllKeyMaterial = Boolean(secretKey) && Boolean(recoveryKey);

	return !hasAcknowledged ? (
		<div className="w-full">
			<h1 className="mb-6 text-center font-semibold text-2xl tracking-tight">
				{signupHeading}
			</h1>
			<div className="space-y-4">
				<div className="relative overflow-hidden rounded-2xl border border-emerald-500/25 bg-gradient-to-br from-emerald-500/10 via-background to-primary/5 p-5 shadow-sm">
					<div className="-right-10 -top-16 pointer-events-none absolute h-36 w-36 rounded-full bg-emerald-500/20 blur-3xl" />
					<div className="-bottom-14 -left-8 pointer-events-none absolute h-32 w-32 rounded-full bg-primary/15 blur-3xl" />

					<div className="relative space-y-4">
						<div className="flex items-start justify-between gap-3">
							<div>
								<p className="font-medium text-[0.7rem] text-emerald-700 uppercase tracking-[0.12em] dark:text-emerald-300">
									Emergency Kit
								</p>
								<h2 className="mt-2 font-semibold text-lg tracking-tight">
									Secure recovery materials before setup
								</h2>
							</div>
							<div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-2">
								<KeyRound size={16} className="text-emerald-700 dark:text-emerald-300" />
							</div>
						</div>

						<p className="text-muted-foreground text-sm leading-relaxed">
							Download a printable kit with your Secret Key, Recovery Key, and
							a handwritten password section for offline storage.
						</p>

						<div className="grid gap-2 text-xs text-foreground/80 sm:grid-cols-2">
							<div className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/85 px-3 py-2">
								<CheckCircle2 size={14} className="shrink-0 text-emerald-600" />
								<span>Generated locally in your browser</span>
							</div>
							<div className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/85 px-3 py-2">
								<ShieldAlert size={14} className="shrink-0 text-amber-600" />
								<span>Keep it offline and private</span>
							</div>
						</div>

						<Button
							type="button"
							variant="default"
							className={cn(
								"w-full shadow-sm",
								hasDownloadedKit
									? "bg-emerald-600 text-white hover:bg-emerald-600/90"
									: "",
							)}
							disabled={!hasAllKeyMaterial}
							onClick={downloadEmergencyKit}
						>
							<Download size={16} className="mr-2" />
							{hasDownloadedKit ? "Emergency Kit Saved" : "Download Emergency Kit"}
						</Button>

						<p className="text-muted-foreground text-xs">
							PDF downloads automatically. If PDF generation fails, a text
							backup is downloaded.
						</p>

						{hasDownloadedKit ? (
							<div className="flex items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 font-medium text-emerald-700 text-xs dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300">
								<CheckCircle2 size={14} />
								Emergency Kit saved for this signup session.
							</div>
						) : null}

						<div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2">
							<p className="font-medium text-[0.7rem] text-amber-700 uppercase tracking-[0.1em] dark:text-amber-300">
								No Recovery Fallback
							</p>
							<p className="mt-1 text-xs leading-relaxed text-amber-900/80 dark:text-amber-200/80">
								If your password, Secret Key, and Recovery Key are all lost,
								your vault cannot be recovered.
							</p>
						</div>
					</div>
				</div>

				<div className="space-y-3">
					<Button
						type="button"
						className="w-full"
						disabled={!hasAllKeyMaterial || !hasDownloadedKit}
						onClick={() => setHasAcknowledged(true)}
					>
						I have saved my Emergency Kit
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
			</div>
		</div>
	) : (
		<div className="w-full">
			<h1 className="mb-6 text-center font-semibold text-2xl tracking-tight">
				{signupHeading}
			</h1>
			<div>
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
										<span className="text-primary">{invitation?.teamName}</span>
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
													<Label htmlFor={field.name}>Organization Name</Label>
													<Input
														id={field.name}
														name={field.name}
														placeholder="Acme Inc."
														value={field.state.value}
														onBlur={field.handleBlur}
														onChange={(e) => field.handleChange(e.target.value)}
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
											{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
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
						← Back to Emergency Kit
					</Button>
				</form>
			</div>
		</div>
	);
}
