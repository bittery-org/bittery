/**
 * `apps/mobile`'s TOTP QR scanner (`src/components/qr-code-scanner.tsx`, wired into
 * `src/components/item-forms/totp-form.tsx`'s "Scan QR" button) opened `expo-camera`'s
 * `CameraView`, read the first `otpauth://` payload, and handed the parsed fields to
 * the TOTP form directly through a prop callback.
 *
 * The Tauri port cannot do the same hand-off: `packages/ui`'s `TotpInputSection` /
 * `TotpForm` (`create-item-sheet.tsx`'s step 2) are shared with desktop and web and
 * take no scan callback or slot — see the migration brief's constraint against editing
 * `packages/`. What they *do* already have is a clipboard auto-import: `TotpForm`
 * silently tries `navigator.clipboard.readText()` for an `otpauth://` URI on mount
 * (`packages/ui/src/components/vault/item-categories/totp-form.tsx`), and the "Paste"
 * button in `TotpInputSection` does the same on demand.
 *
 * So the scanner here writes the validated `otpauth://` URI to the clipboard through
 * the same bridge item-detail's copy buttons use (`../clipboard-bridge.ts`) and lets
 * that existing auto-paste do the rest once the user opens the Authenticator category.
 * It is a real, on-device-proven capability — just wired at the clipboard seam instead
 * of a form prop, because that seam is the only one on this side of the `packages/`
 * boundary.
 */

import { isValidBase32, parseOtpAuthUri } from "@bittery/shared/totp";
import { Format, scan } from "@tauri-apps/plugin-barcode-scanner";

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

export interface ScannedTotpSetup {
	/** The raw `otpauth://` URI, already written to the clipboard. */
	uri: string;
	issuer?: string;
	accountName?: string;
}

/**
 * Opens the camera, scans a single QR code, validates it as a TOTP `otpauth://` URI,
 * and writes it to the clipboard for the shared `TotpForm`'s auto-paste to pick up.
 *
 * Throws `NotAnOtpAuthUriError` / `InvalidTotpSecretError` for a scanned-but-wrong
 * code (mirrors the two `Alert.alert` branches in the Expo scanner), and whatever
 * `scan()` itself throws for a cancelled or permission-denied scan.
 */
export async function scanTotpSetupToClipboard(): Promise<ScannedTotpSetup> {
	const result = await scan({ windowed: false, formats: [Format.QRCode] });

	if (!result.content.startsWith("otpauth://")) {
		throw new NotAnOtpAuthUriError();
	}

	const parsed = parseOtpAuthUri(result.content);
	if (!isValidBase32(parsed.secret)) {
		throw new InvalidTotpSecretError();
	}

	await navigator.clipboard.writeText(result.content);

	return {
		uri: result.content,
		issuer: parsed.issuer,
		accountName: parsed.accountName,
	};
}
