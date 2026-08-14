import {
	type ParsedDeviceSetupPayload,
	parseDeviceSetupUri,
} from "@bittery/shared/device-setup";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useCallback, useState } from "react";
import { Alert, Modal, StyleSheet, View } from "react-native";
import {
	ScannerLoading,
	ScannerOverlay,
	ScannerPermission,
} from "@/components/scanner-shell";
import { useI18n } from "@/providers/i18n-provider";

interface DeviceSetupQrScannerProps {
	visible: boolean;
	onClose: () => void;
	onScanSuccess: (data: ParsedDeviceSetupPayload) => void;
}

/**
 * Reads the device-setup QR the desktop and web apps show, so a full sign-in on
 * a new device does not mean typing a Secret Key by hand.
 */
export function DeviceSetupQrScanner({
	visible,
	onClose,
	onScanSuccess,
}: DeviceSetupQrScannerProps) {
	const { m } = useI18n();
	const [permission, requestPermission] = useCameraPermissions();
	const [isTorchEnabled, setIsTorchEnabled] = useState(false);
	const [isProcessing, setIsProcessing] = useState(false);

	const handleBarcodeScanned = useCallback(
		({ data }: { data: string }) => {
			if (isProcessing) return;
			setIsProcessing(true);

			const retryActions = [
				{
					text: m.device_setup_scanner_try_again(),
					onPress: () => setIsProcessing(false),
				},
				{
					text: m.device_setup_scanner_cancel(),
					style: "cancel" as const,
					onPress: () => {
						setIsProcessing(false);
						onClose();
					},
				},
			];

			try {
				const parsed = parseDeviceSetupUri(data);

				if (!parsed.secretKey) {
					Alert.alert(
						m.device_setup_scanner_invalid_qr_title(),
						m.device_setup_scanner_invalid_qr_no_secret_key(),
						retryActions,
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
					retryActions,
				);
			}
		},
		[isProcessing, m, onClose, onScanSuccess],
	);

	const handleRequestClose = () => {
		setIsProcessing(false);
		setIsTorchEnabled(false);
		onClose();
	};

	if (!permission) {
		return (
			<Modal
				visible={visible}
				animationType="slide"
				presentationStyle="fullScreen"
				onRequestClose={handleRequestClose}
			>
				<ScannerLoading
					title={m.device_setup_scanner_title()}
					label={m.device_setup_scanner_loading()}
					onClose={handleRequestClose}
				/>
			</Modal>
		);
	}

	if (!permission.granted) {
		return (
			<Modal
				visible={visible}
				animationType="slide"
				presentationStyle="fullScreen"
				onRequestClose={handleRequestClose}
			>
				<ScannerPermission
					title={m.device_setup_scanner_title()}
					heading={m.device_setup_scanner_permission_title()}
					description={m.device_setup_scanner_permission_description()}
					allowLabel={m.device_setup_scanner_allow_camera()}
					cancelLabel={m.device_setup_scanner_cancel()}
					onAllow={requestPermission}
					onClose={handleRequestClose}
				/>
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
					style={StyleSheet.absoluteFill}
					facing="back"
					enableTorch={isTorchEnabled}
					barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
					onBarcodeScanned={isProcessing ? undefined : handleBarcodeScanned}
				/>
				<ScannerOverlay
					title={m.device_setup_scanner_title()}
					instruction={m.device_setup_scanner_footer()}
					statusLabel={isProcessing ? m.mob_qr_scanner_processing() : null}
					isTorchEnabled={isTorchEnabled}
					onToggleTorch={() => setIsTorchEnabled((enabled) => !enabled)}
					onClose={handleRequestClose}
				/>
			</View>
		</Modal>
	);
}
