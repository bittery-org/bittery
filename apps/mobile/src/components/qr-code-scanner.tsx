import {
	isValidBase32,
	type ParsedOtpAuthUri,
	parseOtpAuthUri,
} from "@bittery/shared/totp";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useCallback, useState } from "react";
import { Alert, Modal, StyleSheet, View } from "react-native";
import {
	ScannerLoading,
	ScannerOverlay,
	ScannerPermission,
} from "@/components/scanner-shell";
import { useI18n } from "@/providers/i18n-provider";

interface QrCodeScannerProps {
	visible: boolean;
	onClose: () => void;
	onScanSuccess: (data: ParsedOtpAuthUri) => void;
}

/**
 * Scans QR codes containing `otpauth://` URIs for TOTP setup: camera permission,
 * torch toggle, URI parsing and base32 validation of the scanned secret.
 */
export function QrCodeScanner({
	visible,
	onClose,
	onScanSuccess,
}: QrCodeScannerProps) {
	const { m } = useI18n();
	const [permission, requestPermission] = useCameraPermissions();
	const [isTorchEnabled, setIsTorchEnabled] = useState(false);
	const [isProcessing, setIsProcessing] = useState(false);

	const handleBarcodeScanned = useCallback(
		({ data }: { data: string }) => {
			// Prevent multiple scans while processing
			if (isProcessing) return;
			setIsProcessing(true);

			const retryActions = [
				{
					text: m.mob_qr_scanner_try_again(),
					onPress: () => setIsProcessing(false),
				},
				{
					text: m.mob_qr_scanner_cancel(),
					style: "cancel" as const,
					onPress: () => {
						setIsProcessing(false);
						onClose();
					},
				},
			];

			try {
				// Check if this is an otpauth:// URI
				if (!data.startsWith("otpauth://")) {
					Alert.alert(
						m.mob_qr_scanner_invalid_qr_title(),
						m.mob_qr_scanner_invalid_qr_message(),
						retryActions,
					);
					return;
				}

				// Parse the otpauth URI
				const parsed = parseOtpAuthUri(data);

				// Validate the secret is proper base32
				if (!isValidBase32(parsed.secret)) {
					Alert.alert(
						m.mob_qr_scanner_invalid_secret_title(),
						m.mob_qr_scanner_invalid_secret_message(),
						retryActions,
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
					m.mob_qr_scanner_error_title(),
					m.mob_qr_scanner_error_message(),
					retryActions,
				);
			}
		},
		[
			isProcessing,
			onClose,
			onScanSuccess,
			m.mob_qr_scanner_cancel,
			m.mob_qr_scanner_error_message,
			m.mob_qr_scanner_error_title,
			m.mob_qr_scanner_invalid_qr_message,
			m.mob_qr_scanner_invalid_qr_title,
			m.mob_qr_scanner_invalid_secret_message,
			m.mob_qr_scanner_invalid_secret_title,
			m.mob_qr_scanner_try_again,
		],
	);

	const handleRequestClose = () => {
		setIsProcessing(false);
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
					title={m.ext_qr_scan_title()}
					label={m.mob_qr_scanner_loading_camera()}
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
					title={m.ext_qr_scan_title()}
					heading={m.mob_qr_scanner_permission_title()}
					description={m.mob_qr_scanner_permission_description()}
					allowLabel={m.mob_qr_scanner_permission_allow()}
					cancelLabel={m.mob_qr_scanner_permission_cancel()}
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
					style={StyleSheet.absoluteFillObject}
					facing="back"
					enableTorch={isTorchEnabled}
					barcodeScannerSettings={{
						barcodeTypes: ["qr"],
					}}
					onBarcodeScanned={isProcessing ? undefined : handleBarcodeScanned}
				/>
				<ScannerOverlay
					title={m.ext_qr_scan_title()}
					instruction={m.mob_qr_scanner_instruction()}
					statusLabel={isProcessing ? m.mob_qr_scanner_processing() : null}
					isTorchEnabled={isTorchEnabled}
					onToggleTorch={() => setIsTorchEnabled((enabled) => !enabled)}
					onClose={handleRequestClose}
				/>
			</View>
		</Modal>
	);
}
