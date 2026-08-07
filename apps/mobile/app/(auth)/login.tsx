import { useLogin } from "@bittery/core/hooks";
import {
	type DeviceSetupParamPayload,
	type ParsedDeviceSetupPayload,
	parseDeviceSetupParams,
} from "@bittery/shared";
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
	ListCard,
	ListRow,
	layout,
	Screen,
	useBottomInset,
} from "@/components/ui";
import { defaultServerUrl } from "@/constants/server-url";
import { useAccount } from "@/contexts/account-context";
import { useBiometricType } from "@/lib/biometric-type";
import { useServerUrl } from "@/lib/rpc";
import { useI18n } from "@/providers/i18n-provider";
import { mirrorBorrowedMasterUnlockKeysToCredentialProvider } from "@/services/credential-provider-master-unlock-key";
import { storage } from "@/services/storage";

type SetupLink =
	| { status: "none" }
	| { status: "loaded"; payload: ParsedDeviceSetupPayload }
	| { status: "invalid"; message: string };

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
	const [enableBiometric, setEnableBiometric] = useState(true);
	const [formError, setFormError] = useState<string | null>(null);

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
	// A payload that carried a Secret Key leaves only the master password to enter.
	const isSetupComplete = Boolean(prefill?.secretKey);

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

	const handleSignIn = async () => {
		if (!email.trim() || !password.trim() || !secretKey.trim()) {
			setFormError(m.login_alert_fields_required_message());
			return;
		}

		const normalizedServerUrl = normalizeServerUrl(serverUrl);
		if (!normalizedServerUrl) {
			setFormError(m.login_alert_invalid_url_message());
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
		setFormError(null);
	};

	const submitLabel = loginMutation.isPending
		? m.auth_signin_button_signing_in()
		: m.auth_signin_button_sign_in();

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
					<BrandLockup subtitle={m.login_subtitle()} />

					{setupLink.status === "invalid" ? (
						<InlineNotice
							tone="danger"
							icon={IconAlertCircle}
							title={m.login_alert_invalid_setup_title()}
							description={setupLink.message}
							className="mt-8"
						/>
					) : null}

					{isSetupComplete ? (
						<View className="mt-8 gap-4">
							<View className="items-center gap-3 rounded-2xl border border-border bg-surface p-4 shadow-surface">
								<GradientTile name="Bittery" accent size={48} radius={16}>
									<IconUser
										size={iconSize.header}
										className="text-accent-foreground"
									/>
								</GradientTile>
								<View className="items-center">
									<Text className="font-semibold text-foreground text-lg">
										{m.login_setup_complete_welcome_back()}
									</Text>
									<Text
										numberOfLines={1}
										className="mt-0.5 text-center text-muted text-sm"
									>
										{email}
									</Text>
									<Text
										numberOfLines={1}
										className="text-center text-muted text-xs"
									>
										{serverUrl}
									</Text>
								</View>
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

							{formError ? (
								<InlineNotice
									tone="danger"
									icon={IconAlertCircle}
									description={formError}
								/>
							) : null}

							<BrandButton
								label={submitLabel}
								onPress={handleSignIn}
								isLoading={loginMutation.isPending}
								size="lg"
							/>

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
						</View>
					) : (
						<View className="mt-8 gap-4">
							<ListCard>
								<ListRow
									title={m.login_setup_device_banner_title()}
									subtitle={m.login_setup_device_banner_description()}
									onPress={() => setIsScannerOpen(true)}
									showChevron
									leading={
										<View className="h-10 w-10 items-center justify-center rounded-xl border border-border bg-default">
											<IconQrCode
												size={iconSize.bar}
												className="text-foreground"
											/>
										</View>
									}
								/>
							</ListCard>

							{setupLink.status === "loaded" && !linkPayload?.secretKey ? (
								<InlineNotice
									tone="info"
									icon={IconInfo}
									title={m.login_alert_setup_loaded_title()}
									description={m.login_alert_setup_loaded_message()}
								/>
							) : null}

							<AuthField
								label={m.login_server_url_label()}
								placeholder={m.login_server_url_placeholder()}
								description={m.login_server_url_description()}
								icon={IconServer}
								value={serverUrl}
								onChangeText={setServerUrlEdit}
								keyboardType="url"
							/>

							<AuthField
								label={m.auth_signin_label_email()}
								placeholder={m.auth_signin_placeholder_email()}
								icon={IconMail}
								value={email}
								onChangeText={setEmailEdit}
								keyboardType="email-address"
								textContentType="emailAddress"
							/>

							<PasswordField
								label={m.auth_signin_label_password()}
								placeholder={m.auth_signin_placeholder_password()}
								value={password}
								onChangeText={setPassword}
								icon={IconLock}
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

							{formError ? (
								<InlineNotice
									tone="danger"
									icon={IconAlertCircle}
									description={formError}
								/>
							) : null}

							<BrandButton
								label={submitLabel}
								onPress={handleSignIn}
								isLoading={loginMutation.isPending}
								size="lg"
								className="mt-2"
							/>
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
				}}
			/>
		</Screen>
	);
}
