import { useLogin } from "@bittery/core/hooks";
import { isRemoteHttpServer } from "@bittery/shared/server-transport-policy";
import { normalizeServerUrl } from "@bittery/shared/server-url";
import { toast } from "@bittery/ui";
import {
	IconFingerprint,
	IconKey,
	IconLock,
	IconMail,
	IconTriangleAlert,
} from "@bittery/ui/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
	AuthField,
	AuthFooterNote,
	AuthToggle,
	BrandLockup,
	InlineNotice,
	PasswordField,
	submitForm,
} from "@/components/auth-kit";
import { BrandButton, Screen, ScreenScroll } from "@/components/ui";
import {
	resolveActiveAuthServerUrl,
	setActiveAuthServerUrl,
	subscribeActiveAuthServerUrl,
} from "@/lib/auth-server";
import { mirrorBorrowedMasterUnlockKeysToCredentialProvider } from "@/lib/credential-provider-master-unlock-key";
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
	const [enableBiometric, setEnableBiometric] = useState(true);
	const [insecureTransportConfirmed, setInsecureTransportConfirmed] =
		useState(false);
	const [isPrefilled, setIsPrefilled] = useState(false);
	const requiresInsecureTransportConfirmation = isRemoteHttpServer(serverUrl);
	// See `submitForm`: the gradient button is not a native submit control.
	const formRef = useRef<HTMLFormElement>(null);

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

			// `apps/mobile/app/(auth)/login.tsx:225` — a fresh sign-in is an unlock, so the
			// MUK reaches the credential provider here rather than a debounce later. Never
			// fatal: a failed mirror costs autofill a few seconds, a thrown one costs the
			// user their sign-in.
			const signedInAccountId = await storage.getActiveAccount();
			if (signedInAccountId) {
				try {
					await mirrorBorrowedMasterUnlockKeysToCredentialProvider([
						signedInAccountId,
					]);
				} catch (error) {
					console.warn(
						"[Login] Failed to mirror MUK to credential provider",
						error,
					);
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
		<Screen aurora>
			<ScreenScroll inset="plain">
				{/* `min-h-full` + `justify-center` centres the form on a tall phone but lets it
				    grow past the fold once the keyboard is up. */}
				<div className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center gap-7 px-4 py-8">
					<BrandLockup
						title={m.auth_signin_title_default()}
						subtitle={m.auth_signin_description_default()}
					/>

					{isPrefilled && (
						<InlineNotice
							tone="warning"
							icon={IconTriangleAlert}
							title={m.auth_signin_session_expired_title()}
							description={m.auth_signin_session_expired_desktop_description()}
						/>
					)}

					<form
						ref={formRef}
						onSubmit={handleLogin}
						className="flex flex-col gap-4"
					>
						<AuthField
							id="email"
							label={m.auth_signin_label_email()}
							icon={IconMail}
							type="email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							required
							placeholder={m.auth_signin_placeholder_email()}
							disabled={isPrefilled}
							inputMode="email"
							autoComplete="username"
							autoCapitalize="none"
							autoCorrect="off"
						/>

						<PasswordField
							id="secretKey"
							label={m.auth_signin_label_secret_key()}
							icon={IconKey}
							description={m.auth_signin_secret_key_help()}
							value={secretKey}
							onChange={(e) => setSecretKey(e.target.value)}
							required
							placeholder={m.auth_signin_placeholder_secret_key()}
							// A 34-character key does not fit a phone field at 15px. Mono at 13px
							// with tight tracking shows the whole format hint without wrapping.
							inputClassName="font-mono text-sm tracking-tighter"
							autoComplete="off"
							autoCapitalize="characters"
							autoCorrect="off"
						/>

						<PasswordField
							id="password"
							label={m.auth_signin_label_password()}
							icon={IconLock}
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							required
							placeholder={m.auth_signin_placeholder_password()}
							autoComplete="current-password"
							autoCapitalize="none"
							autoCorrect="off"
						/>

						{biometricAvailable && (
							<AuthToggle
								icon={IconFingerprint}
								label={m.auth_signin_biometric_enable()}
								isSelected={enableBiometric}
								onSelectedChange={setEnableBiometric}
							/>
						)}

						{requiresInsecureTransportConfirmation ? (
							<AuthToggle
								tone="warning"
								icon={IconTriangleAlert}
								label={m.auth_insecure_http_confirmation_label()}
								description={m.auth_insecure_http_confirmation_description()}
								isSelected={insecureTransportConfirmed}
								onSelectedChange={setInsecureTransportConfirmed}
							/>
						) : null}

						<BrandButton
							size="lg"
							className="mt-1"
							onClick={() => submitForm(formRef.current)}
							isLoading={loginMutation.isPending}
							label={
								loginMutation.isPending
									? m.auth_signin_button_signing_in()
									: m.auth_signin_button_sign_in()
							}
						/>
					</form>

					<AuthFooterNote label={m.mob_auth_encrypted_note()} />
				</div>
			</ScreenScroll>
		</Screen>
	);
}
