import { useLogin } from "@bittery/core/hooks";
import {
	type DeviceSetupParamPayload,
	type ParsedDeviceSetupPayload,
	parseDeviceSetupParams,
} from "@bittery/shared/device-setup";
import { isRemoteHttpServer } from "@bittery/shared/server-transport-policy";
import { normalizeServerUrl } from "@bittery/shared/server-url";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
	ControlField,
	Description,
	Label,
	PressableFeedback,
} from "heroui-native";
import { useMemo, useState } from "react";
import {
	KeyboardAvoidingView,
	Platform,
	ScrollView,
	Text,
	View,
} from "react-native";
import {
	AuthDivider,
	AuthField,
	BrandLockup,
	InlineNotice,
	PasswordField,
} from "@/components/auth-kit";
import { DeviceSetupQrScanner } from "@/components/device-setup-qr-scanner";
import {
	BrandButton,
	GradientTile,
	IconAlertCircle,
	IconChevronRight,
	IconFingerprint,
	IconInfo,
	IconKeyRound,
	IconLock,
	IconMail,
	IconQrCode,
	IconServer,
	IconTriangleAlert,
	IconUser,
	iconSize,
	layout,
	PressScale,
	Screen,
	useBottomInset,
} from "@/components/ui";
import { defaultServerUrl } from "@/constants/server-url";
import { useAccount } from "@/contexts/account-context";
import { useServerUrl } from "@/lib/api";
import { useBiometricType } from "@/lib/biometric-type";
import { cn } from "@/lib/utils";
import { useI18n } from "@/providers/i18n-provider";
import { mirrorBorrowedMasterUnlockKeysToCredentialProvider } from "@/services/credential-provider-master-unlock-key";
import { storage } from "@/services/storage";

type SetupLink =
	| { status: "none" }
	| { status: "loaded"; payload: ParsedDeviceSetupPayload }
	| { status: "invalid"; message: string };

/** Who you are, then what unlocks you — the screen never shows both at once. */
type Step = "identity" | "password";

const STEPS: readonly Step[] = ["identity", "password"];

/**
 * Read a device-setup deep link. Pure, so the prefilled values are derived on
 * render instead of copied into state by an effect.
 */
function readSetupLink(
	params: DeviceSetupParamPayload,
	fallbackMessage: string,
): SetupLink {
	const setupValue = Array.isArray(params.setup)
		? params.setup[0]
		: params.setup;
	if (setupValue !== "1") {
		return { status: "none" };
	}

	try {
		const parsed = parseDeviceSetupParams(params);
		return parsed ? { status: "loaded", payload: parsed } : { status: "none" };
	} catch (error) {
		return {
			status: "invalid",
			message: error instanceof Error ? error.message : fallbackMessage,
		};
	}
}

/** How far along the two-step flow is — the one accent bar on this screen. */
function StepProgress({ step, label }: { step: Step; label: string }) {
	const activeIndex = STEPS.indexOf(step);

	return (
		<View
			accessibilityRole="progressbar"
			accessibilityLabel={label}
			className="mt-6 flex-row items-center justify-center gap-1.5"
		>
			{STEPS.map((name, index) => (
				<View
					key={name}
					className={cn(
						"h-1 rounded-full",
						index <= activeIndex ? "w-7 bg-accent" : "w-4 bg-border",
					)}
				/>
			))}
		</View>
	);
}

