import { useLogin } from "@bittery/core/hooks";
import { isRemoteHttpServer } from "@bittery/shared/server-transport-policy";
import { normalizeServerUrl } from "@bittery/shared/server-url";
import {
	Button,
	Checkbox,
	Input,
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
	Label,
	toast,
} from "@bittery/ui";
import { IconEye, IconEyeOff, IconFingerprint } from "@bittery/ui/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
	resolveActiveAuthServerUrl,
	setActiveAuthServerUrl,
	subscribeActiveAuthServerUrl,
} from "@/lib/auth-server";
import { storage } from "@/lib/storage";
import { useI18n } from "@/providers/i18n-provider";

interface LoginSearchParams {
	prefillEmail?: string;
}

export const Route = createFileRoute("/login")({
	beforeLoad: async ({ search, context }) => {
		const prefillEmail =
			typeof search.prefillEmail === "string" ? search.prefillEmail : undefined;
		if (prefillEmail) {
			return;
		}

		const accountsList = context.runtime.accounts.getAccounts();
		if (accountsList.length === 0) {
			return;
		}

		let activeAccount = context.runtime.accounts.getActiveAccount();
		if (!activeAccount) {
			const firstAccount = accountsList[0];
			if (!firstAccount) {
				return;
			}
			activeAccount = firstAccount.accountId;
			await context.runtime.accounts.switchAccount(activeAccount);
		}

		const sessionValid = await storage.isSessionValid(activeAccount);
		if (sessionValid) {
			const restored = await context.runtime.accounts.unlockAccount(
				activeAccount,
				true,
			);
			if (restored) {
				throw redirect({ to: "/vault" });
			}
		}

		throw redirect({ to: "/unlock" });
	},
	component: LoginPage,
	validateSearch: (search: Record<string, unknown>): LoginSearchParams => ({
		prefillEmail:
			typeof search.prefillEmail === "string" ? search.prefillEmail : undefined,
	}),
});

