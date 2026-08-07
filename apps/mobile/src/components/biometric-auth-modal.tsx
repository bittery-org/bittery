/**
 * The biometric-unlock prompt the app raises whenever the OS check has to be
 * repeated. It floats above whatever screen is showing, so it takes the sheet
 * rung and the sheet brand accent rather than the canvas.
 */

import { useRouter } from "expo-router";
import { Button } from "heroui-native";
import { useCallback, useState } from "react";
import { ActivityIndicator, Modal, Text, View } from "react-native";
import { BiometricGlyph } from "@/components/auth-kit";
import {
	BrandButton,
	GradientTile,
	IconAlertCircle,
	IconKeyRound,
	IconLock,
	IconRefresh,
	iconSize,
	SheetBrandAccent,
} from "@/components/ui";
import { useBiometricType } from "@/lib/biometric-type";
import { useI18n } from "@/providers/i18n-provider";
import { useBiometricAuth } from "../contexts/biometric-auth-context";
import {
	resolveBiometricErrorMessage,
	resolveMasterPasswordReentryMessage,
} from "../lib/biometric-error-message";
import type { BiometricErrorType } from "../services/storage";

interface BiometricAuthModalProps {
	visible: boolean;
	onSuccess?: () => void;
	onFallbackToPassword?: () => void;
}

const MAX_RETRIES = 3;

/** Neutral status well: the glyph carries the state colour, the tile does not. */
function StatusWell({
	tone,
	children,
}: {
	tone: "danger" | "warning";
	children: React.ReactNode;
}) {
	return (
		<View
			className={
				tone === "danger"
					? "h-16 w-16 items-center justify-center rounded-2xl bg-danger-soft"
					: "h-16 w-16 items-center justify-center rounded-2xl bg-warning-soft"
			}
		>
			{children}
		</View>
	);
}

