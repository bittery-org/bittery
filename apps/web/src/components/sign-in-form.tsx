import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Eye, EyeOff } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	deriveKeys,
	finishSRPLogin,
	getStoredSecretKey,
	getStoredSessionData,
	getTimeUntilExpiry,
	hasStoredSecretKey,
	isSessionValid,
	startSRPLogin,
	storeAuthToken,
	storeMasterUnlockKey,
	storeSecretKey,
	storeSessionData,
	storeVaultKeys,
	validateSecretKey,
} from "@/lib/crypto";
import { useTRPCClient } from "@/utils/trpc";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export default function SignInForm({
	onSwitchToSignUp,
}: {
	onSwitchToSignUp: () => void;
}) {
	const navigate = useNavigate();
	const trpcClient = useTRPCClient();
	const [_email, setEmail] = useState("");
	const [secretKeyHint, setSecretKeyHint] = useState<string | null>(null);
	const [showPassword, setShowPassword] = useState(false);
	const [showSecretKey, setShowSecretKey] = useState(false);
	const [isQuickUnlock, setIsQuickUnlock] = useState(false);
	const [sessionExpired, setSessionExpired] = useState(false);

	// Check if quick unlock is available on mount
	useEffect(() => {
		if (hasStoredSecretKey()) {
			const storedSecretKey = getStoredSecretKey();
			const sessionData = getStoredSessionData();

			if (storedSecretKey && sessionData) {
				// Check if session is still valid
				if (isSessionValid()) {
					setIsQuickUnlock(true);
					setEmail(sessionData.email);
					form.setFieldValue("email", sessionData.email);
					form.setFieldValue("secretKey", storedSecretKey);
				} else {
					// Session expired, show message
					setSessionExpired(true);
					const timeExpired = Date.now() - sessionData.expiresAt;
					const daysExpired = Math.floor(timeExpired / (1000 * 60 * 60 * 24));
					toast.info(
						`Session expired ${daysExpired > 0 ? `${daysExpired} days ago` : "recently"}. Please sign in again.`,
					);
				}
			}
		}
	}, []);

	const loginMutation = useMutation({
		mutationFn: async (values: {
			email: string;
			password: string;
			secretKey: string;
		}) => {
			// 1. Derive keys
			const { authKey, masterUnlockKey } = await deriveKeys(
				values.password,
				values.secretKey,
				values.email,
			);

			// 2. Start SRP login (client-side)
			const { clientPublicKey, clientSecret } = await startSRPLogin(
				values.email,
				authKey,
			);

			// 3. Get server challenge
			const startResult = await trpcClient.auth.startLogin.mutate({
				email: values.email,
			});

			// 4. Finish SRP login (compute proof)
			const { proof, clientPublicKey: actualClientPublicKey } =
				await finishSRPLogin(clientSecret, {
					salt: startResult.salt,
					serverPublicKey: startResult.serverPublicKey,
				});

			// 5. Verify proof and get session
			const finishResult = await trpcClient.auth.finishLogin.mutate({
				userId: startResult.userId,
				serverSecret: startResult.serverSecret,
				clientPublicKey: actualClientPublicKey,
				clientProof: proof,
			});

			return { finishResult, masterUnlockKey };
		},
		onSuccess: async ({ finishResult, masterUnlockKey }, variables) => {
			// Store session data
			storeAuthToken(finishResult.token);
			storeVaultKeys(finishResult.vaultKeys);
			storeMasterUnlockKey(masterUnlockKey);

			// Store secret key and encrypted session for quick unlock
			storeSecretKey(variables.secretKey);
			await storeSessionData(
				masterUnlockKey,
				variables.email,
				finishResult.user.id,
			);

			const timeUntil = getTimeUntilExpiry();
			const daysUntil = timeUntil ? Math.floor(timeUntil / (1000 * 60 * 60 * 24)) : 0;

			toast.success(
				`Signed in successfully! Quick unlock available for ${daysUntil} days.`,
			);
			navigate({ to: "/dashboard" });
		},
		onError: (error: any) => {
			toast.error(error.message || "Failed to sign in");
		},
	});

	const form = useForm({
		defaultValues: {
			email: "",
			password: "",
			secretKey: "",
		},
		onSubmit: async ({ value }) => {
			if (!validateSecretKey(value.secretKey)) {
				toast.error("Invalid Secret Key format");
				return;
			}
			await loginMutation.mutateAsync(value);
		},
	});

	const checkEmailMutation = useMutation({
		mutationFn: async (input: { email: string }) => {
			return await trpcClient.auth.checkEmail.query(input);
		},
		onSuccess: (data) => {
			if (data.exists) {
				setSecretKeyHint(data.secretKeyHint);
			} else {
				toast.error("No account found with this email");
			}
		},
	});

	const handleEmailBlur = (email: string) => {
		if (email?.includes("@")) {
			setEmail(email);
			checkEmailMutation.mutate({ email });
		}
	};

	return (
		<div className="mx-auto mt-16 w-full max-w-md space-y-8 p-6">
			<div className="text-center">
				<h1 className="font-semibold text-3xl tracking-tight">
					{isQuickUnlock ? "Quick Unlock" : "Welcome Back"}
				</h1>
				<p className="mt-2 text-muted-foreground text-sm">
					{isQuickUnlock ? "Enter your password to continue" : "Sign in to your account"}
				</p>
			</div>

			<Card className="p-6">
				{isQuickUnlock && (
					<div className="mb-6 rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-900 dark:bg-blue-950/30">
						<p className="font-medium text-blue-900 text-sm dark:text-blue-100">🔓 Quick Unlock Available</p>
						<p className="mt-1 text-blue-700 text-sm dark:text-blue-300">
							Enter your password to unlock your vault. Secret Key is stored
							securely on this device.
						</p>
					</div>
				)}

				{sessionExpired && (
					<div className="mb-6 rounded-lg border border-yellow-200 bg-yellow-50 p-4 dark:border-yellow-900 dark:bg-yellow-950/30">
						<p className="font-medium text-sm text-yellow-900 dark:text-yellow-100">⏱️ Session Expired</p>
						<p className="mt-1 text-sm text-yellow-700 dark:text-yellow-300">
							Your 14-day quick unlock period has ended. Please enter your
							Secret Key to sign in.
						</p>
					</div>
				)}

				<form
					onSubmit={(e) => {
						e.preventDefault();
						e.stopPropagation();
						form.handleSubmit();
					}}
					className="space-y-4"
				>
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
										onBlur={(e) => {
											field.handleBlur();
											handleEmailBlur(e.target.value);
										}}
										onChange={(e) => field.handleChange(e.target.value)}
										required
										disabled={isQuickUnlock}
									/>
								</div>
							)}
						</form.Field>
					</div>

					{secretKeyHint && !isQuickUnlock && (
						<div className="rounded-lg border bg-muted/50 p-3">
							<p className="text-muted-foreground text-xs">
								Secret Key hint
							</p>
							<p className="mt-1 font-mono text-sm">{secretKeyHint}</p>
						</div>
					)}

					{!isQuickUnlock && (
						<div>
							<form.Field name="secretKey">
								{(field) => (
									<div className="space-y-2">
										<Label htmlFor={field.name}>Secret Key</Label>
										<div className="flex gap-2">
											<Input
												id={field.name}
												name={field.name}
												type={showSecretKey ? "text" : "password"}
												value={field.state.value}
												onBlur={field.handleBlur}
												onChange={(e) => field.handleChange(e.target.value)}
												placeholder="A3-XXXXXX-XXXXXX-XXXXX-XXXXX-XXXXX"
												required
												className="flex-1 font-mono"
											/>
											<Button
												type="button"
												variant="outline"
												size="icon"
												onClick={() => setShowSecretKey(!showSecretKey)}
											>
												{showSecretKey ? (
													<EyeOff size={18} />
												) : (
													<Eye size={18} />
												)}
											</Button>
										</div>
									</div>
								)}
							</form.Field>
						</div>
					)}

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
											{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
										</Button>
									</div>
								</div>
							)}
						</form.Field>
					</div>

					<Button
						type="submit"
						className="w-full"
						disabled={loginMutation.isPending}
					>
						{loginMutation.isPending
							? "Signing In..."
							: isQuickUnlock
								? "Unlock"
								: "Sign In"}
					</Button>

					{isQuickUnlock && (
						<button
							type="button"
							onClick={() => {
								setIsQuickUnlock(false);
								form.setFieldValue("email", "");
								form.setFieldValue("secretKey", "");
							}}
							className="w-full text-muted-foreground text-sm hover:text-foreground"
						>
							Sign in with different account
						</button>
					)}

					{!isQuickUnlock && (
						<button
							type="button"
							onClick={onSwitchToSignUp}
							className="w-full text-muted-foreground text-sm hover:text-foreground"
						>
							Don't have an account? Sign up
						</button>
					)}
				</form>
			</Card>
		</div>
	);
}