export default function LoginScreen() {
	const router = useRouter();
	const { m } = useI18n();
	const searchParams = useLocalSearchParams<{
		setup?: string;
		v?: string;
		email?: string;
		serverUrl?: string;
		secretKey?: string;
		teamName?: string;
	}>();
	const { setServerUrl: setGlobalServerUrl } = useServerUrl();
	const { refreshAccounts } = useAccount();
	const bottomInset = useBottomInset();

	const [scannedSetup, setScannedSetup] =
		useState<ParsedDeviceSetupPayload | null>(null);
	const [isSetupDismissed, setIsSetupDismissed] = useState(false);
	const [emailEdit, setEmailEdit] = useState<string | null>(null);
	const [serverUrlEdit, setServerUrlEdit] = useState<string | null>(null);
	const [secretKeyEdit, setSecretKeyEdit] = useState<string | null>(null);
	const [password, setPassword] = useState("");
	const [isScannerOpen, setIsScannerOpen] = useState(false);
	const [isServerExpanded, setIsServerExpanded] = useState(false);
	const [enableBiometric, setEnableBiometric] = useState(true);
	const [insecureTransportConfirmed, setInsecureTransportConfirmed] =
		useState(false);
	const [formError, setFormError] = useState<string | null>(null);
	// Null means "wherever the setup payload puts us", so a scan lands on the
	// password step without an effect copying the step into state.
	const [stepOverride, setStepOverride] = useState<Step | null>(null);

	const setupLink = useMemo(
		() =>
			readSetupLink(
				{
					setup: searchParams.setup,
					v: searchParams.v,
					email: searchParams.email,
					serverUrl: searchParams.serverUrl,
					secretKey: searchParams.secretKey,
					teamName: searchParams.teamName,
				},
				m.login_alert_invalid_setup_message(),
			),
		[
			searchParams.setup,
			searchParams.v,
			searchParams.email,
			searchParams.serverUrl,
			searchParams.secretKey,
			searchParams.teamName,
			m.login_alert_invalid_setup_message,
		],
	);

	const linkPayload = setupLink.status === "loaded" ? setupLink.payload : null;
	const prefill = isSetupDismissed ? null : (scannedSetup ?? linkPayload);
	const email = emailEdit ?? prefill?.email ?? "";
	const serverUrl = serverUrlEdit ?? prefill?.serverUrl ?? defaultServerUrl;
	const secretKey = secretKeyEdit ?? prefill?.secretKey ?? "";
	const normalizedServerUrl = normalizeServerUrl(serverUrl, {
		operatorEnabled: true,
		accountConfirmed: true,
	});
	const requiresInsecureTransportConfirmation = normalizedServerUrl
		? isRemoteHttpServer(normalizedServerUrl)
		: false;
	// A payload that carried a Secret Key leaves only the master password to enter.
	const isSetupComplete = Boolean(prefill?.secretKey);
	const step: Step =
		stepOverride ?? (isSetupComplete ? "password" : "identity");

	// Both of these are cached async reads of a device fact, which is what `useQuery` is for.
	const { label: biometricTypeLabel } = useBiometricType();
	const biometricDetailsQuery = useQuery({
		queryKey: ["mobile", "biometric-availability"],
		queryFn: () => storage.getBiometricAvailabilityDetails(),
	});
	const biometricDetails = biometricDetailsQuery.data ?? {
		hasHardware: false,
		isEnrolled: false,
	};
	// Biometric is only "available" if hardware exists AND biometrics are enrolled
	const biometricAvailable =
		biometricDetails.hasHardware && biometricDetails.isEnrolled;

	const loginMutation = useLogin({
		enableBiometric: enableBiometric && biometricAvailable,
		onSuccess: async (_result, _input) => {
			const normalizedServerUrl = normalizeServerUrl(serverUrl);

			if (normalizedServerUrl) {
				const activeAccount = await storage.getActiveAccount();
				if (activeAccount) {
					await storage.storeServerUrl(normalizedServerUrl, activeAccount);
				}
			}

			await refreshAccounts();

			const accountId = await storage.getActiveAccount();

			if (accountId) {
				await mirrorBorrowedMasterUnlockKeysToCredentialProvider([accountId]);
			}

			router.replace("/(vault)");
		},
		onError: (error) => {
			setFormError(
				error instanceof Error
					? error.message
					: m.login_alert_login_failed_message(),
			);
		},
	});

	const handleContinue = () => {
		if (!email.trim() || !secretKey.trim()) {
			setFormError(m.login_alert_fields_required_message());
			return;
		}

		if (!normalizedServerUrl) {
			setFormError(m.login_alert_invalid_url_message());
			setIsServerExpanded(true);
			return;
		}

		setFormError(null);
		setStepOverride("password");
	};

	const handleEditIdentity = () => {
		setFormError(null);
		setStepOverride("identity");
	};

	const handleSignIn = async () => {
		if (!email.trim() || !password.trim() || !secretKey.trim()) {
			setFormError(m.login_alert_fields_required_message());
			return;
		}

		if (!normalizedServerUrl) {
			setFormError(m.login_alert_invalid_url_message());
			return;
		}
		if (requiresInsecureTransportConfirmation && !insecureTransportConfirmed) {
			setFormError(m.auth_insecure_http_confirmation_required());
			return;
		}

		setFormError(null);
		setGlobalServerUrl(normalizedServerUrl);

		// Allow UI to re-render and show loading state before heavy crypto work
		await new Promise((resolve) => setTimeout(resolve, 50));

		await loginMutation.mutateAsync({
			email,
			password,
			secretKey,
			serverUrl: normalizedServerUrl,
			insecureTransportConfirmed,
			enableBiometric: enableBiometric && biometricAvailable,
		});
	};

	const handleStartOver = () => {
		setIsSetupDismissed(true);
		setScannedSetup(null);
		setEmailEdit(null);
		setServerUrlEdit(null);
		setSecretKeyEdit(null);
		setPassword("");
		setInsecureTransportConfirmed(false);
		setFormError(null);
		setStepOverride(null);
	};

	const errorNotice = formError ? (
		<InlineNotice
			tone="danger"
			icon={IconAlertCircle}
			description={formError}
		/>
	) : null;

	return (
		<Screen aurora>
			<KeyboardAvoidingView
				className="flex-1"
				behavior={Platform.OS === "ios" ? "padding" : "height"}
			>
				<ScrollView
					className="flex-1"
					keyboardShouldPersistTaps="handled"
					keyboardDismissMode="interactive"
					showsVerticalScrollIndicator={false}
					contentContainerStyle={{
						flexGrow: 1,
						justifyContent: "center",
						paddingHorizontal: layout.screenPadding,
						paddingTop: layout.gap.lg,
						paddingBottom: bottomInset,
					}}
				>
					<BrandLockup
						subtitle={
							step === "password"
								? m.login_step_password_subtitle()
								: m.login_subtitle()
						}
					/>

					<StepProgress
						step={step}
						label={m.login_step_progress({
							current: String(STEPS.indexOf(step) + 1),
							total: String(STEPS.length),
						})}
					/>

					{setupLink.status === "invalid" ? (
						<InlineNotice
							tone="danger"
							icon={IconAlertCircle}
							title={m.login_alert_invalid_setup_title()}
							description={setupLink.message}
							className="mt-6"
						/>
					) : null}

					{step === "password" ? (
						<View className="mt-7 gap-4">
							<View className="flex-row items-center gap-3 rounded-2xl border border-border bg-surface p-3 shadow-surface">
								<GradientTile
									name="Bittery"
									accent
									size={layout.iconTile}
									radius={14}
								>
									<IconUser
										size={iconSize.bar}
										className="text-accent-foreground"
									/>
								</GradientTile>
								<View className="min-w-0 flex-1">
									<Text
										numberOfLines={1}
										className="font-medium text-base text-foreground"
									>
										{email}
									</Text>
									<Text numberOfLines={1} className="text-muted text-xs">
										{serverUrl}
									</Text>
								</View>
								<PressableFeedback
									onPress={handleEditIdentity}
									accessibilityRole="button"
									className="h-9 items-center justify-center rounded-full px-3"
								>
									<PressableFeedback.Highlight />
									<Text className="font-medium text-muted text-sm">
										{m.login_action_change()}
									</Text>
								</PressableFeedback>
							</View>

							<PasswordField
								label={m.auth_signin_label_password()}
								placeholder={m.auth_signin_placeholder_password()}
								value={password}
								onChangeText={setPassword}
								icon={IconLock}
								isInvalid={Boolean(formError)}
								autoFocus
								onSubmit={handleSignIn}
							/>

							{biometricAvailable ? (
								<View className="rounded-2xl border border-border bg-surface p-3.5 shadow-surface">
									<ControlField
										isSelected={enableBiometric}
										onSelectedChange={setEnableBiometric}
									>
										<View className="flex-1 flex-row items-center gap-3">
											<IconFingerprint
												size={iconSize.bar}
												className="text-muted"
											/>
											<View className="flex-1">
												<Label>
													{m.login_biometric_enable_label({
														biometricType: biometricTypeLabel,
													})}
												</Label>
												<Description>
													{m.login_biometric_enable_description({
														biometricType: biometricTypeLabel,
													})}
												</Description>
											</View>
										</View>
										<ControlField.Indicator />
									</ControlField>
								</View>
							) : null}

							{requiresInsecureTransportConfirmation ? (
								<View className="rounded-2xl border border-warning/30 bg-warning/5 p-3.5">
									<ControlField
										isSelected={insecureTransportConfirmed}
										onSelectedChange={setInsecureTransportConfirmed}
									>
										<View className="flex-1">
											<Label>{m.auth_insecure_http_confirmation_label()}</Label>
											<Description>
												{m.auth_insecure_http_confirmation_description()}
											</Description>
										</View>
										<ControlField.Indicator />
									</ControlField>
								</View>
							) : null}

							{biometricDetails.hasHardware && !biometricDetails.isEnrolled ? (
								<InlineNotice
									tone="warning"
									icon={IconTriangleAlert}
									title={m.login_biometric_not_enrolled_title()}
									description={m.login_biometric_not_enrolled_description({
										biometricType: biometricTypeLabel,
									})}
								/>
							) : null}

							{errorNotice}

							<BrandButton
								label={
									loginMutation.isPending
										? m.auth_signin_button_signing_in()
										: m.auth_signin_button_sign_in()
								}
								onPress={handleSignIn}
								isLoading={loginMutation.isPending}
								size="lg"
							/>

							{prefill ? (
								<PressableFeedback
									onPress={handleStartOver}
									accessibilityRole="button"
									className="h-11 items-center justify-center rounded-xl"
								>
									<PressableFeedback.Highlight />
									<Text className="font-medium text-muted text-sm">
										{m.login_setup_complete_not_you()}
									</Text>
								</PressableFeedback>
							) : null}
						</View>
					) : (
						<View className="mt-7 gap-4">
							{/* The fast path leads: a desktop or web session fills every field. */}
							<PressScale
								onPress={() => setIsScannerOpen(true)}
								accessibilityRole="button"
								className="flex-row items-center gap-3.5 rounded-2xl border border-border bg-surface p-4 shadow-surface"
							>
								<GradientTile name="Bittery" accent glow size={44} radius={14}>
									<IconQrCode
										size={iconSize.header}
										className="text-accent-foreground"
									/>
								</GradientTile>
								<View className="min-w-0 flex-1">
									<Text className="font-semibold text-base text-foreground">
										{m.login_setup_device_banner_title()}
									</Text>
									<Text className="mt-0.5 text-muted text-sm">
										{m.login_setup_device_banner_description()}
									</Text>
								</View>
								<IconChevronRight
									size={iconSize.row}
									className="text-muted opacity-60"
								/>
							</PressScale>

							{setupLink.status === "loaded" && !linkPayload?.secretKey ? (
								<InlineNotice
									tone="info"
									icon={IconInfo}
									title={m.login_alert_setup_loaded_title()}
									description={m.login_alert_setup_loaded_message()}
								/>
							) : null}

							<AuthDivider label={m.login_manual_divider()} />

							<AuthField
								label={m.auth_signin_label_email()}
								placeholder={m.auth_signin_placeholder_email()}
								icon={IconMail}
								value={email}
								onChangeText={setEmailEdit}
								keyboardType="email-address"
								textContentType="emailAddress"
							/>

							<AuthField
								label={m.auth_signin_label_secret_key()}
								placeholder={m.auth_signin_placeholder_secret_key()}
								description={m.auth_signin_secret_key_help()}
								icon={IconKeyRound}
								value={secretKey}
								onChangeText={setSecretKeyEdit}
								autoCapitalize="characters"
								inputClassName="font-mono"
							/>

							{errorNotice}

							<BrandButton
								label={m.login_action_continue()}
								onPress={handleContinue}
								size="lg"
							/>

							{/* Self-hosters change the server here; everyone else never sees a URL field. */}
							{isServerExpanded ? (
								<AuthField
									label={m.login_server_url_label()}
									placeholder={m.login_server_url_placeholder()}
									description={m.login_server_url_description()}
									icon={IconServer}
									value={serverUrl}
									onChangeText={setServerUrlEdit}
									keyboardType="url"
									autoFocus
								/>
							) : (
								<PressableFeedback
									onPress={() => setIsServerExpanded(true)}
									accessibilityRole="button"
									accessibilityLabel={m.login_server_url_label()}
									className="h-11 flex-row items-center gap-2.5 rounded-xl px-3"
								>
									<PressableFeedback.Highlight />
									<IconServer size={iconSize.chip} className="text-muted" />
									<Text className="text-muted text-xs">
										{m.login_server_row_label()}
									</Text>
									<Text
										numberOfLines={1}
										className="min-w-0 flex-1 text-foreground text-xs"
									>
										{serverUrl}
									</Text>
									<Text className="font-medium text-muted text-xs">
										{m.login_action_change()}
									</Text>
								</PressableFeedback>
							)}
						</View>
					)}
				</ScrollView>
			</KeyboardAvoidingView>

			<DeviceSetupQrScanner
				visible={isScannerOpen}
				onClose={() => setIsScannerOpen(false)}
				onScanSuccess={(payload) => {
					setIsSetupDismissed(false);
					setScannedSetup(payload);
					setEmailEdit(null);
					setServerUrlEdit(null);
					setSecretKeyEdit(null);
					setFormError(null);
					setStepOverride(null);
				}}
			/>
		</Screen>
	);
}
