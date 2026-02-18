import { useCheckEmail, useSessionState } from "@bittery/core/hooks";
import { performSRPLogin, storeLoginSession } from "@bittery/core/hooks/auth";
import { normalizeServerUrl } from "@bittery/shared/server-url";
import { useTRPC, useTRPCClient } from "@bittery/shared/trpc";
import { DEFAULT_SESSION_EXPIRY_MS } from "@bittery/storage";
import { Button, Card, Input, Label, toast } from "@bittery/ui";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { storage } from "@/lib/storage";
import { WorkerCrypto } from "@/lib/worker-crypto";

export default function SignInForm({
	onSwitchToSignUp,
	redirectTo,
}: {
	onSwitchToSignUp: () => void;
	redirectTo?: string;
}) {
	const navigate = useNavigate();
	const defaultServerUrl = import.meta.env.VITE_SERVER_URL ?? "";
	const [email, setEmail] = useState("");
	const [serverUrl, setServerUrl] = useState(defaultServerUrl);
	const [showPassword, setShowPassword] = useState(false);
	const [showSecretKey, setShowSecretKey] = useState(false);
	const [sessionExpired, setSessionExpired] = useState(false);
	const trpc = useTRPC();

	// Load server URL on mount
	useEffect(() => {
		storage.getServerUrl().then((url) => {
			if (url) setServerUrl(url);
		});
	}, []);

	// Check session state for quick unlock
	const { data: sessionState, isLoading: isLoadingSession } = useSessionState();

	// Check email for secret key hint
	const { data: emailCheck } = useCheckEmail(email);

	const trpcClient = useTRPCClient();
	const registrationStatusQuery = useQuery(
		trpc.auth.registrationStatus.queryOptions(),
	);
	const allowPublicSignup =
		registrationStatusQuery.data?.allowPublicSignup ?? true;
	const hasInvitationRedirect = !!redirectTo?.startsWith("/invite/");
	const canShowSignup = allowPublicSignup || hasInvitationRedirect;

	// Login mutation using WorkerCrypto to keep the main thread responsive
	const loginMutation = useMutation({
		mutationFn: async (input: {
			email: string;
			password: string;
			secretKey: string;
		}) => {
			const workerCrypto = new WorkerCrypto();
			try {
				const result = await performSRPLogin(input, {
					crypto: workerCrypto,
					trpcClient,
					storage,
				});
				await storeLoginSession(result, input.secretKey, storage, input.email);
				return result;
			} finally {
				workerCrypto.terminate();
			}
		},
		onSuccess: () => {
			const daysUntil = Math.floor(
				DEFAULT_SESSION_EXPIRY_MS / (1000 * 60 * 60 * 24),
			);
			toast.success(
				`Signed in successfully! Quick unlock available for ${daysUntil} days.`,
			);
			if (redirectTo) {
				navigate({ to: redirectTo });
			} else {
				navigate({ to: "/home" });
			}
		},
		onError: (error: Error) => {
			toast.error(error.message || "Failed to sign in");
		},
	});

	// Determine if quick unlock is available
	const isQuickUnlock = Boolean(
		sessionState?.canQuickUnlock && sessionState?.email,
	);

	// Handle session expiration detection
	useEffect(() => {
		if (!isLoadingSession && sessionState) {
			// If we have stored data but session is invalid, show expired message
			if (sessionState.email && !sessionState.isValid) {
				setSessionExpired(true);
				toast.info("Session expired. Please sign in again.");
			}
		}
	}, [isLoadingSession, sessionState]);

	const persistServerUrl = async () => {
		const normalized = normalizeServerUrl(serverUrl);
		if (!normalized) {
			toast.error("Invalid server URL");
			return null;
		}
		await storage.storeServerUrl(normalized);
		if (normalized !== serverUrl) {
			setServerUrl(normalized);
		}
		return normalized;
	};

	const form = useForm({
		defaultValues: {
			email: "",
			password: "",
			secretKey: "",
		},
		onSubmit: async ({ value }) => {
			if (!(await persistServerUrl())) {
				return;
			}
			await loginMutation.mutateAsync(value);
		},
	});

	// Pre-populate form when quick unlock is available
	useEffect(() => {
		if (isQuickUnlock && sessionState?.email) {
			setEmail(sessionState.email);
			form.setFieldValue("email", sessionState.email);
			// Get stored secret key for quick unlock
			storage.getStoredSecretKey(sessionState.email).then((secretKey) => {
				if (secretKey) {
					form.setFieldValue("secretKey", secretKey);
				}
			});
		}
	}, [isQuickUnlock, sessionState?.email, form.setFieldValue]);

	const handleEmailBlur = async (newEmail: string) => {
		if (newEmail?.includes("@")) {
			if (!(await persistServerUrl())) {
				return;
			}
			setEmail(newEmail);
		}
	};

	return (
		<div className="w-full">
			<h1 className="mb-4 text-center font-semibold text-2xl tracking-tight">
				{isQuickUnlock ? "Welcome back" : "Sign in to your account"}
			</h1>
			<Card className="border bg-card p-6 shadow-sm">
				{sessionExpired && (
					<div className="mb-6 rounded-lg border border-yellow-200 bg-yellow-50 p-4 dark:border-yellow-900 dark:bg-yellow-950/30">
						<div className="flex gap-3">
							<div className="text-xl">&#9203;</div>
							<div>
								<p className="font-medium text-sm text-yellow-900 dark:text-yellow-100">
									Session Expired
								</p>
								<p className="mt-1 text-xs text-yellow-700 dark:text-yellow-300">
									Your 14-day quick unlock period has ended. Please enter your
									Secret Key to sign in.
								</p>
							</div>
						</div>
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
						<div className="space-y-2">
							<Label htmlFor="serverUrl">Server URL</Label>
							<Input
								id="serverUrl"
								name="serverUrl"
								type="url"
								placeholder="https://your-server.com"
								value={serverUrl}
								onBlur={() => persistServerUrl()}
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
						<form.Field name="email">
							{(field) => (
								<div className="space-y-2">
									<Label htmlFor={field.name}>Email</Label>
									<Input
										id={field.name}
										name={field.name}
										type="email"
										placeholder="name@example.com"
										value={field.state.value}
										onBlur={(e) => {
											field.handleBlur();
											handleEmailBlur(e.target.value);
										}}
										onChange={(e) => field.handleChange(e.target.value)}
										required
										disabled={isQuickUnlock}
										className="h-10"
									/>
								</div>
							)}
						</form.Field>
					</div>

					{emailCheck?.secretKeyHint && !isQuickUnlock && (
						<div className="rounded-md bg-muted px-3 py-2 text-muted-foreground text-xs">
							<span className="font-medium">Hint:</span>{" "}
							{emailCheck.secretKeyHint}
						</div>
					)}

					{!isQuickUnlock && (
						<div>
							<form.Field name="secretKey">
								{(field) => (
									<div className="space-y-2">
										<Label htmlFor={field.name}>Secret Key</Label>
										<div className="relative">
											<Input
												id={field.name}
												name={field.name}
												type={showSecretKey ? "text" : "password"}
												value={field.state.value}
												onBlur={field.handleBlur}
												onChange={(e) => field.handleChange(e.target.value)}
												placeholder="A3-XXXXXX-XXXXXX-XXXXX-XXXXX-XXXXX"
												required
												className="h-10 pr-10 font-mono"
											/>
											<Button
												type="button"
												variant="ghost"
												size="icon"
												className="absolute top-0 right-0 h-10 w-10 text-muted-foreground hover:text-foreground"
												onClick={() => setShowSecretKey(!showSecretKey)}
											>
												{showSecretKey ? (
													<EyeOff size={16} />
												) : (
													<Eye size={16} />
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
									<div className="flex items-center justify-between">
										<Label htmlFor={field.name}>Password</Label>
										{!isQuickUnlock && (
											<button
												type="button"
												onClick={() => navigate({ to: "/recover" })}
												className="text-muted-foreground text-xs underline-offset-4 hover:text-foreground hover:underline"
											>
												Forgot Password?
											</button>
										)}
									</div>
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
								</div>
							)}
						</form.Field>
					</div>

					<Button
						type="submit"
						className="h-10 w-full font-medium"
						disabled={loginMutation.isPending}
					>
						{loginMutation.isPending ? (
							<>
								<Loader2 size={16} className="mr-2 animate-spin" />
								Signing in...
							</>
						) : isQuickUnlock ? (
							"Unlock Vault"
						) : (
							"Sign In"
						)}
					</Button>

					{isQuickUnlock && (
						<>
							<Button
								type="button"
								variant="link"
								onClick={async () => {
									// Clear session data from storage
									await storage.clearSession();
									// Clear form values
									form.setFieldValue("email", "");
									form.setFieldValue("secretKey", "");
									setEmail("");
									setSessionExpired(false);
									// Force refresh session state
									window.location.reload();
								}}
								className="w-full text-muted-foreground"
							>
								Sign in with a different account
							</Button>
							{canShowSignup && (
								<div className="mt-2 text-center text-muted-foreground text-sm">
									Need a different account?{" "}
									<button
										type="button"
										onClick={onSwitchToSignUp}
										className="font-medium text-primary underline-offset-4 hover:underline"
									>
										Create another account
									</button>
								</div>
							)}
						</>
					)}

					{!isQuickUnlock &&
						(canShowSignup ? (
							<div className="mt-4 text-center text-muted-foreground text-sm">
								Don&apos;t have an account?{" "}
								<button
									type="button"
									onClick={onSwitchToSignUp}
									className="font-medium text-primary underline-offset-4 hover:underline"
								>
									Sign up
								</button>
							</div>
						) : (
							<div className="mt-4 text-center text-muted-foreground text-sm">
								Registration is disabled on this server.
							</div>
						))}
				</form>
			</Card>
		</div>
	);
}
