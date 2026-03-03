import { useCheckEmail, useSessionState } from "@bittery/core/hooks";
import { performSRPLogin, storeLoginSession } from "@bittery/core/hooks/auth";
import { useTRPC, useTRPCClient } from "@bittery/shared/trpc";
import { DEFAULT_SESSION_EXPIRY_MS } from "@bittery/storage";
import { Button, Input, Label, toast } from "@bittery/ui";
import {
	IconEyeOutlineDuo18 as Eye,
	IconEyeSlashOutlineDuo18 as EyeOff,
	IconLoader2OutlineDuo18 as Loader2,
} from "@bittery/ui/icons";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { storage } from "@/lib/storage";
import { WorkerCrypto } from "@/lib/worker-crypto";
import { useI18n } from "@/providers/i18n-provider";

export default function SignInForm({
	onSwitchToSignUp,
	redirectTo,
}: {
	onSwitchToSignUp: () => void;
	redirectTo?: string;
}) {
	const { m } = useI18n();
	const navigate = useNavigate();
	const [email, setEmail] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [showSecretKey, setShowSecretKey] = useState(false);
	const [sessionExpired, setSessionExpired] = useState(false);
	const trpc = useTRPC();

	// Check session state for quick unlock
	const { data: sessionState, isLoading: isLoadingSession } = useSessionState();

	// Check email for secret key hint
	const { data: emailCheck } = useCheckEmail(email);

	const trpcClient = useTRPCClient();
	const registrationStatusQuery = useQuery(
		trpc.auth.registrationStatus.queryOptions(),
	);
	const isCloudMode = registrationStatusQuery.data?.mode !== "self-hosted";
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
			toast.success(m["toast.auth.signin_success"]({ daysUntil }));
			if (redirectTo) {
				navigate({ to: redirectTo });
			} else {
				navigate({ to: "/home" });
			}
		},
		onError: (error: Error) => {
			toast.error(error.message || m["toast.auth.signin_error"]());
		},
	});

	// Determine if quick unlock is available
	const isQuickUnlock = Boolean(
		sessionState?.canQuickUnlock && sessionState?.email,
	);
	const signInTitle = isQuickUnlock
		? m["auth.signin.title.quick_unlock"]()
		: m["auth.signin.title.default"]();
	const signInDescription = isQuickUnlock
		? m["auth.signin.description.quick_unlock"]()
		: m["auth.signin.description.default"]();

	// Handle session expiration detection
	useEffect(() => {
		if (!isLoadingSession && sessionState) {
			// If we have stored data but session is invalid, show expired message
			if (sessionState.email && !sessionState.isValid) {
				setSessionExpired(true);
				toast.info(m["toast.auth.session_expired"]());
			}
		}
	}, [isLoadingSession, sessionState]);

	const form = useForm({
		defaultValues: {
			email: "",
			password: "",
			secretKey: "",
		},
		onSubmit: async ({ value }) => {
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
			setEmail(newEmail);
		}
	};

	const renderCloudSignupPrompt = () => (
		<>
			{m["auth.signin.signup.cloud_prefix"]()}{" "}
			<button
				type="button"
				onClick={onSwitchToSignUp}
				className="font-medium text-primary underline-offset-4 hover:underline"
			>
				{hasInvitationRedirect
					? m["auth.signin.signup.cloud_create_account"]()
					: m["auth.signin.signup.cloud_get_started"]()}
			</button>
		</>
	);

	const renderSelfHostedSignupPrompt = () => (
		<>
			{m["auth.signin.signup.self_hosted_prefix"]()}{" "}
			<button
				type="button"
				onClick={onSwitchToSignUp}
				className="font-medium text-primary underline-offset-4 hover:underline"
			>
				{m["auth.signin.signup.self_hosted_button"]()}
			</button>
		</>
	);

	return (
		<div className="w-full">
			<h1 className="text-center font-semibold text-2xl tracking-tight">
				{signInTitle}
			</h1>
			<p className="mx-auto mt-2 max-w-80 text-center text-muted-foreground text-sm">
				{signInDescription}
			</p>
			<div className="mt-6">
				{sessionExpired && (
					<div className="mb-6 rounded-lg border border-yellow-200 bg-yellow-50 p-4 dark:border-yellow-900 dark:bg-yellow-950/30">
						<div className="flex gap-3">
							<div className="text-xl">&#9203;</div>
							<div>
								<p className="font-medium text-sm text-yellow-900 dark:text-yellow-100">
									{m["auth.signin.session_expired.title"]()}
								</p>
								<p className="mt-1 text-xs text-yellow-700 dark:text-yellow-300">
									{m["auth.signin.session_expired.description"]()}
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
						<form.Field name="email">
							{(field) => (
								<div className="space-y-2">
									<Label htmlFor={field.name}>
										{m["auth.signin.label.email"]()}
									</Label>
									<Input
										id={field.name}
										name={field.name}
										type="email"
										placeholder={m["auth.signin.placeholder.email"]()}
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
							<span className="font-medium">{m["auth.signin.hint"]()}:</span>{" "}
							{emailCheck.secretKeyHint}
						</div>
					)}

					{!isQuickUnlock && (
						<div>
							<form.Field name="secretKey">
								{(field) => (
								<div className="space-y-2">
									<Label htmlFor={field.name}>
										{m["auth.signin.label.secret_key"]()}
									</Label>
									<div className="relative">
											<Input
												id={field.name}
												name={field.name}
												type={showSecretKey ? "text" : "password"}
												value={field.state.value}
												onBlur={field.handleBlur}
												onChange={(e) => field.handleChange(e.target.value)}
												placeholder={m["auth.signin.placeholder.secret_key"]()}
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
										<Label htmlFor={field.name}>
											{m["auth.signin.label.password"]()}
										</Label>
										{!isQuickUnlock && (
											<button
												type="button"
												onClick={() => navigate({ to: "/recover" })}
											className="text-muted-foreground text-xs underline-offset-4 hover:text-foreground hover:underline"
										>
											{m["auth.signin.forgot_password"]()}
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
											{showPassword ? (
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

					<Button
						type="submit"
						className="h-10 w-full font-medium"
						disabled={loginMutation.isPending}
					>
						{loginMutation.isPending ? (
							<>
								<Loader2 size={16} className="mr-2 animate-spin" />
								{m["auth.signin.button.signing_in"]()}
							</>
						) : isQuickUnlock ? (
							m["auth.signin.button.unlock_vault"]()
						) : (
							m["auth.signin.button.sign_in"]()
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
								{m["auth.signin.button.different_account"]()}
							</Button>
							{canShowSignup && (
								<div className="mt-2 text-center text-muted-foreground text-sm">
									{m["auth.signin.signup.need_different_account"]()}{" "}
									<button
										type="button"
										onClick={onSwitchToSignUp}
										className="font-medium text-primary underline-offset-4 hover:underline"
									>
										{m["auth.signin.signup.create_another_account"]()}
									</button>
								</div>
							)}
						</>
					)}

					{!isQuickUnlock &&
						(canShowSignup ? (
							<div className="mt-4 text-center text-muted-foreground text-sm">
								{isCloudMode
									? renderCloudSignupPrompt()
									: renderSelfHostedSignupPrompt()}
							</div>
						) : (
							<div className="mt-4 text-center text-muted-foreground text-sm">
								{m["auth.signin.signup.disabled"]()}
							</div>
						))}
				</form>
			</div>
		</div>
	);
}
