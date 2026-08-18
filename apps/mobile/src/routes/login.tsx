import { useLogin } from "@bittery/core/hooks";
import {
	type ParsedDeviceSetupPayload,
	parseDeviceSetupParams,
} from "@bittery/shared/device-setup";
import { isRemoteHttpServer } from "@bittery/shared/server-transport-policy";
import { normalizeServerUrl } from "@bittery/shared/server-url";
import { toast } from "@bittery/ui";
import {
	IconFingerprint,
	IconKey,
	IconLock,
	IconMail,
	IconNetwork,
	IconQrCode,
	IconTriangleAlert,
} from "@bittery/ui/icons";
import { cn } from "@bittery/ui/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createFileRoute,
	redirect,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
	AuthField,
	AuthFooterNote,
	AuthTextAction,
	AuthToggle,
	BrandLockup,
	InlineNotice,
	PasswordField,
	submitForm,
} from "@/components/auth-kit";
import { ServerPickerSheet } from "@/components/server-picker-sheet";
import {
	AppBar,
	BrandButton,
	IconTile,
	iconClass,
	ListCard,
	ListRow,
	Pressable,
	QrScannerOverlay,
	Screen,
	ScreenScroll,
	waitForScannerOverlayPaint,
} from "@/components/ui";
import { useMobileAccountRuntime } from "@/contexts/account-context";
import { resolveAddAccountExit } from "@/lib/add-account-exit";
import {
	getServerLabel,
	resolveActiveAuthServerUrl,
	setActiveAuthServerUrl,
	subscribeActiveAuthServerUrl,
} from "@/lib/auth-server";
import {
	CameraPermissionDeniedError,
	cancelActiveScan,
	formatScanError,
	InvalidDeviceSetupQrError,
	isScanCancelled,
	scanDeviceSetupQr,
} from "@/lib/barcode-scanner";
import { prepareCredentialProviderAfterPasswordUnlock } from "@/lib/credential-provider-password-unlock";
import { storage } from "@/lib/storage";
import { useI18n } from "@/providers/i18n-provider";

interface LoginSearchParams {
	prefillEmail?: string;
	addAccount?: boolean;
	setup?: string;
	v?: string;
	email?: string;
	serverUrl?: string;
	teamName?: string;
	secretKey?: string;
}

function setupPayloadFromSearch(
	search: LoginSearchParams,
): ParsedDeviceSetupPayload | null {
	try {
		return parseDeviceSetupParams({
			setup: search.setup,
			v: search.v,
			email: search.email,
			serverUrl: search.serverUrl,
			teamName: search.teamName,
			secretKey: search.secretKey,
		});
	} catch {
		return null;
	}
}

export const Route = createFileRoute("/login")({
	beforeLoad: async ({ search, context }) => {
		const prefillEmail =
			typeof search.prefillEmail === "string" ? search.prefillEmail : undefined;
		if (prefillEmail) {
			return;
		}

		/**
		 * The guard below sends anyone with a stored account back to `/unlock`, which is right
		 * for a cold start but wrong when the user *asked* for this screen — "Use a different
		 * account" on `/unlock` and "Add account" in the switcher both did nothing at all,
		 * because the navigation bounced straight back to where it started. An explicit flag is
		 * the only way to tell those apart: an empty `prefillEmail` cannot say it, since `""`
		 * is falsy and reads as "not asked for".
		 */
		if (search.addAccount) {
			return;
		}

		if (setupPayloadFromSearch(search)) {
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
		// A deep link or a reload carries the flag back as the string "true".
		addAccount: search.addAccount === true || search.addAccount === "true",
		setup: typeof search.setup === "string" ? search.setup : undefined,
		v: typeof search.v === "string" ? search.v : undefined,
		email: typeof search.email === "string" ? search.email : undefined,
		serverUrl:
			typeof search.serverUrl === "string" ? search.serverUrl : undefined,
		teamName: typeof search.teamName === "string" ? search.teamName : undefined,
		secretKey:
			typeof search.secretKey === "string" ? search.secretKey : undefined,
	}),
});