export function LoginPage() {
	const { m } = useI18n();
	const { prefillEmail } = Route.useSearch();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const fallbackServerUrl =
		normalizeServerUrl(import.meta.env.VITE_SERVER_URL ?? "") ??
		"http://localhost:3000";

	const [serverUrl, setServerUrl] = useState(fallbackServerUrl);
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [secretKey, setSecretKey] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [showSecretKey, setShowSecretKey] = useState(false);
	const [enableBiometric, setEnableBiometric] = useState(true);
	const [insecureTransportConfirmed, setInsecureTransportConfirmed] =
		useState(false);
	const [isPrefilled, setIsPrefilled] = useState(false);
	const requiresInsecureTransportConfirmation = isRemoteHttpServer(serverUrl);

	const { data: biometricAvailable } = useQuery({
		queryKey: ["biometry-available"],
		queryFn: async () => {
			return await storage.isBiometricAvailable();
		},
	});

	const applyServerUrl = async (candidateUrl: string) => {
		const nextServerUrl = await setActiveAuthServerUrl(candidateUrl);
		if (!nextServerUrl) {
			toast.error(m.toast_auth_server_invalid_url());
			return null;
		}

		setServerUrl(nextServerUrl);
		return nextServerUrl;
	};

	// Prefill from account data when redirected from unauthorized error
	useEffect(() => {
		let active = true;

		const prefill = async () => {
			if (prefillEmail) {
				const [storedSecretKey, storedServerUrl] = await Promise.all([
					storage.getStoredSecretKey(prefillEmail),
					storage.getServerUrl(prefillEmail),
				]);
				if (!active) return;

				setEmail(prefillEmail);
				if (storedSecretKey) setSecretKey(storedSecretKey);
				if (storedServerUrl) {
					const appliedServerUrl =
						await setActiveAuthServerUrl(storedServerUrl);
					if (!active) return;
					if (appliedServerUrl) {
						setServerUrl(appliedServerUrl);
					}
				} else {
					const resolvedServerUrl = await resolveActiveAuthServerUrl();
					if (active) {
						setServerUrl(resolvedServerUrl);
					}
				}
				if (!active) return;
				setIsPrefilled(true);
			} else {
				const resolvedServerUrl = await resolveActiveAuthServerUrl();
				if (active) {
					setServerUrl(resolvedServerUrl);
				}
			}
		};

		void prefill();
		return () => {
			active = false;
		};
	}, [prefillEmail]);

	useEffect(() => {
		const unsubscribe = subscribeActiveAuthServerUrl((nextServerUrl) => {
			setServerUrl(nextServerUrl);
		});

		return () => {
			unsubscribe();
		};
	}, []);

	const loginMutation = useLogin({
		enableBiometric: enableBiometric && !!biometricAvailable,
		onSuccess: async (_result) => {
			const normalizedServerUrl = normalizeServerUrl(serverUrl);

			if (normalizedServerUrl) {
				const activeAccount = await storage.getActiveAccount();
				if (activeAccount) {
					await storage.storeServerUrl(normalizedServerUrl, activeAccount);
				}
			}

			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["accounts"] }),
				queryClient.invalidateQueries({ queryKey: ["items"] }),
				queryClient.invalidateQueries({ queryKey: ["vault-items"] }),
				queryClient.invalidateQueries({ queryKey: ["decrypted-item"] }),
			]);

			toast.success(m.toast_auth_signin_success_simple());
			// No doors/reveal animation on mobile — go straight to the vault.
			navigate({ to: "/vault" });
		},
		onError: (error) => {
			console.error("Login error:", error);
			toast.error(
				error instanceof Error ? error.message : m.toast_auth_signin_error(),
			);
		},
	});

	const handleLogin = async (e: React.FormEvent) => {
		e.preventDefault();

		const nextServerUrl = await applyServerUrl(serverUrl);
		if (!nextServerUrl) {
			return;
		}
		if (requiresInsecureTransportConfirmation && !insecureTransportConfirmed) {
			toast.error(m.auth_insecure_http_confirmation_required());
			return;
		}

		await loginMutation.mutateAsync({
			email,
			password,
			secretKey,
			serverUrl: nextServerUrl,
			insecureTransportConfirmed,
			enableBiometric: enableBiometric && !!biometricAvailable,
		});
	};

	return (
		<div className="flex min-h-dvh flex-col overflow-y-auto px-6 py-10">
			<div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-8">
				<div className="text-center">
					<h1 className="font-semibold text-3xl tracking-tight">Bittery</h1>
				</div>

				{isPrefilled && (
					<div className="rounded-lg border border-amber-200/60 bg-amber-50/50 px-4 py-3 dark:border-amber-500/20 dark:bg-amber-950/20">
						<p className="font-medium text-amber-900 text-sm dark:text-amber-200">
							{m.auth_signin_session_expired_title()}
						</p>
						<p className="mt-0.5 text-amber-800/70 text-xs dark:text-amber-300/70">
							{m.auth_signin_session_expired_desktop_description()}
						</p>
					</div>
				)}

				<div>
					<h2 className="font-semibold text-xl tracking-tight">
						{m.auth_signin_title_default()}
					</h2>
					<p className="mt-1 text-muted-foreground text-sm">
						{m.auth_signin_description_default()}
					</p>
				</div>

				<form onSubmit={handleLogin} className="space-y-5">
					<div className="grid gap-1.5">
						<Label htmlFor="email">{m.auth_signin_label_email()}</Label>
						<Input
							id="email"
							type="email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							required
							placeholder={m.auth_signin_placeholder_email()}
							disabled={isPrefilled}
							className="h-12 text-base"
							inputMode="email"
							autoComplete="username"
							autoCapitalize="none"
							autoCorrect="off"
						/>
					</div>

					<div className="grid gap-1.5">
						<Label htmlFor="secretKey">
							{m.auth_signin_label_secret_key()}
						</Label>
						<InputGroup className="h-12">
							<InputGroupInput
								id="secretKey"
								type={showSecretKey ? "text" : "password"}
								value={secretKey}
								onChange={(e) => setSecretKey(e.target.value)}
								required
								placeholder={m.auth_signin_placeholder_secret_key()}
								className="font-mono text-base"
								autoComplete="off"
								autoCapitalize="characters"
								autoCorrect="off"
							/>
							<InputGroupAddon align="inline-end">
								<InputGroupButton
									type="button"
									size="icon-sm"
									onClick={() => setShowSecretKey(!showSecretKey)}
									aria-label={
										showSecretKey
											? m.vaults_detail_items_form_login_action_hide_password()
											: m.vaults_detail_items_form_login_action_show_password()
									}
								>
									{showSecretKey ? (
										<IconEyeOff className="h-4 w-4" />
									) : (
										<IconEye className="h-4 w-4" />
									)}
								</InputGroupButton>
							</InputGroupAddon>
						</InputGroup>
						<p className="text-muted-foreground text-xs">
							{m.auth_signin_secret_key_help()}
						</p>
					</div>

					<div className="grid gap-1.5">
						<Label htmlFor="password">{m.auth_signin_label_password()}</Label>
						<InputGroup className="h-12">
							<InputGroupInput
								id="password"
								type={showPassword ? "text" : "password"}
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								required
								placeholder={m.auth_signin_placeholder_password()}
								className="text-base"
								autoComplete="current-password"
								autoCapitalize="none"
								autoCorrect="off"
							/>
							<InputGroupAddon align="inline-end">
								<InputGroupButton
									type="button"
									size="icon-sm"
									onClick={() => setShowPassword(!showPassword)}
									aria-label={
										showPassword
											? m.vaults_detail_items_form_login_action_hide_password()
											: m.vaults_detail_items_form_login_action_show_password()
									}
								>
									{showPassword ? (
										<IconEyeOff className="h-4 w-4" />
									) : (
										<IconEye className="h-4 w-4" />
									)}
								</InputGroupButton>
							</InputGroupAddon>
						</InputGroup>
					</div>

					{biometricAvailable && (
						<Label
							htmlFor="biometric"
							className="flex min-h-11 cursor-pointer items-center gap-2 font-normal"
						>
							<Checkbox
								id="biometric"
								checked={enableBiometric}
								onCheckedChange={(checked) =>
									setEnableBiometric(checked === true)
								}
							/>
							<IconFingerprint className="h-4 w-4 text-muted-foreground" />
							{m.auth_signin_biometric_enable()}
						</Label>
					)}

					{requiresInsecureTransportConfirmation ? (
						<Label
							htmlFor="insecure-http-confirmation"
							className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-md border bg-foreground/3 px-3 py-2.5 font-normal transition-colors hover:bg-foreground/5"
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
						className="h-12 w-full text-base"
						disabled={loginMutation.isPending}
					>
						{loginMutation.isPending
							? m.auth_signin_button_signing_in()
							: m.auth_signin_button_sign_in()}
					</Button>
				</form>
			</div>
		</div>
	);
}
