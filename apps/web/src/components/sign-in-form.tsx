import { useCheckEmail, useSessionState } from "@bittery/core/hooks";
import { performSRPLogin, storeLoginSession } from "@bittery/core/hooks/auth";
import { useRPC, useRPCClient } from "@bittery/shared/rpc";
import { getDefaultServerUrl } from "@bittery/shared/rpc-client-factory";
import { DEFAULT_SESSION_EXPIRY_MS } from "@bittery/storage";
import { Button, Input, Label, toast } from "@bittery/ui";
import {
	IconClock as Clock,
	IconEye as Eye,
	IconEyeOff as EyeOff,
	IconLoaderCircle as Loader2,
} from "@bittery/ui/icons";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { storage } from "@/lib/storage";
import * as wasmCrypto from "@/lib/wasm-crypto";
import { useI18n } from "@/providers/i18n-provider";

export default function SignInForm({
	onSwitchToSignUp,
	redirectTo,
}: {
	onSwitchToSignUp: () => void;
	redirectTo?: string;
}) {
	const { m } = useI18n();
	const rpc = useRPC();

	const { data: sessionState, isLoading: isLoadingSession } = useSessionState();
	const isQuickUnlock = Boolean(
		sessionState?.canQuickUnlock && sessionState?.email,
	);
	const storedSecretKeyQuery = useQuery({
		queryKey: ["auth", "stored-secret-key", sessionState?.email],
		enabled: isQuickUnlock && !!sessionState?.email,
		queryFn: () => storage.getStoredSecretKey(),
	});
	const registrationStatusQuery = useQuery(
		rpc.auth.registrationStatus.queryOptions(),
	);
	const isCloudMode = registrationStatusQuery.data?.mode !== "self-hosted";
	const allowPublicSignup =
		registrationStatusQuery.data?.allowPublicSignup ?? true;
	const hasInvitationRedirect = !!redirectTo?.startsWith("/invite/");
	const canShowSignup = allowPublicSignup || hasInvitationRedirect;
	const sessionExpired = Boolean(
		!isLoadingSession &&
			sessionState?.email &&
			!sessionState.canQuickUnlock &&
			sessionState.expiresAt &&
			Date.now() >= sessionState.expiresAt,
	);
	const signInTitle = isQuickUnlock
		? m.auth_signin_title_quick_unlock()
		: m.auth_signin_title_default();
	const signInDescription = isQuickUnlock
		? m.auth_signin_description_quick_unlock()
		: m.auth_signin_description_default();
	const initialEmail = isQuickUnlock ? (sessionState?.email ?? "") : "";
	const initialSecretKey = isQuickUnlock
		? (storedSecretKeyQuery.data ?? "")
		: "";

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
					<div className="mb-6 overflow-hidden rounded-2xl border border-amber-200/70 bg-[linear-gradient(135deg,rgba(255,251,235,0.96),rgba(255,255,255,0.98))] shadow-[0_18px_40px_-28px_rgba(146,64,14,0.55)]">
						<div className="h-px bg-[linear-gradient(90deg,rgba(217,119,6,0.8),rgba(251,191,36,0.15),transparent)]" />
						<div className="flex items-start gap-3 px-4 py-4 sm:px-5">
							<div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-amber-200/80 bg-white/85 text-amber-700 shadow-sm">
								<Clock className="size-4.5" />
							</div>
							<div className="min-w-0 flex-1 pt-0.5">
								<div className="flex flex-wrap items-center gap-2">
									<span className="inline-flex items-center rounded-full border border-amber-200/80 bg-amber-100/80 px-2.5 py-0.5 font-medium text-[11px] text-amber-800 uppercase tracking-[0.16em]">
										{m.auth_signin_session_expired_title()}
									</span>
								</div>
								<p className="mt-2 max-w-prose text-[13px] text-amber-900/90 leading-6 sm:text-sm">
									{m.auth_signin_session_expired_description()}
								</p>
							</div>
						</div>
					</div>
				)}

				<SignInFormContent
					key={`${initialEmail}:${initialSecretKey}:${isQuickUnlock ? "quick" : "default"}`}
					initialEmail={initialEmail}
					initialSecretKey={initialSecretKey}
					isQuickUnlock={isQuickUnlock}
					isCloudMode={isCloudMode}
					canShowSignup={canShowSignup}
					hasInvitationRedirect={hasInvitationRedirect}
					onSwitchToSignUp={onSwitchToSignUp}
					redirectTo={redirectTo}
				/>
			</div>
		</div>
	);
}

