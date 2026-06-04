/**
 * QR Code Scanner Component
 * Scans the current browser tab for TOTP QR codes
 */

import type { ParsedOtpAuthUri } from "@bittery/shared/totp";
import { isValidBase32, parseOtpAuthUri } from "@bittery/shared/totp";
import { Button, Card, toast } from "@bittery/ui";
import {
	IconCameraOutlineDuo18,
	IconCircleCheck2OutlineDuo18,
	IconCircleWarningOutlineDuo18,
	IconLoader2OutlineDuo18,
	IconQrcodeOutlineDuo18,
	IconScanOutlineDuo18,
	IconXmarkOutlineDuo18,
} from "@bittery/ui/icons";
import jsQR from "jsqr";
import { useCallback, useState } from "react";
import { useI18n } from "@/providers/i18n-provider";

export type ScanStatus =
	| "idle"
	| "scanning"
	| "success"
	| "error"
	| "no-qr-found"
	| "multiple-qr-found";

export interface QRScanResult {
	status: ScanStatus;
	data?: ParsedOtpAuthUri;
	rawUri?: string;
	error?: string;
	qrCodesFound?: number;
}

interface QRScannerProps {
	onScanComplete: (result: QRScanResult) => void;
	onCancel: () => void;
}

/**
 * Captures the visible area of the current tab and scans for QR codes
 */
async function captureAndScanTab(): Promise<QRScanResult> {
	return new Promise((resolve) => {
		// Request the background script to capture the tab
		chrome.runtime.sendMessage(
			{ type: "CAPTURE_TAB_SCREENSHOT" },
			async (response) => {
				if (!response?.success || !response.dataUrl) {
					resolve({
						status: "error",
						error: response?.error || "Failed to capture tab screenshot",
					});
					return;
				}

				try {
					// Load the image from the data URL
					const img = new Image();
					img.crossOrigin = "anonymous";

					await new Promise<void>((imgResolve, imgReject) => {
						img.onload = () => imgResolve();
						img.onerror = () =>
							imgReject(new Error("Failed to load captured image"));
						img.src = response.dataUrl;
					});

					// Create canvas to get image data
					const canvas = document.createElement("canvas");
					const ctx = canvas.getContext("2d");

					if (!ctx) {
						resolve({
							status: "error",
							error: "Failed to create canvas context",
						});
						return;
					}

					canvas.width = img.width;
					canvas.height = img.height;
					ctx.drawImage(img, 0, 0);

					// Get image data for QR scanning
					const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

					// Scan for QR codes using jsQR
					const qrCode = jsQR(
						imageData.data,
						imageData.width,
						imageData.height,
					);

					if (!qrCode) {
						resolve({
							status: "no-qr-found",
							error: "No QR code found on the page",
						});
						return;
					}

					const rawData = qrCode.data;

					// Validate that it's an otpauth URI
					if (!rawData.startsWith("otpauth://")) {
						resolve({
							status: "error",
							error:
								"QR code found but it is not a valid TOTP code (expected otpauth:// format)",
						});
						return;
					}

					// Parse the otpauth URI
					try {
						const parsed = parseOtpAuthUri(rawData);

						// Validate the secret is valid base32
						if (!isValidBase32(parsed.secret)) {
							resolve({
								status: "error",
								error: "QR code contains an invalid TOTP secret",
							});
							return;
						}

						resolve({
							status: "success",
							data: parsed,
							rawUri: rawData,
						});
					} catch (parseError: any) {
						resolve({
							status: "error",
							error: `Invalid TOTP QR code: ${parseError.message}`,
						});
					}
				} catch (error: any) {
					resolve({
						status: "error",
						error: `Failed to scan QR code: ${error.message}`,
					});
				}
			},
		);
	});
}

