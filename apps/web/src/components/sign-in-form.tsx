import { RuntimeRequestError } from "@bittery/client-runtime/client";
import {
	useRuntimeClient,
	useRuntimeSession,
} from "@bittery/client-runtime/react";
import { useSessionState } from "@bittery/core/hooks";
import {
	createApiClientForServer,
	getDefaultServerUrl,
} from "@bittery/shared/api-client-factory";
import { apiQueryKeys } from "@bittery/shared/api-query";
import { isRemoteHttpServer } from "@bittery/shared/server-transport-policy";
import { Button, Checkbox, Input, Label, toast } from "@bittery/ui";
import {
	IconClock as Clock,
	IconEye as Eye,
	IconEyeOff as EyeOff,
	IconLoaderCircle as Loader2,
} from "@bittery/ui/icons";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import {
	gateLocalTeardown,
	gateRuntimeAuthentication,
} from "@/lib/account-deletion";
import {
	type AccountRemovalArea,
	forgetBrowserSessionOnly,
	retireAccountSession,
	retryCannotFinish,
	type SessionRetirementDeps,
	type SessionRetirementIncomplete,
	type SessionRetirementResult,
} from "@/lib/account-removal";
import {
	forgetAccountSession,
	getTransitionalAccountId,
	readAccountDeletionMarker,
	storage,
	writeAccountDeletionMarker,
} from "@/lib/storage";
import { getTeardownAreaLabel } from "@/lib/teardown-areas";
import { useAccountRuntime } from "@/providers/account-runtime-provider";
import { useI18n } from "@/providers/i18n-provider";

/** Retiring the Session, or the browser-only escape. Never the same thing. */
type RetirementAction = "retire" | "forgetBrowserSession";

/** Idle, running one of the two gestures, or holding what did not finish. */
type RetirementState =
	| { readonly phase: "idle" }
	| {
			readonly phase: "running";
			readonly action: RetirementAction;
			/** Held while it runs, so the offer it came from stays on screen. */
			readonly previous: SessionRetirementIncomplete | null;
	  }
	| {
			readonly phase: "incomplete";
			readonly result: SessionRetirementIncomplete;
	  };

const RETIREMENT_IDLE: RetirementState = { phase: "idle" };