export function BiometricAuthModal({
	visible,
	onSuccess,
	onFallbackToPassword,
}: BiometricAuthModalProps) {
	const { m } = useI18n();
	const router = useRouter();
	const {
		triggerBiometricAuth,
		lastAuthResult,
		requiresMasterPassword,
		dismissAuthRequirement,
	} = useBiometricAuth();

	const [isAuthenticating, setIsAuthenticating] = useState(false);
	const [retryCount, setRetryCount] = useState(0);
	const { label: biometricTypeLabel, token: biometricTypeToken } =
		useBiometricType({ enabled: visible });

	const handleAuthenticate = useCallback(async () => {
		setIsAuthenticating(true);
		try {
			const result = await triggerBiometricAuth();
			if (result.success) {
				onSuccess?.();
			}
		} finally {
			setIsAuthenticating(false);
		}
	}, [triggerBiometricAuth, onSuccess]);

	const handleRetry = async () => {
		setRetryCount((count) => count + 1);
		await handleAuthenticate();
	};

	const handleUsePassword = () => {
		dismissAuthRequirement();
		if (onFallbackToPassword) {
			onFallbackToPassword();
		} else {
			router.replace("/(auth)/unlock");
		}
	};

	const renderErrorGlyph = (
		error?: BiometricErrorType | "travel_mode_unverified",
	) => {
		if (error === "lockout") {
			return <IconLock size={28} className="text-danger" />;
		}
		if (error === "master_password_required") {
			return <IconKeyRound size={28} className="text-warning" />;
		}
		return <IconAlertCircle size={28} className="text-danger" />;
	};

	const renderContent = () => {
		if (requiresMasterPassword) {
			return (
				<>
					<StatusWell tone="warning">
						<IconKeyRound size={28} className="text-warning" />
					</StatusWell>
					<Text className="mt-5 text-center font-semibold text-foreground text-lg">
						{m.mob_biometric_modal_password_required_title()}
					</Text>
					<Text className="mt-2 text-center text-muted text-sm">
						{/* The period comes from storage as a number and is formatted here. */}
						{resolveMasterPasswordReentryMessage(
							lastAuthResult?.masterPasswordReentryPeriodMs,
							m,
						)}
					</Text>
					<BrandButton
						label={m.mob_biometric_modal_enter_password()}
						onPress={handleUsePassword}
						className="mt-6"
					/>
				</>
			);
		}

		if (isAuthenticating) {
			return (
				<>
					<GradientTile name="Bittery" accent glow size={64} radius={20}>
						<BiometricGlyph
							token={biometricTypeToken}
							size={30}
							className="text-accent-foreground"
						/>
					</GradientTile>
					<Text className="mt-5 text-center font-semibold text-foreground text-lg">
						{m.mob_biometric_modal_biometric_required({
							biometricType: biometricTypeLabel,
						})}
					</Text>
					<Text className="mt-2 text-center text-muted text-sm">
						{m.mob_biometric_modal_please_authenticate()}
					</Text>
					<ActivityIndicator size="small" style={{ marginTop: 24 }} />
				</>
			);
		}

		if (lastAuthResult && !lastAuthResult.success) {
			// `lastAuthResult.message` is a diagnostic English string (or the raw native
			// error code the react-native port passes through) and is never displayed; the
			// copy is derived from `error`, plus the structured re-entry period.
			const errorMessage = resolveBiometricErrorMessage(lastAuthResult, m);
			const canRetry =
				lastAuthResult.error !== "lockout" && retryCount < MAX_RETRIES;

			return (
				<>
					<StatusWell
						tone={
							lastAuthResult.error === "master_password_required"
								? "warning"
								: "danger"
						}
					>
						{renderErrorGlyph(lastAuthResult.error)}
					</StatusWell>
					<Text className="mt-5 text-center font-semibold text-foreground text-lg">
						{m.mob_biometric_modal_auth_failed()}
					</Text>
					<Text className="mt-2 text-center text-muted text-sm">
						{errorMessage}
					</Text>
					<View className="mt-6 w-full gap-2.5">
						{canRetry ? (
							<BrandButton
								label={m.mob_biometric_modal_try_again()}
								onPress={handleRetry}
								leading={
									<IconRefresh
										size={iconSize.row}
										className="text-accent-foreground"
									/>
								}
							/>
						) : null}
						<Button onPress={handleUsePassword} variant="secondary" size="lg">
							{m.mob_biometric_modal_use_password()}
						</Button>
					</View>
				</>
			);
		}

		return (
			<>
				<GradientTile name="Bittery" accent glow size={64} radius={20}>
					<BiometricGlyph
						token={biometricTypeToken}
						size={30}
						className="text-accent-foreground"
					/>
				</GradientTile>
				<Text className="mt-5 text-center font-semibold text-foreground text-lg">
					{m.mob_biometric_modal_biometric_required({
						biometricType: biometricTypeLabel,
					})}
				</Text>
				<Text className="mt-2 text-center text-muted text-sm">
					{m.mob_biometric_modal_use_biometric({
						biometricType: biometricTypeLabel,
					})}
				</Text>
				<View className="mt-6 w-full gap-2.5">
					<BrandButton
						label={m.mob_biometric_modal_authenticate()}
						onPress={handleAuthenticate}
						leading={
							<BiometricGlyph
								token={biometricTypeToken}
								size={iconSize.bar}
								className="text-accent-foreground"
							/>
						}
					/>
					<Button onPress={handleUsePassword} variant="secondary" size="lg">
						{m.mob_biometric_modal_use_password()}
					</Button>
				</View>
			</>
		);
	};

	return (
		<Modal
			visible={visible}
			transparent
			animationType="fade"
			statusBarTranslucent
			onShow={() => {
				if (!isAuthenticating && !lastAuthResult) {
					void handleAuthenticate();
				}
			}}
		>
			<View className="flex-1 items-center justify-center bg-black/60 px-6">
				<View className="w-full max-w-sm overflow-hidden rounded-2xl border border-border bg-surface-secondary px-5 pt-7 pb-5 shadow-overlay">
					<SheetBrandAccent height={110} />
					<View className="items-center">{renderContent()}</View>
				</View>
			</View>
		</Modal>
	);
}