export function QRScanner({ onScanComplete, onCancel }: QRScannerProps) {
	const { m } = useI18n();
	const [status, setStatus] = useState<ScanStatus>("idle");
	const [errorMessage, setErrorMessage] = useState<string>("");
	const [scanResult, setScanResult] = useState<ParsedOtpAuthUri | null>(null);

	const handleScan = useCallback(async () => {
		setStatus("scanning");
		setErrorMessage("");
		setScanResult(null);

		try {
			const result = await captureAndScanTab();

			if (result.status === "success" && result.data) {
				setStatus("success");
				setScanResult(result.data);
				onScanComplete(result);
			} else {
				setStatus(result.status);
				setErrorMessage(result.error || m.ext_qr_error_scan_toast());

				// Only call onScanComplete for success - let user retry or cancel for errors
				if (result.status === "error") {
				toast.error(result.error || m.ext_qr_error_scan_toast());
				}
			}
		} catch (error: any) {
			setStatus("error");
			setErrorMessage(error.message || m.ext_qr_error_scan_toast());
			toast.error(m.ext_qr_error_scan_toast());
		}
	}, [onScanComplete]);

	const handleRetry = useCallback(() => {
		setStatus("idle");
		setErrorMessage("");
		setScanResult(null);
	}, []);

	return (
		<Card className="p-4">
			<div className="mb-4 flex items-center justify-between">
				<div className="flex items-center gap-2">
					<IconQrcodeOutlineDuo18 className="h-5 w-5 text-primary" />
					<h3 className="font-medium text-sm">{m.ext_qr_scan_title()}</h3>
				</div>
				<Button
					size="icon"
					variant="ghost"
					onClick={onCancel}
					className="h-8 w-8"
				>
					<IconXmarkOutlineDuo18 className="h-4 w-4" />
				</Button>
			</div>

			{status === "idle" && (
				<div className="space-y-3">
					<p className="text-muted-foreground text-xs">
						Make sure the TOTP QR code is visible on the current page, then
						click scan.
					</p>
					<Button
						onClick={handleScan}
						className="w-full gap-2"
						variant="default"
					>
						<IconScanOutlineDuo18 className="h-4 w-4" />
					{m.ext_qr_scan_button()}
					</Button>
				</div>
			)}

			{status === "scanning" && (
				<div className="flex flex-col items-center gap-3 py-4">
					<IconLoader2OutlineDuo18 className="h-8 w-8 animate-spin text-primary" />
					<p className="text-muted-foreground text-sm">
						{m.ext_qr_scanning()}
					</p>
				</div>
			)}

			{status === "success" && scanResult && (
				<div className="space-y-3">
					<div className="flex items-center gap-2 text-green-600">
						<IconCircleCheck2OutlineDuo18 className="h-5 w-5" />
						<span className="font-medium text-sm">{m.ext_qr_found()}</span>
					</div>
					{scanResult.issuer && (
						<p className="text-sm">
							<span className="text-muted-foreground">{m.ext_qr_service()}</span>{" "}
							{scanResult.issuer}
						</p>
					)}
					{scanResult.accountName && (
						<p className="text-sm">
							<span className="text-muted-foreground">{m.ext_qr_account()}</span>{" "}
							{scanResult.accountName}
						</p>
					)}
				</div>
			)}

			{(status === "error" || status === "no-qr-found") && (
				<div className="space-y-3">
					<div className="flex items-center gap-2 text-destructive">
						<IconCircleWarningOutlineDuo18 className="h-5 w-5" />
						<span className="font-medium text-sm">
							{status === "no-qr-found" ? m.ext_qr_no_qr_found() : m.ext_qr_scan_failed()}
						</span>
					</div>
					<p className="text-muted-foreground text-xs">{errorMessage}</p>
					<div className="flex gap-2">
						<Button
							onClick={handleRetry}
							variant="outline"
							className="flex-1 gap-2"
						>
							<IconCameraOutlineDuo18 className="h-4 w-4" />
						{m.ext_qr_try_again()}
						</Button>
						<Button onClick={onCancel} variant="ghost" className="flex-1">
							{m.ext_qr_cancel()}
						</Button>
					</div>
				</div>
			)}
		</Card>
	);
}