export function LoginPage() {
	const { m } = useI18n();
	const search = Route.useSearch();
	const {
		prefillEmail,
		addAccount,
		setup: setupFlag,
		v: setupVersion,
		email: setupEmail,
		serverUrl: setupServerUrl,
		teamName: setupTeamName,
		secretKey: setupSecretKey,
	} = search;
	const navigate = useNavigate();
	const router = useRouter();
	const { manager } = useMobileAccountRuntime();
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
	const [setupComplete, setSetupComplete] = useState(false);
	const [hasSetupSecret, setHasSetupSecret] = useState(false);
	const [isScanningSetup, setIsScanningSetup] = useState(false);
	const [isServerPickerOpen, setIsServerPickerOpen] = useState(false);
	const scanningSetupRef = useRef(false);
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
		const nextServerUrl = await setActiveAuthServerUrl(candidateUrl, {
			persistToAccount: !addAccount,
		});
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
			const setup = setupPayloadFromSearch({
				setup: setupFlag,
				v: setupVersion,
				email: setupEmail,
				serverUrl: setupServerUrl,
				teamName: setupTeamName,
				secretKey: setupSecretKey,
			});
			if (setup) {
				setEmail(setup.email);
				if (setup.secretKey) setSecretKey(setup.secretKey);
				const appliedServerUrl = await setActiveAuthServerUrl(setup.serverUrl);
				if (!active) return;
				if (appliedServerUrl) setServerUrl(appliedServerUrl);
				setSetupComplete(true);
				setHasSetupSecret(Boolean(setup.secretKey));
				return;
			}

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
	}, [
		prefillEmail,
		setupFlag,
		setupVersion,
		setupEmail,
		setupServerUrl,
		setupTeamName,
		setupSecretKey,
	]);

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

			// A fresh sign-in is a password unlock, so the MUK, the native
			// password stamp and (when biometric is on) the autofill escrow
			// all move here rather than a debounce later. Never fatal: a
			// failed prepare costs autofill a few seconds, a thrown one
			// costs the user their sign-in.
			const signedInAccountId = await storage.getActiveAccount();
			if (signedInAccountId) {
				try {
					await prepareCredentialProviderAfterPasswordUnlock([
						signedInAccountId,
					]);
				} catch (error) {
					console.warn(
						"[Login] Failed to prepare the credential provider",
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

	const applySetupPayload = async (payload: ParsedDeviceSetupPayload) => {
		setEmail(payload.email);
		setSecretKey(payload.secretKey ?? "");
		const appliedServerUrl = await applyServerUrl(payload.serverUrl);
		if (!appliedServerUrl) return;
		setSetupComplete(true);
		setHasSetupSecret(Boolean(payload.secretKey));
		if (!payload.secretKey) {
			toast.success(m.login_alert_setup_loaded_message());
		}
	};

	const closeSetupScanner = () => {
		scanningSetupRef.current = false;
		setIsScanningSetup(false);
		void cancelActiveScan();
	};

	const scanSetupQr = async () => {
		scanningSetupRef.current = true;
		setIsScanningSetup(true);
		await waitForScannerOverlayPaint();
		if (!scanningSetupRef.current) return;
		try {
			const payload = await scanDeviceSetupQr();
			if (!scanningSetupRef.current) return;
			await applySetupPayload(payload);
		} catch (error) {
			if (isScanCancelled(error)) return;
			if (error instanceof CameraPermissionDeniedError) {
				toast.error(m.device_setup_scanner_permission_description());
				return;
			}
			if (error instanceof InvalidDeviceSetupQrError) {
				toast.error(m.device_setup_scanner_invalid_qr_error());
				return;
			}
			console.warn(
				"[login] setup scan did not complete",
				formatScanError(error),
			);
		} finally {
			scanningSetupRef.current = false;
			setIsScanningSetup(false);
		}
	};

	const startOver = () => {
		setEmail("");
		setPassword("");
		setSecretKey("");
		setSetupComplete(false);
		setHasSetupSecret(false);
		void navigate({
			to: "/login",
			search: addAccount ? { addAccount: true } : {},
		});
	};

	const leaveAddAccount = () => {
		const activeAccount = manager.getActiveAccount();
		const exit = resolveAddAccountExit({
			canGoBack: router.history.canGoBack(),
			isUnlocked: activeAccount ? manager.isUnlocked(activeAccount) : false,
		});
		if (exit.kind === "back") {
			router.history.back();
			return;
		}
		void navigate({ to: exit.to });
	};

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
		<>
			<Screen aurora>
				{addAccount ? (
					<AppBar
						title={m.mob_login_title_add_account()}
						onBack={leaveAddAccount}
						backLabel={m.mob_common_go_back()}
						bordered={false}
					/>
				) : null}
				<ScreenScroll inset="plain">
					{/* Top-aligned so the QR banner and biometric toggle keep their full
					    wrapping height instead of being pinched into a centred column. */}
					<div
						className={cn(
							"mx-auto flex min-h-full w-full max-w-sm flex-col gap-6 px-5 pb-6",
							addAccount ? "pt-4" : "pt-10",
						)}
					>
						{addAccount ? (
							<p className="text-pretty text-muted-foreground text-sm">
								{m.mob_login_description_add_account()}
							</p>
						) : (
							<BrandLockup
								title={m.auth_signin_title_default()}
								subtitle={m.auth_signin_description_default()}
							/>
						)}

						{isPrefilled && (
							<InlineNotice
								tone="warning"
								icon={IconTriangleAlert}
								title={m.auth_signin_session_expired_title()}
								description={m.auth_signin_session_expired_desktop_description()}
							/>
						)}

						{!setupComplete && !isPrefilled ? (
							<ListCard>
								<ListRow
									title={m.login_setup_device_banner_title()}
									subtitle={m.login_setup_device_banner_description()}
									leading={
										<IconTile tone="brand">
											<IconQrCode className={iconClass.bar} />
										</IconTile>
									}
									showChevron
									wrap
									isDisabled={isScanningSetup}
									onPress={() => void scanSetupQr()}
								/>
							</ListCard>
						) : null}

						<form
							ref={formRef}
							onSubmit={handleLogin}
							className="flex flex-col gap-4"
						>
							{setupComplete ? (
								<AuthField
									id="serverUrl"
									label={m.login_server_url_label()}
									value={serverUrl}
									disabled
								/>
							) : (
								<ListCard>
									<ListRow
										title={m.login_server_row_label()}
										subtitle={
											getServerLabel(serverUrl) ||
											m.auth_footer_server_loading()
										}
										leading={
											<IconTile>
												<IconNetwork className={iconClass.row} />
											</IconTile>
										}
										showChevron
										onPress={() => setIsServerPickerOpen(true)}
									/>
								</ListCard>
							)}

							<AuthField
								id="email"
								label={m.auth_signin_label_email()}
								icon={IconMail}
								type="email"
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								required
								placeholder={m.auth_signin_placeholder_email()}
								disabled={isPrefilled || setupComplete}
								inputMode="email"
								autoComplete="username"
								autoCapitalize="none"
								autoCorrect="off"
							/>

							{hasSetupSecret ? null : (
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
							)}

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

							{setupComplete ? (
								<Pressable
									onClick={startOver}
									className="self-center py-1 text-muted-foreground text-sm"
								>
									{m.login_setup_complete_not_you()}
								</Pressable>
							) : null}
						</form>

						{addAccount ? (
							<AuthTextAction
								label={m.mob_login_cancel_add_account()}
								onPress={leaveAddAccount}
							/>
						) : null}

						<div className="mt-auto pt-4">
							<AuthFooterNote label={m.mob_auth_encrypted_note()} />
						</div>
					</div>
				</ScreenScroll>
			</Screen>
			<QrScannerOverlay
				open={isScanningSetup}
				title={m.device_setup_scanner_title()}
				instruction={m.device_setup_scanner_footer()}
				backLabel={m.mob_common_go_back()}
				onCancel={closeSetupScanner}
			/>
			<ServerPickerSheet
				open={isServerPickerOpen}
				onOpenChange={setIsServerPickerOpen}
				selectedUrl={serverUrl}
				persistToAccount={!addAccount}
				onSelected={setServerUrl}
			/>
		</>
	);
}
