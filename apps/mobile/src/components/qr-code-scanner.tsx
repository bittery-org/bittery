import {
	isValidBase32,
	type ParsedOtpAuthUri,
	parseOtpAuthUri,
} from "@bittery/shared/totp";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Camera, Flashlight, FlashlightOff, X } from "lucide-react-native";
import { useCallback, useState } from "react";
import {
	Alert,
	Modal,
	StyleSheet,
	Text,
	TouchableOpacity,
	View,
} from "react-native";

interface QrCodeScannerProps {
	visible: boolean;
	onClose: () => void;
	onScanSuccess: (data: ParsedOtpAuthUri) => void;
}

/**
 * QR Code Scanner Component
 *
 * Scans QR codes containing otpauth:// URIs for TOTP setup.
 * Supports:
 * - Camera permission handling
 * - Torch/flashlight toggle
 * - otpauth:// URI parsing
 * - Validation of scanned data
 */
export function QrCodeScanner({
	visible,
	onClose,
	onScanSuccess,
}: QrCodeScannerProps) {
	const [permission, requestPermission] = useCameraPermissions();
	const [torchEnabled, setTorchEnabled] = useState(false);
	const [isProcessing, setIsProcessing] = useState(false);

	const handleBarcodeScanned = useCallback(
		({ data }: { data: string }) => {
			// Prevent multiple scans while processing
			if (isProcessing) return;
			setIsProcessing(true);

			try {
				// Check if this is an otpauth:// URI
				if (!data.startsWith("otpauth://")) {
					Alert.alert(
						"Invalid QR Code",
						"This QR code doesn't contain TOTP data. Please scan a valid authenticator QR code.",
						[
							{
								text: "Try Again",
								onPress: () => setIsProcessing(false),
							},
							{
								text: "Cancel",
								style: "cancel",
								onPress: () => {
									setIsProcessing(false);
									onClose();
								},
							},
						],
					);
					return;
				}

				// Parse the otpauth URI
				const parsed = parseOtpAuthUri(data);

				// Validate the secret is proper base32
				if (!isValidBase32(parsed.secret)) {
					Alert.alert(
						"Invalid Secret",
						"The TOTP secret in this QR code is not valid. Please try scanning again or enter the secret manually.",
						[
							{
								text: "Try Again",
								onPress: () => setIsProcessing(false),
							},
							{
								text: "Cancel",
								style: "cancel",
								onPress: () => {
									setIsProcessing(false);
									onClose();
								},
							},
						],
					);
					return;
				}

				// Success! Pass the parsed data back
				onScanSuccess(parsed);
				setIsProcessing(false);
				onClose();
			} catch (error) {
				console.error("Error parsing QR code:", error);
				Alert.alert(
					"Scan Error",
					"Could not read the QR code. Please make sure you're scanning a valid TOTP QR code.",
					[
						{
							text: "Try Again",
							onPress: () => setIsProcessing(false),
						},
						{
							text: "Cancel",
							style: "cancel",
							onPress: () => {
								setIsProcessing(false);
								onClose();
							},
						},
					],
				);
			}
		},
		[isProcessing, onClose, onScanSuccess],
	);

	// Reset processing state when modal becomes visible
	const handleRequestClose = () => {
		setIsProcessing(false);
		onClose();
	};

	// Handle permission states
	if (!permission) {
		// Permissions are still loading
		return (
			<Modal
				visible={visible}
				animationType="slide"
				presentationStyle="pageSheet"
				onRequestClose={handleRequestClose}
			>
				<View className="flex-1 items-center justify-center bg-background">
					<Text className="text-foreground">Loading camera...</Text>
				</View>
			</Modal>
		);
	}

	if (!permission.granted) {
		// Permission not granted yet
		return (
			<Modal
				visible={visible}
				animationType="slide"
				presentationStyle="pageSheet"
				onRequestClose={handleRequestClose}
			>
				<View className="flex-1 bg-background">
					{/* Header */}
					<View className="flex-row items-center justify-between border-border border-b px-4 py-4">
						<View className="flex-row items-center">
							<Camera size={24} color="#6b7280" />
							<Text className="ml-2 font-bold text-foreground text-xl">
								Scan QR Code
							</Text>
						</View>
						<TouchableOpacity
							onPress={handleRequestClose}
							className="rounded-full bg-secondary p-2"
						>
							<X size={20} color="#6b7280" />
						</TouchableOpacity>
					</View>

					<View className="flex-1 items-center justify-center px-8">
						<View className="mb-6 h-20 w-20 items-center justify-center rounded-full bg-secondary">
							<Camera size={40} color="#6b7280" />
						</View>
						<Text className="mb-4 text-center font-semibold text-foreground text-lg">
							Camera Permission Required
						</Text>
						<Text className="mb-6 text-center text-muted">
							To scan TOTP QR codes, Bittery needs access to your camera. Your
							camera is only used for scanning and is not recorded.
						</Text>
						<TouchableOpacity
							onPress={requestPermission}
							className="w-full rounded-lg bg-primary py-4"
						>
							<Text className="text-center font-semibold text-primary-foreground">
								Allow Camera Access
							</Text>
						</TouchableOpacity>
						<TouchableOpacity
							onPress={handleRequestClose}
							className="mt-4 w-full rounded-lg border border-border py-4"
						>
							<Text className="text-center font-semibold text-foreground">
								Cancel
							</Text>
						</TouchableOpacity>
					</View>
				</View>
			</Modal>
		);
	}

	return (
		<Modal
			visible={visible}
			animationType="slide"
			presentationStyle="fullScreen"
			onRequestClose={handleRequestClose}
		>
			<View className="flex-1 bg-black">
				{/* Camera View */}
				<CameraView
					style={StyleSheet.absoluteFillObject}
					facing="back"
					enableTorch={torchEnabled}
					barcodeScannerSettings={{
						barcodeTypes: ["qr"],
					}}
					onBarcodeScanned={isProcessing ? undefined : handleBarcodeScanned}
				/>

				{/* Overlay */}
				<View className="flex-1">
					{/* Top overlay with controls */}
					<View className="flex-row items-center justify-between bg-black/50 px-4 py-4 pt-12">
						<TouchableOpacity
							onPress={handleRequestClose}
							className="rounded-full bg-black/50 p-2"
						>
							<X size={24} color="#fff" />
						</TouchableOpacity>
						<Text className="font-bold text-lg text-white">
							Scan TOTP QR Code
						</Text>
						<TouchableOpacity
							onPress={() => setTorchEnabled(!torchEnabled)}
							className="rounded-full bg-black/50 p-2"
						>
							{torchEnabled ? (
								<FlashlightOff size={24} color="#fff" />
							) : (
								<Flashlight size={24} color="#fff" />
							)}
						</TouchableOpacity>
					</View>

					{/* Center scanning area */}
					<View className="flex-1 items-center justify-center">
						{/* Scanning frame */}
						<View className="relative h-64 w-64">
							{/* Corner decorations */}
							<View className="absolute top-0 left-0 h-8 w-8 rounded-tl-lg border-white border-t-4 border-l-4" />
							<View className="absolute top-0 right-0 h-8 w-8 rounded-tr-lg border-white border-t-4 border-r-4" />
							<View className="absolute bottom-0 left-0 h-8 w-8 rounded-bl-lg border-white border-b-4 border-l-4" />
							<View className="absolute right-0 bottom-0 h-8 w-8 rounded-br-lg border-white border-r-4 border-b-4" />
						</View>
					</View>

					{/* Bottom instruction */}
					<View className="bg-black/50 px-4 py-6 pb-12">
						<Text className="text-center text-sm text-white">
							Position the QR code within the frame to scan
						</Text>
						{isProcessing && (
							<Text className="mt-2 text-center text-white/70 text-xs">
								Processing...
							</Text>
						)}
					</View>
				</View>
			</View>
		</Modal>
	);
}
