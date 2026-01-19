import { encrypt, generateEncryptionKey } from "@bittery/crypto/encryption";
import {
	arrayBufferToBase64,
	deriveKeys,
} from "@bittery/crypto/key-derivation";
import { generateRSAKeyPair } from "@bittery/crypto/rsa";
import {
	generateSecretKey,
	getSecretKeyHint,
} from "@bittery/crypto/secret-key";
import { normalizeServerUrl } from "@bittery/crypto/server-url";
import {
	getServerUrl,
	getTimeUntilExpiry,
	storeAuthToken,
	storeMasterUnlockKey,
	storeSecretKey,
	storeServerUrl,
	storeSessionData,
	storeVaultKeys,
} from "@bittery/crypto/session-storage";
import { generateSRPRegistration } from "@bittery/crypto/srp-client";
import { useTRPC, useTRPCClient } from "@bittery/shared/trpc";
import { Badge, Button, Card, Input, Label, toast } from "@bittery/ui";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Copy, Download, Eye, EyeOff, Users } from "lucide-react";
import { useEffect, useState } from "react";

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
	const [serverUrl, setServerUrl] = useState(
		() => getServerUrl() ?? defaultServerUrl,
	);

	// Query invitation details if token is provided
	const invitationQuery = useQuery({
		...trpc.team.invitations.getByToken.queryOptions({
			token: invitationToken || "",
		}),
		enabled: !!invitationToken,
	});

	const invitation = invitationQuery.data;
	const isInvitationSignup = !!invitationToken && !!invitation;

	// Generate Secret Key on mount
	useEffect(() => {
		const key = generateSecretKey();
		setSecretKey(key);
	}, []);

	const signupMutation = useMutation({
		mutationFn: async (input: any) => {
			return await trpcClient.auth.signup.mutate(input);
		},
		onSuccess: (data) => {
			// Store auth token and vault keys
			storeAuthToken(data.token);
			storeVaultKeys(data.vaultKeys);

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
			organizationName: "",
		},
		onSubmit: async ({ value }) => {
			const normalizedServerUrl = normalizeServerUrl(serverUrl);
			if (!normalizedServerUrl) {
				toast.error("Invalid server URL");
				return;
			}
			storeServerUrl(normalizedServerUrl);
			if (normalizedServerUrl !== serverUrl) {
				setServerUrl(normalizedServerUrl);
			}

			if (!hasAcknowledged) {
				toast.error("Please save your Secret Key before continuing");
				return;
			}

			try {
				// Use invitation email if signing up via invitation
				const email = isInvitationSignup ? invitation.email : value.email;

				// 1. Derive keys from password + secret key
				const { authKey, masterUnlockKey } = await deriveKeys(
					value.password,
					secretKey,
					email,
				);

				// Convert authKey to password string for SRP
				const password = new TextDecoder().decode(authKey);

				// 2. Generate SRP credentials (salt and verifier)
				const { salt, verifier } = await generateSRPRegistration(password);

				// 3. Generate RSA key pair for vault sharing
				const { publicKey, privateKey } = await generateRSAKeyPair();

				// 4. Encrypt private key with Master Unlock Key
				const encryptedPrivateKey = await encrypt(privateKey, masterUnlockKey);

				// 5. Generate vault key and encrypt it
				const vaultKey = generateEncryptionKey();
				const encryptedVaultKey = await encrypt(
					arrayBufferToBase64(vaultKey),
					masterUnlockKey,
				);

				// 6. Call signup mutation
				// Don't include organizationName if signing up via invitation
				// (the user will join the inviting team instead)
				const result = await signupMutation.mutateAsync({
					email,
					name: value.name,
					...(isInvitationSignup ? {} : { organizationName: value.organizationName }),
					secretKeyHint: getSecretKeyHint(secretKey),
					srpSalt: salt,
					srpVerifier: verifier,
					publicKey,
					encryptedPrivateKey: JSON.stringify(encryptedPrivateKey),
					encryptedVaultKey: JSON.stringify(encryptedVaultKey),
				});

				// 7. Store Master Unlock Key in memory
				storeMasterUnlockKey(masterUnlockKey);

				// 8. Store secret key and encrypted session for quick unlock
				storeSecretKey(secretKey);
				await storeSessionData(masterUnlockKey, email, result.userId);

				const timeUntil = getTimeUntilExpiry();
				const daysUntil = timeUntil
					? Math.floor(timeUntil / (1000 * 60 * 60 * 24))
					: 0;

				toast.success(
					`Account created! Quick unlock available for ${daysUntil} days.`,
				);
			} catch (error: any) {
				console.error("Signup error:", error);
				toast.error(error.message || "Failed to create account");
			}
		},
	});

	const copySecretKey = async () => {
		await navigator.clipboard.writeText(secretKey);
		toast.success("Secret Key copied to clipboard");
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
									onBlur={() => {
										const normalized = normalizeServerUrl(serverUrl);
										if (!normalized) {
											toast.error("Invalid server URL");
											return;
										}
										storeServerUrl(normalized);
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
											<span className="text-primary">{invitation.teamName}</span>
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
							<div>
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
										</div>
									)}
								</form.Field>
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
											value={isInvitationSignup ? invitation.email : field.state.value}
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
								disabled={signupMutation.isPending}
							>
								{signupMutation.isPending
									? "Creating Account..."
									: "Create Account"}
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