export default function SignInForm({
	onSwitchToSignUp,
	redirectTo,
}: {
	onSwitchToSignUp: () => void;
	redirectTo?: string;
}) {
	const { m } = useI18n();
	const { data: sessionState, isLoading: isLoadingSession } = useSessionState();
	// The Runtime owns Quick Unlock now, so it decides whether this Device can offer one.
	// The transitional session store still supplies the email to show and the Secret Key to
	// prefill; neither is needed to unlock, only to render.
	const runtimeSession = useRuntimeSession();
	const serverUrl = getDefaultServerUrl();
	const requiresInsecureTransportConfirmation = isRemoteHttpServer(serverUrl);
	const [insecureTransportConfirmed, setInsecureTransportConfirmed] =
		useState(false);
	const ceremonyApiClient = useMemo(
		() =>
			createApiClientForServer(serverUrl, undefined, {
				insecureTransportConfirmed,
				clientPlatform: "web",
			}),
		[insecureTransportConfirmed, serverUrl],
	);
	const isQuickUnlock =
		runtimeSession.state === "locked" ||
		Boolean(
			sessionState?.canQuickUnlock &&
				sessionState.accountId &&
				sessionState.email,
		);
	const storedSecretKeyQuery = useQuery({
		queryKey: ["auth", "stored-secret-key", sessionState?.accountId],
		enabled: isQuickUnlock && !!sessionState?.accountId,
		queryFn: () =>
			storage.getStoredSecretKey(sessionState?.accountId ?? undefined),
	});
	const registrationStatusQuery = useQuery({
		queryKey: [
			...apiQueryKeys.auth.registrationStatus,
			serverUrl,
			insecureTransportConfirmed,
		],
		queryFn: async () =>
			(await ceremonyApiClient.auth.registrationStatus()).data,
		enabled:
			!requiresInsecureTransportConfirmation || insecureTransportConfirmed,
	});
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
					quickUnlockAccountId={
						runtimeSession.accountId ?? sessionState?.accountId ?? undefined
					}
					isCloudMode={isCloudMode}
					canShowSignup={canShowSignup}
					hasInvitationRedirect={hasInvitationRedirect}
					serverUrl={serverUrl}
					requiresInsecureTransportConfirmation={
						requiresInsecureTransportConfirmation
					}
					insecureTransportConfirmed={insecureTransportConfirmed}
					setInsecureTransportConfirmed={setInsecureTransportConfirmed}
					ceremonyApiClient={ceremonyApiClient}
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
	quickUnlockAccountId,
	isCloudMode,
	canShowSignup,
	hasInvitationRedirect,
	serverUrl,
	requiresInsecureTransportConfirmation,
	insecureTransportConfirmed,
	setInsecureTransportConfirmed,
	ceremonyApiClient,
	onSwitchToSignUp,
	redirectTo,
}: {
	initialEmail: string;
	initialSecretKey: string;
	isQuickUnlock: boolean;
	quickUnlockAccountId?: string;
	isCloudMode: boolean;
	canShowSignup: boolean;
	hasInvitationRedirect: boolean;
	serverUrl: string;
	requiresInsecureTransportConfirmation: boolean;
	insecureTransportConfirmed: boolean;
	setInsecureTransportConfirmed: (confirmed: boolean) => void;
	ceremonyApiClient: ReturnType<typeof createApiClientForServer>;
	onSwitchToSignUp: () => void;
	redirectTo?: string;
}) {
	const { manager } = useAccountRuntime();
	const runtimeClient = useRuntimeClient();
	const { m } = useI18n();
	// `isQuickUnlock` is computed by the parent from `useSessionState`. The query lives in
	// the same cache, so invalidating it here is what re-renders the parent.
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const [email, setEmail] = useState(initialEmail);
	const [showPassword, setShowPassword] = useState(false);
	const [showSecretKey, setShowSecretKey] = useState(false);
	const [retirement, setRetirement] =
		useState<RetirementState>(RETIREMENT_IDLE);
	const [browserSessionForgotten, setBrowserSessionForgotten] = useState(false);
	// The browser-only terminal outcome is authoritative for this form even when a
	// closed/wedged Runtime can no longer publish a fresh Session projection.
	const quickUnlockActive = isQuickUnlock && !browserSessionForgotten;
	const assertRuntimeAuthenticationAllowed = () => {
		if (
			gateRuntimeAuthentication({
				readMarker: readAccountDeletionMarker,
				writeMarker: writeAccountDeletionMarker,
			}) === "recoveryRequired"
		) {
			throw new RuntimeRequestError(
				"AUTHENTICATION_UNAVAILABLE",
				"Account deletion recovery must finish before authentication.",
			);
		}
	};

	// The last report, held across attempts. Both names were resolved at the first press,
	// and re-resolving is unsafe: a half-failed sweep leaves the transitional store with an
	// empty pointer, which the next attempt would read as nothing to do.
	const lastIncompleteReport = useRef<SessionRetirementIncomplete | null>(null);

	// "Use a different account" retires the Session. It does not remove the Account.
	// This screen runs before anybody proved they own it, so the irreversible request
	// belongs to the sidebar's "Log out", behind an unlocked vault and a confirmation.
	// `SessionRetirementDeps` carries no `removeAccount`, so that stays a type error.
	const retirementDeps: SessionRetirementDeps = {
		// The Account this form offers wins over any stored pointer, exactly as it does
		// for the unlock above.
		resolveRuntimeAccountId: () =>
			runtimeClient.resolveAccount(quickUnlockAccountId),
		resolveTransitionalAccountId: getTransitionalAccountId,
		signOutRuntimeAccount: async (accountId: string) => {
			const transitionalAccountId = await getTransitionalAccountId();
			if (
				transitionalAccountId !== null &&
				gateLocalTeardown(
					{ runtimeAccountId: accountId, transitionalAccountId },
					{
						readMarker: readAccountDeletionMarker,
						writeMarker: writeAccountDeletionMarker,
					},
				) === "recoveryRequired"
			) {
				throw new RuntimeRequestError(
					"AUTHENTICATION_UNAVAILABLE",
					"Account deletion recovery must finish before sign-out.",
				);
			}
			await runtimeClient.signOut(accountId);
		},
		forgetTransitionalSession: (accountId: string) =>
			forgetAccountSession(accountId, () => manager.refresh()),
		selectAccount: (accountId: string | null) =>
			runtimeClient.selectAccount(accountId),
	};

	const namedAreas = (areas: readonly AccountRemovalArea[]) =>
		areas.map((area) => getTeardownAreaLabel(area, m)).join(", ");

	const runRetirement = async (
		action: RetirementAction,
		previous: SessionRetirementIncomplete | null,
		run: () => Promise<SessionRetirementResult>,
	) => {
		setRetirement({ phase: "running", action, previous });
		const result = await run();
		if (result.status === "retired") {
			lastIncompleteReport.current = null;
			// The success effect, and only here. A reload rebuilds the screen from stores
			// that have let go; running it over a failed retirement would show the same
			// offer again and call that a switch.
			window.location.reload();
			return;
		}
		if (result.status === "browserSessionForgotten") {
			// No reload: nothing was retired, so there is nothing to rebuild from. But the
			// Quick Unlock offer this screen renders comes from a cached `useSessionState`
			// query, and the escape refreshes no query on its own. Without this the Secret
			// Key really is gone and the email field stays disabled — the dead end the
			// escape exists to break. The other half of `isQuickUnlock`,
			// `runtimeSession.state === "locked"`, cannot hold here: every refusal this
			// escape follows is a Device that is closed or not ready, and `deriveSession`
			// reads closed as `unavailable`. So the field re-enables in this page load.
			setBrowserSessionForgotten(true);
			await queryClient.invalidateQueries({
				queryKey: ["auth", "sessionState"],
			});
			// The report is kept: it still names the Account, and the Runtime still holds it.
			setRetirement(RETIREMENT_IDLE);
			toast.warning(m.auth_signin_different_account_forgotten(), {
				description: m.auth_signin_different_account_forgotten_areas({
					areas: namedAreas(result.areas),
				}),
			});
			return;
		}
		lastIncompleteReport.current = result;
		setRetirement({ phase: "incomplete", result });
		const areas = namedAreas(result.areas);
		toast.error(
			// A retry that cannot finish is never offered as one: an empty transitional
			// pointer is refused for the rest of this page load.
			retryCannotFinish(result)
				? m.auth_signin_different_account_stranded()
				: m.auth_signin_different_account_incomplete(),
			{
				description:
					areas.length > 0
						? m.auth_signin_different_account_incomplete_areas({ areas })
						: undefined,
			},
		);
	};

	// A retry hands the previous report back, so both names are the ones the first attempt
	// resolved. A closed toast is only a closed toast, so the held report drives this too.
	const handleUseDifferentAccount = () => {
		const previous = lastIncompleteReport.current;
		return runRetirement("retire", previous, () =>
			retireAccountSession(previous, retirementDeps),
		);
	};

	// The escape: forget what this browser stored, and nothing else. It appears only after
	// repeated refusals, because a wedged Runtime refuses `SignOut` forever and this screen
	// is otherwise a dead end — the email field stays disabled while the Quick Unlock
	// inputs are still here, so the user cannot sign in as anybody else in this browser.
	const handleForgetBrowserSession = () => {
		const previous = lastIncompleteReport.current;
		if (previous === null) {
			return;
		}
		return runRetirement("forgetBrowserSession", previous, () =>
			forgetBrowserSessionOnly(previous, retirementDeps),
		);
	};

	const busy = retirement.phase === "running";
	// The held report, while it is held and while the next attempt runs, so the offer it
	// carries does not blink out from under the button the user just pressed.
	const heldReport =
		retirement.phase === "incomplete"
			? retirement.result
			: retirement.phase === "running"
				? retirement.previous
				: null;
	const canForgetBrowserSession =
		heldReport?.canForgetBrowserSessionOnly === true;
	// An empty transitional pointer is refused for the rest of this page load, so the retry
	// is withdrawn rather than left there to fail again. The toast already said as much.
	const stranded = heldReport !== null && retryCannotFinish(heldReport);
	const { data: emailCheck } = useQuery({
		queryKey: [
			"api",
			"v1",
			"auth",
			"email-checks",
			email,
			serverUrl,
			insecureTransportConfirmed,
		],
		queryFn: async () =>
			(await ceremonyApiClient.auth.checkEmail({ email })).data,
		enabled:
			!quickUnlockActive &&
			email.includes("@") &&
			(!requiresInsecureTransportConfirmation || insecureTransportConfirmed),
		staleTime: 60 * 1000,
		retry: false,
	});

	const loginMutation = useMutation({
		mutationFn: async (input: {
			email: string;
			password: string;
			secretKey: string;
		}) => {
			if (quickUnlockActive) {
				assertRuntimeAuthenticationAllowed();
				// The Account this form is offering wins over any stored pointer, and the
				// client refuses one the Runtime's catalog no longer recognises. Preferring
				// the stored id unlocked the wrong Account with the right password.
				const accountId = runtimeClient.resolveAccount(quickUnlockAccountId);
				if (!accountId) {
					throw new Error(m.toast_auth_unlock_error_failed());
				}
				const signedIn = await runtimeClient.quickUnlock({
					accountId,
					masterPassword: input.password,
				});
				await manager.refresh();
				return signedIn;
			}
			const normalizedEmail = input.email.trim().toLowerCase();
			assertRuntimeAuthenticationAllowed();
			if (
				requiresInsecureTransportConfirmation &&
				!insecureTransportConfirmed
			) {
				throw new Error(m.auth_insecure_http_confirmation_required());
			}
			const signedIn = await runtimeClient.signIn({
				serverUrl,
				email: normalizedEmail,
				masterPassword: input.password,
				secretKey: input.secretKey,
				insecureTransportConfirmed,
			});
			await manager.refresh();
			return signedIn;
		},
		onSuccess: () => {
			toast.success(m.toast_auth_signin_success());
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
			setEmail(newEmail.trim().toLowerCase());
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
			data-testid="signin-form"
			data-teardown-status={
				browserSessionForgotten ? "browserSessionForgotten" : undefined
			}
		>
			{/* A Quick Unlock the Runtime offers needs the Account id and a password, not an
			    email. The field stays only while there is a known address to show. */}
			<div hidden={quickUnlockActive && initialEmail === ""}>
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
								disabled={quickUnlockActive}
								className="h-10"
							/>
						</div>
					)}
				</form.Field>
			</div>

			{emailCheck?.secretKeyHint && !quickUnlockActive && (
				<div className="rounded-md bg-muted px-3 py-2 text-muted-foreground text-xs">
					<span className="font-medium">{m.auth_signin_hint()}:</span>{" "}
					{emailCheck.secretKeyHint}
				</div>
			)}

			{!quickUnlockActive && (
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
								{!quickUnlockActive && (
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

			{requiresInsecureTransportConfirmation ? (
				<Label
					htmlFor="insecure-http-confirmation"
					className="flex cursor-pointer items-start gap-2.5 rounded-md border bg-foreground/3 px-3 py-2.5 font-normal transition-colors hover:bg-foreground/5"
				>
					<Checkbox
						id="insecure-http-confirmation"
						checked={insecureTransportConfirmed}
						onCheckedChange={(checked) =>
							setInsecureTransportConfirmed(checked === true)
						}
					/>
					<span className="grid gap-0.5">
						<span>{m.auth_insecure_http_confirmation_label()}</span>
						<span className="text-muted-foreground text-xs">
							{m.auth_insecure_http_confirmation_description()}
						</span>
					</span>
				</Label>
			) : null}

			<Button
				type="submit"
				className="h-10 w-full font-medium"
				disabled={loginMutation.isPending}
				data-testid="signin-submit-button"
			>
				{loginMutation.isPending ? (
					<>
						<Loader2 size={16} className="mr-2 animate-spin" />
						{m.auth_signin_button_signing_in()}
					</>
				) : quickUnlockActive ? (
					m.auth_signin_button_unlock_vault()
				) : (
					m.auth_signin_button_sign_in()
				)}
			</Button>

			{quickUnlockActive && (
				<>
					{stranded ? null : (
						<Button
							type="button"
							variant="link"
							disabled={busy}
							onClick={() => {
								void handleUseDifferentAccount();
							}}
							className="w-full text-muted-foreground"
							data-testid="use-different-account"
						>
							{retirement.phase === "running" && retirement.action === "retire"
								? m.auth_signin_button_different_account_busy()
								: m.auth_signin_button_different_account()}
						</Button>
					)}
					{canForgetBrowserSession ? (
						// Offered only after repeated refusals, and it says what it leaves
						// behind. The Account stays installed and the Runtime keeps access
						// to it; all this drops is what this browser stored.
						<div className="space-y-2 rounded-md border border-border/60 p-3">
							<p className="text-muted-foreground text-sm">
								{m.auth_signin_different_account_escape_hint()}
							</p>
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={busy}
								onClick={() => {
									void handleForgetBrowserSession();
								}}
								data-testid="use-different-account-escape"
							>
								{retirement.phase === "running" &&
								retirement.action === "forgetBrowserSession"
									? m.auth_signin_different_account_escape_busy()
									: m.auth_signin_different_account_escape()}
							</Button>
						</div>
					) : null}
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

			{!quickUnlockActive &&
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
