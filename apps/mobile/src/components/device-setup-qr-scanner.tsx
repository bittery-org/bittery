import {
	type ParsedDeviceSetupPayload,
	parseDeviceSetupUri,
} from "@bittery/shared";
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
import { useI18n } from "@/providers/i18n-provider";

interface DeviceSetupQrScannerProps {
	visible: boolean;
	onClose: () => void;
	onScanSuccess: (data: ParsedDeviceSetupPayload) => void;
}

export function DeviceSetupQrScanner({
	visible,
	onClose,
	onScanSuccess,
}: DeviceSetupQrScannerProps) {
	const { m } = useI18n();
	const [permission, requestPermission] = useCameraPermissions();
	const [torchEnabled, setTorchEnabled] = useState(false);
	const [isProcessing, setIsProcessing] = useState(false);

	const handleBarcodeScanned = useCallback(
		({ data }: { data: string }) => {
			if (isProcessing) return;
			setIsProcessing(true);

			try {
				const parsed = parseDeviceSetupUri(data);

				if (!parsed.secretKey) {
					Alert.alert(
						m.device_setup_scanner_invalid_qr_title(),
						m.device_setup_scanner_invalid_qr_no_secret_key(),
						[
							{
								text: m.device_setup_scanner_try_again(),
								onPress: () => setIsProcessing(false),
							},
							{
								text: m.device_setup_scanner_cancel(),
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

				onScanSuccess(parsed);
				setIsProcessing(false);
				onClose();
			} catch (error) {
				console.error("Error parsing setup QR code:", error);
				Alert.alert(
					m.device_setup_scanner_invalid_qr_title(),
					m.device_setup_scanner_invalid_qr_error(),
					[
						{
							text: m.device_setup_scanner_try_again(),
							onPress: () => setIsProcessing(false),
						},
						{
							text: m.device_setup_scanner_cancel(),
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
		[isProcessing, m, onClose, onScanSuccess],
	);

	const handleRequestClose = () => {
		setIsProcessing(false);
		setTorchEnabled(false);
		onClose();
	};

	if (!permission) {
		return (
			<Modal
				visible={visible}
				animationType="slide"
				presentationStyle="pageSheet"
				onRequestClose={handleRequestClose}
			>
				<View className="flex-1 items-center justify-center bg-background">
					<Text className="text-foreground">
						{m.device_setup_scanner_loading()}
					</Text>
				</View>
			</Modal>
		);
	}

	if (!permission.granted) {
		return (
			<Modal
				visible={visible}
				animationType="slide"
				presentationStyle="pageSheet"
				onRequestClose={handleRequestClose}
			>
				<View className="flex-1 bg-background">
					<View className="flex-row items-center justify-between px-4 py-4">
						<View className="flex-row items-center">
							<Camera size={24} color="#6b7280" />
							<Text className="ml-2 font-bold text-foreground text-xl">
								{m.device_setup_scanner_title()}
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
							{m.device_setup_scanner_permission_title()}
						</Text>
						<Text className="mb-6 text-center text-muted">
							{m.device_setup_scanner_permission_description()}
						</Text>
						<TouchableOpacity
							onPress={requestPermission}
							className="w-full rounded-lg bg-primary py-4"
						>
							<Text className="text-center font-semibold text-primary-foreground">
								{m.device_setup_scanner_allow_camera()}
							</Text>
						</TouchableOpacity>
						<TouchableOpacity
							onPress={handleRequestClose}
							className="mt-4 w-full rounded-lg border border-border py-4"
						>
							<Text className="text-center font-semibold text-foreground">
								{m.device_setup_scanner_cancel()}
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
				<CameraView
					style={StyleSheet.absoluteFillObject}
					facing="back"
					enableTorch={torchEnabled}
					barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
					onBarcodeScanned={isProcessing ? undefined : handleBarcodeScanned}
				/>

				<View className="flex-1">
					<View className="flex-row items-center justify-between bg-black/50 px-4 py-4 pt-12">
						<TouchableOpacity
							onPress={handleRequestClose}
							className="rounded-full bg-black/50 p-2"
						>
							<X size={24} color="#fff" />
						</TouchableOpacity>
						<Text className="font-bold text-lg text-white">
							{m.device_setup_scanner_title()}
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

					<View className="flex-1 items-center justify-center">
						<View className="relative h-64 w-64">
							<View className="absolute top-0 left-0 h-8 w-8 rounded-tl-lg border-white border-t-4 border-l-4" />
							<View className="absolute top-0 right-0 h-8 w-8 rounded-tr-lg border-white border-t-4 border-r-4" />
							<View className="absolute bottom-0 left-0 h-8 w-8 rounded-bl-lg border-white border-b-4 border-l-4" />
							<View className="absolute right-0 bottom-0 h-8 w-8 rounded-br-lg border-white border-r-4 border-b-4" />
						</View>
					</View>

					<View className="bg-black/50 px-6 py-8">
						<Text className="text-center text-base text-white">
							{m.device_setup_scanner_footer()}
						</Text>
					</View>
				</View>
			</View>
		</Modal>
	);
}