function SignInFormContent({
	initialEmail,
	initialSecretKey,
	isQuickUnlock,
	isCloudMode,
	canShowSignup,
	hasInvitationRedirect,
	onSwitchToSignUp,
	redirectTo,
}: {
	initialEmail: string;
	initialSecretKey: string;
	isQuickUnlock: boolean;
	isCloudMode: boolean;
	canShowSignup: boolean;
	hasInvitationRedirect: boolean;
	onSwitchToSignUp: () => void;
	redirectTo?: string;
}) {
	const { m } = useI18n();
	const navigate = useNavigate();
	const rpcClient = useRPCClient();
	const [email, setEmail] = useState(initialEmail);
	const [showPassword, setShowPassword] = useState(false);
	const [showSecretKey, setShowSecretKey] = useState(false);
	const { data: emailCheck } = useCheckEmail(email);

	const loginMutation = useMutation({
		mutationFn: async (input: {
			email: string;
			password: string;
			secretKey: string;
		}) => {
			const serverUrl = getDefaultServerUrl();
			const result = await performSRPLogin(
				{ ...input, serverUrl },
				{
					crypto: wasmCrypto,
					rpcClient,
					storage,
				},
			);
			await storeLoginSession(result, input.secretKey, storage, input.email, {
				serverUrl,
			});
			return result;
		},
		onSuccess: () => {
			const daysUntil = Math.floor(
				DEFAULT_SESSION_EXPIRY_MS / (1000 * 60 * 60 * 24),
			);
			toast.success(m.toast_auth_signin_success({ daysUntil }));
			if (redirectTo) {
				navigate({ to: redirectTo });
			} else {
				navigate({ to: "/home" });
			}
		},
		onError: (error: Error) => {
			toast.error(error.message || m.toast_auth_signin_error());
		},
	});

	const form = useForm({
		defaultValues: {
			email: initialEmail,
			password: "",
			secretKey: initialSecretKey,
		},
		onSubmit: async ({ value }) => {
			await loginMutation.mutateAsync(value);
		},
	});

	const handleEmailBlur = (newEmail: string) => {
		if (newEmail?.includes("@")) {
			setEmail(newEmail);
		}
	};

	const renderCloudSignupPrompt = () => (
		<>
			{m.auth_signin_signup_cloud_prefix()}{" "}
			<button
				type="button"
				onClick={onSwitchToSignUp}
				className="font-medium text-primary underline-offset-4 hover:underline"
			>
				{hasInvitationRedirect
					? m.auth_signin_signup_cloud_create_account()
					: m.auth_signin_signup_cloud_get_started()}
			</button>
		</>
	);

	const renderSelfHostedSignupPrompt = () => (
		<>
			{m.auth_signin_signup_self_hosted_prefix()}{" "}
			<button
				type="button"
				onClick={onSwitchToSignUp}
				className="font-medium text-primary underline-offset-4 hover:underline"
			>
				{m.auth_signin_signup_self_hosted_button()}
			</button>
		</>
	);

	return (
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
							<Label htmlFor={field.name}>{m.auth_signin_label_email()}</Label>
							<Input
								id={field.name}
								name={field.name}
								type="email"
								placeholder={m.auth_signin_placeholder_email()}
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
					<span className="font-medium">{m.auth_signin_hint()}:</span>{" "}
					{emailCheck.secretKeyHint}
				</div>
			)}

			{!isQuickUnlock && (
				<div>
					<form.Field name="secretKey">
						{(field) => (
							<div className="space-y-2">
								<Label htmlFor={field.name}>
									{m.auth_signin_label_secret_key()}
								</Label>
								<div className="relative">
									<Input
										id={field.name}
										name={field.name}
										type={showSecretKey ? "text" : "password"}
										value={field.state.value}
										onBlur={field.handleBlur}
										onChange={(e) => field.handleChange(e.target.value)}
										placeholder={m.auth_signin_placeholder_secret_key()}
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
										{showSecretKey ? <EyeOff size={16} /> : <Eye size={16} />}
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
									{m.auth_signin_label_password()}
								</Label>
								{!isQuickUnlock && (
									<button
										type="button"
										onClick={() => navigate({ to: "/recover" })}
										className="text-muted-foreground text-xs underline-offset-4 hover:text-foreground hover:underline"
									>
										{m.auth_signin_forgot_password()}
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
						{m.auth_signin_button_signing_in()}
					</>
				) : isQuickUnlock ? (
					m.auth_signin_button_unlock_vault()
				) : (
					m.auth_signin_button_sign_in()
				)}
			</Button>

			{isQuickUnlock && (
				<>
					<Button
						type="button"
						variant="link"
						onClick={async () => {
							await storage.clearSession();
							window.location.reload();
						}}
						className="w-full text-muted-foreground"
					>
						{m.auth_signin_button_different_account()}
					</Button>
					{canShowSignup && (
						<div className="mt-2 text-center text-muted-foreground text-sm">
							{m.auth_signin_signup_need_different_account()}{" "}
							<button
								type="button"
								onClick={onSwitchToSignUp}
								className="font-medium text-primary underline-offset-4 hover:underline"
							>
								{m.auth_signin_signup_create_another_account()}
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
						{isCloudMode
							? m.auth_signin_signup_disabled_cloud()
							: m.auth_signin_signup_disabled_self_hosted()}
					</div>
				))}
		</form>
	);
}
