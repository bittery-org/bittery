/**
 * Chrome over a windowed barcode scan: back, a viewfinder, and a line that
 * says to point the camera at a QR code. The plugin itself draws no UI.
 */

import { IconArrowLeft } from "@bittery/ui/icons";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { presentSheet } from "@/lib/sheet-presence";
import { BarButton } from "./pressable";
import { QR_SCANNER_OVERLAY_CLASS, setQrScanningMode } from "./qr-scanner-mode";
import { iconClass } from "./theme";

export { waitForScannerOverlayPaint } from "./qr-scanner-mode";

interface QrScannerOverlayProps {
	open: boolean;
	title: string;
	instruction: string;
	backLabel: string;
	onCancel: () => void;
}

export function QrScannerOverlay({
	open,
	title,
	instruction,
	backLabel,
	onCancel,
}: QrScannerOverlayProps) {
	const onCancelRef = useRef(onCancel);
	onCancelRef.current = onCancel;

	/*
	 * Same exception as MobileSheet: this has to talk to the document class
	 * and Android's back button, which live outside React.
	 */
	useEffect(() => {
		if (!open) return;

		setQrScanningMode(true);
		const release = presentSheet(() => onCancelRef.current());

		return () => {
			release();
			setQrScanningMode(false);
		};
	}, [open]);

	if (!open) return null;

	return createPortal(
		<div
			className={`${QR_SCANNER_OVERLAY_CLASS} fixed inset-0 z-[80] flex flex-col`}
			role="dialog"
			aria-modal="true"
			aria-labelledby="qr-scanner-title"
		>
			<header className="relative z-10 flex items-center gap-1 px-2 pt-[max(0.5rem,var(--safe-top))] pb-2">
				<BarButton onClick={onCancel} aria-label={backLabel}>
					<IconArrowLeft className={iconClass.bar} />
				</BarButton>
				<h2
					id="qr-scanner-title"
					className="min-w-0 flex-1 truncate pr-11 text-center font-semibold text-base"
				>
					{title}
				</h2>
			</header>

			<div className="relative flex min-h-0 flex-1 items-center justify-center px-10">
				<div className="qr-scanner-frame relative aspect-square w-full max-w-72">
					<span className="qr-scanner-corner qr-scanner-corner-tl" />
					<span className="qr-scanner-corner qr-scanner-corner-tr" />
					<span className="qr-scanner-corner qr-scanner-corner-bl" />
					<span className="qr-scanner-corner qr-scanner-corner-br" />
				</div>
			</div>

			<p className="relative z-10 px-8 pt-4 pb-[max(1.5rem,var(--safe-bottom))] text-center text-sm opacity-90">
				{instruction}
			</p>
		</div>,
		document.body,
	);
}
