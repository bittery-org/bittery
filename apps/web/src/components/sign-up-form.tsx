import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Copy, Download, Eye, EyeOff } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	arrayBufferToBase64,
	deriveKeys,
	encrypt,
	generateEncryptionKey,
	generateRSAKeyPair,
	generateSecretKey,
	generateSRPRegistration,
	getSecretKeyHint,
	getTimeUntilExpiry,
	storeMasterUnlockKey,
	storeSecretKey,
	storeSessionData,
} from "@/lib/crypto";
import { useTRPCClient } from "@/utils/trpc";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export default function SignUpForm({
	onSwitchToSignIn,
}: {
	onSwitchToSignIn: () => void;
}) {
	const navigate = useNavigate();
	const trpcClient = useTRPCClient();
	const [secretKey, setSecretKey] = useState<string>("");
	const [showSecretKey, setShowSecretKey] = useState(true);
	const [hasAcknowledged, setHasAcknowledged] = useState(false);
	const [showPassword, setShowPassword] = useState(false);

	// Generate Secret Key on mount
	useEffect(() => {
		const key = generateSecretKey();
		setSecretKey(key);
	}, []);

	const signupMutation = useMutation({
		mutationFn: async (input: any) => {
			return await trpcClient.auth.signup.mutate(input);
		},
		onSuccess: (_data) => {
			toast.success("Account created successfully!");
			navigate({ to: "/dashboard" });
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
		},
		onSubmit: async ({ value }) => {
			if (!hasAcknowledged) {
				toast.error("Please save your Secret Key before continuing");
				return;
			}

			try {
				// 1. Derive keys from password + secret key
				const { authKey, masterUnlockKey } = await deriveKeys(
					value.password,
					secretKey,
					value.email,
				);

				// 2. Generate SRP credentials
				const { salt, verifier } = await generateSRPRegistration(
					value.email,
					authKey,
				);

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
				const result = await signupMutation.mutateAsync({
					email: value.email,
					name: value.name,
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
				await storeSessionData(
					masterUnlockKey,
					value.email,
					result.userId,
				);

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
		<div className="mx-auto mt-16 w-full max-w-2xl space-y-8 p-6">
			<div className="text-center">
				<h1 className="font-semibold text-3xl tracking-tight">Create Account</h1>
				<p className="mt-2 text-muted-foreground text-sm">Get started with secure password management</p>
			</div>

			{!hasAcknowledged ? (
				<Card className="space-y-6 p-6">
					<div className="space-y-2">
						<h2 className="font-semibold text-xl tracking-tight">Your Secret Key</h2>
						<p className="text-muted-foreground text-sm leading-relaxed">
							This Secret Key is required to access your account. Store it
							safely - you cannot recover your account without it.
						</p>
					</div>

					<div className="space-y-3">
						<div className="flex items-center gap-2">
							<div className="flex-1 rounded-lg border-2 bg-muted/50 p-4 font-mono text-base tracking-wide">
								{showSecretKey ? secretKey : "••••••-••••••-•••••-•••••-•••••"}
							</div>
							<Button
								type="button"
								variant="outline"
								size="icon"
								onClick={() => setShowSecretKey(!showSecretKey)}
							>
								{showSecretKey ? <EyeOff size={18} /> : <Eye size={18} />}
							</Button>
						</div>

						<div className="flex gap-2">
							<Button
								type="button"
								variant="outline"
								className="flex-1"
								onClick={copySecretKey}
							>
								<Copy size={16} className="mr-2" />
								Copy
							</Button>
							<Button
								type="button"
								variant="outline"
								className="flex-1"
								onClick={downloadEmergencyKit}
							>
								<Download size={16} className="mr-2" />
								Download Kit
							</Button>
						</div>
					</div>

					<div className="space-y-3 rounded-lg border border-yellow-200 bg-yellow-50 p-4 dark:border-yellow-900 dark:bg-yellow-950/30">
						<p className="font-semibold text-sm text-yellow-900 dark:text-yellow-100">⚠️ Important Security Notice</p>
						<ul className="list-inside list-disc space-y-1.5 text-sm text-yellow-700 dark:text-yellow-300">
							<li>Save your Secret Key before continuing</li>
							<li>Store it in a safe place (password manager, safe, etc.)</li>
							<li>Never share it with anyone</li>
							<li>There is no account recovery without it</li>
						</ul>
					</div>

					<Button
						type="button"
						className="w-full"
						onClick={() => setHasAcknowledged(true)}
					>
						I've Saved My Secret Key, Continue
					</Button>

					<button
						type="button"
						onClick={onSwitchToSignIn}
						className="w-full text-muted-foreground text-sm hover:text-foreground"
					>
						Already have an account? Sign in
					</button>
				</Card>
			) : (
				<Card className="p-6">
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
										<Label htmlFor={field.name}>Name</Label>
										<Input
											id={field.name}
											name={field.name}
											value={field.state.value}
											onBlur={field.handleBlur}
											onChange={(e) => field.handleChange(e.target.value)}
											required
										/>
									</div>
								)}
							</form.Field>
						</div>

						<div>
							<form.Field name="email">
								{(field) => (
									<div className="space-y-2">
										<Label htmlFor={field.name}>Email</Label>
										<Input
											id={field.name}
											name={field.name}
											type="email"
											value={field.state.value}
											onBlur={field.handleBlur}
											onChange={(e) => field.handleChange(e.target.value)}
											required
										/>
									</div>
								)}
							</form.Field>
						</div>

						<div>
							<form.Field name="password">
								{(field) => (
									<div className="space-y-2">
										<Label htmlFor={field.name}>Account Password</Label>
										<div className="flex gap-2">
											<Input
												id={field.name}
												name={field.name}
												type={showPassword ? "text" : "password"}
												value={field.state.value}
												onBlur={field.handleBlur}
												onChange={(e) => field.handleChange(e.target.value)}
												required
												className="flex-1"
											/>
											<Button
												type="button"
												variant="outline"
												size="icon"
												onClick={() => setShowPassword(!showPassword)}
											>
												{showPassword ? (
													<EyeOff size={18} />
												) : (
													<Eye size={18} />
												)}
											</Button>
										</div>
										<p className="text-muted-foreground text-xs">
											Minimum 8 characters. This encrypts your vault along with
											your Secret Key.
										</p>
									</div>
								)}
							</form.Field>
						</div>

						<Button
							type="submit"
							className="w-full"
							disabled={signupMutation.isPending}
						>
							{signupMutation.isPending
								? "Creating Account..."
								: "Create Account"}
						</Button>

						<button
							type="button"
							onClick={() => setHasAcknowledged(false)}
							className="w-full text-muted-foreground text-sm hover:text-foreground"
						>
							← Back to Secret Key
						</button>
					</form>
				</Card>
			)}
		</div>
	);
}
