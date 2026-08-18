/**
 * Camera QR for the two codes this app actually reads:
 *
 * 1. An Authenticator `otpauth://` URI, scanned when the user picks that
 *    category in the create-item sheet. `packages/ui`'s `TotpForm` takes no
 *    scan slot, so we hand the parsed fields in as `initialData` and also
 *    write the URI to the clipboard for its mount-time auto-paste.
 * 2. A desktop/web "set up another device" `bittery://login?setup=1…` URI,
 *    scanned from the sign-in screen. That payload pre-fills email, server
 *    URL and Secret Key; the master password still has to be typed.
 *
 * `tauri-plugin-barcode-scanner`'s `scan` rejects unless camera permission
 * is already granted, so every path requests first.
 */

import {
	type ParsedDeviceSetupPayload,
	parseDeviceSetupUri,
} from "@bittery/shared/device-setup";
import {
	formatSecretForDisplay,
	isValidBase32,
	parseOtpAuthUri,
} from "@bittery/shared/totp";
import type { TotpAlgorithm, TotpDigits } from "@bittery/shared/types";
import {
	cancel,
	Format,
	requestPermissions,
	scan,
} from "@tauri-apps/plugin-barcode-scanner";

export class NotAnOtpAuthUriError extends Error {
	constructor() {
		super("Scanned code is not an otpauth:// URI");
		this.name = "NotAnOtpAuthUriError";
	}
}

export class InvalidTotpSecretError extends Error {
	constructor() {
		super("Scanned otpauth:// URI has an invalid (non-base32) secret");
		this.name = "InvalidTotpSecretError";
	}
}

export class CameraPermissionDeniedError extends Error {
	constructor() {
		super("Camera permission was denied");
		this.name = "CameraPermissionDeniedError";
	}
}

export class InvalidDeviceSetupQrError extends Error {
	constructor() {
		super("Scanned code is not a Bittery device setup QR");
		this.name = "InvalidDeviceSetupQrError";
	}
}

export interface ScannedTotpSetup {
	/** The raw `otpauth://` URI, already written to the clipboard. */
	uri: string;
	secret: string;
	issuer?: string;
	accountName?: string;
	algorithm?: TotpAlgorithm;
	digits?: TotpDigits;
	period?: number;
}

export interface TotpFormPrefill {
	title: string;
	totpSecret: string;
	totpIssuer?: string;
	totpAccountName?: string;
	totpAlgorithm?: TotpAlgorithm;
	totpDigits?: TotpDigits;
	totpPeriod?: number;
}

/** Tauri invoke rejections are often `{ message }` objects, not `Error`s. */
export function formatScanError(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	if (
		error !== null &&
		typeof error === "object" &&
		"message" in error &&
		typeof error.message === "string"
	) {
		return error.message;
	}
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

export function isScanCancelled(error: unknown): boolean {
	return formatScanError(error).toLowerCase() === "cancelled";
}

async function scanQrContent(): Promise<string> {
	const permission = await requestPermissions();
	if (permission !== "granted") {
		throw new CameraPermissionDeniedError();
	}

	// `windowed: true` puts the camera *under* a transparent WebView so the
	// overlay can paint a back button, a frame and an instruction. `false`
	// covers the WebView completely — no chrome, only the system Back key.
	const result = await scan({ windowed: true, formats: [Format.QRCode] });
	return result.content;
}

/** Rejects the in-flight `scan()` so the overlay's Back control can close it. */
export function cancelActiveScan(): Promise<void> {
	return cancel();
}

/**
 * Opens the camera, scans a single QR, and returns a TOTP setup.
 *
 * Throws `CameraPermissionDeniedError` if the user refuses the camera prompt,
 * `NotAnOtpAuthUriError` / `InvalidTotpSecretError` for a scanned-but-wrong
 * code, and whatever `scan()` itself throws for a cancelled scan.
 */
export async function scanTotpSetupToClipboard(): Promise<ScannedTotpSetup> {
	const content = await scanQrContent();

	if (!content.startsWith("otpauth://")) {
		throw new NotAnOtpAuthUriError();
	}

	const parsed = parseOtpAuthUri(content);
	if (!isValidBase32(parsed.secret)) {
		throw new InvalidTotpSecretError();
	}

	await navigator.clipboard.writeText(content);

	return {
		uri: content,
		secret: parsed.secret,
		issuer: parsed.issuer,
		accountName: parsed.accountName,
		algorithm: parsed.algorithm,
		digits: parsed.digits,
		period: parsed.period,
	};
}

export function totpFormPrefillFromScan(
	scanned: ScannedTotpSetup,
): TotpFormPrefill {
	const title =
		scanned.issuer && scanned.accountName
			? `${scanned.issuer} (${scanned.accountName})`
			: (scanned.issuer ?? scanned.accountName ?? "");

	return {
		title,
		totpSecret: formatSecretForDisplay(scanned.secret),
		totpIssuer: scanned.issuer,
		totpAccountName: scanned.accountName,
		totpAlgorithm: scanned.algorithm,
		totpDigits: scanned.digits,
		totpPeriod: scanned.period,
	};
}

/**
 * Opens the camera and reads a desktop/web device-setup QR
 * (`bittery://login?setup=1…`). A payload without a Secret Key is still
 * valid — the sign-in form keeps that field so the user can type it.
 */
export async function scanDeviceSetupQr(): Promise<ParsedDeviceSetupPayload> {
	const content = await scanQrContent();
	try {
		return parseDeviceSetupUri(content);
	} catch {
		throw new InvalidDeviceSetupQrError();
	}
}
