/**
 * Biometric Authentication Modal
 * Displayed when biometric re-authentication is required
 */

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import {
	AlertCircle,
	Fingerprint,
	KeyRound,
	Lock,
	RefreshCw,
	ScanFace,
} from "lucide-react-native";
import { useCallback, useState } from "react";
import {
	ActivityIndicator,
	Modal,
	Text,
	TouchableOpacity,
	View,
} from "react-native";
import { cn } from "@/lib/utils";
import { useBiometricAuth } from "../contexts/biometric-auth-context";
import {
	type BiometricErrorType,
	getBiometricErrorMessage,
	storage,
} from "../services/storage";

interface BiometricAuthModalProps {
	visible: boolean;
	onSuccess?: () => void;
	onFallbackToPassword?: () => void;
}

export function BiometricAuthModal({
	visible,
	onSuccess,
	onFallbackToPassword,
}: BiometricAuthModalProps) {
	const router = useRouter();
	const {
		triggerBiometricAuth,
		lastAuthResult,
		requiresMasterPassword,
		dismissAuthRequirement,
	} = useBiometricAuth();

	const [isAuthenticating, setIsAuthenticating] = useState(false);
	const [retryCount, setRetryCount] = useState(0);
	const biometricTypeQuery = useQuery({
		queryKey: ["mobile", "biometric-type"],
		queryFn: () => storage.getBiometricType(),
		enabled: visible,
	});
	const biometricType = biometricTypeQuery.data ?? null;

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
		setRetryCount((prev) => prev + 1);
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

	const getBiometricIcon = () => {
		if (biometricType === "Face ID") {
			return <ScanFace size={48} color="#3b82f6" />;
		}
		return <Fingerprint size={48} color="#3b82f6" />;
	};

	const getErrorIcon = (error?: BiometricErrorType) => {
		switch (error) {
			case "lockout":
				return <Lock size={48} color="#ef4444" />;
			case "master_password_required":
				return <KeyRound size={48} color="#f59e0b" />;
			default:
				return <AlertCircle size={48} color="#ef4444" />;
		}
	};

	const renderContent = () => {
		// If master password is required
		if (requiresMasterPassword) {
			return (
				<>
					<View className="mb-6 h-20 w-20 items-center justify-center rounded-full bg-amber-100">
						<KeyRound size={40} color="#f59e0b" />
					</View>
					<Text className="mb-2 text-center font-bold text-foreground text-xl">
						Password Required
					</Text>
					<Text className="mb-6 text-center text-muted">
						For your security, please enter your master password. This is
						required every 30 days.
					</Text>
					<TouchableOpacity
						onPress={handleUsePassword}
						className="w-full rounded-lg bg-primary py-4"
					>
						<Text className="text-center font-semibold text-primary-foreground">
							Enter Password
						</Text>
					</TouchableOpacity>
				</>
			);
		}

		// If authenticating
		if (isAuthenticating) {
			return (
				<>
					<View className="mb-6 h-20 w-20 items-center justify-center rounded-full bg-blue-100">
						{getBiometricIcon()}
					</View>
					<Text className="mb-2 text-center font-bold text-foreground text-xl">
						{biometricType || "Biometric"} Required
					</Text>
					<Text className="mb-6 text-center text-muted">
						Please authenticate to continue
					</Text>
					<ActivityIndicator size="large" color="#3b82f6" />
				</>
			);
		}

		// If there was an error
		if (lastAuthResult && !lastAuthResult.success) {
			const errorMessage =
				lastAuthResult.message ||
				getBiometricErrorMessage(lastAuthResult.error || "unknown");

			return (
				<>
					<View
						className={cn(
							"mb-6",
							"h-20",
							"w-20",
							"items-center",
							"justify-center",
							"rounded-full",
							lastAuthResult.error === "lockout" ? "bg-red-100" : "bg-red-100",
						)}
					>
						{getErrorIcon(lastAuthResult.error)}
					</View>
					<Text className="mb-2 text-center font-bold text-foreground text-xl">
						Authentication Failed
					</Text>
					<Text className="mb-6 text-center text-muted">{errorMessage}</Text>
					<View className="w-full space-y-3">
						{lastAuthResult.error !== "lockout" && retryCount < 3 && (
							<TouchableOpacity
								onPress={handleRetry}
								className="mb-3 w-full flex-row items-center justify-center rounded-lg bg-primary py-4"
							>
								<RefreshCw size={20} color="#fff" />
								<Text className="ml-2 font-semibold text-primary-foreground">
									Try Again
								</Text>
							</TouchableOpacity>
						)}
						<TouchableOpacity
							onPress={handleUsePassword}
							className="w-full rounded-lg border border-input py-4"
						>
							<Text className="text-center font-medium text-foreground">
								Use Password Instead
							</Text>
						</TouchableOpacity>
					</View>
				</>
			);
		}

		// Default state - ready to authenticate
		return (
			<>
				<View className="mb-6 h-20 w-20 items-center justify-center rounded-full bg-blue-100">
					{getBiometricIcon()}
				</View>
				<Text className="mb-2 text-center font-bold text-foreground text-xl">
					{biometricType || "Biometric"} Required
				</Text>
				<Text className="mb-6 text-center text-muted">
					Use {biometricType || "biometric"} to unlock your vault
				</Text>
				<View className="w-full space-y-3">
					<TouchableOpacity
						onPress={handleAuthenticate}
						className="mb-3 w-full flex-row items-center justify-center rounded-lg bg-primary py-4"
					>
						<Fingerprint size={20} color="#fff" />
						<Text className="ml-2 font-semibold text-primary-foreground">
							Authenticate
						</Text>
					</TouchableOpacity>
					<TouchableOpacity
						onPress={handleUsePassword}
						className="w-full rounded-lg border border-input py-4"
					>
						<Text className="text-center font-medium text-foreground">
							Use Password Instead
						</Text>
					</TouchableOpacity>
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
				<View className="w-full max-w-sm items-center rounded-2xl bg-background p-6">
					{renderContent()}
				</View>
			</View>
		</Modal>
	);
}
