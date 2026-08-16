/**
 * `apps/mobile`'s `ShareItemSheet` (`src/components/share/share-item-sheet.tsx`) calls
 * React Native's `Share.share({ message: url, title })` once a share link has been
 * created, opening Android's cross-app share chooser on the link text.
 *
 * `packages/ui`'s `ShareItemDialog` (the desktop/web equivalent this app would reuse
 * for the "create a share link" flow) is copy-link-only — no native share affordance,
 * and it is off-limits to edit for the same reason `TotpForm` is (see
 * `barcode-scanner.ts`). Wiring `ShareItemDialog` into a vault item screen with a
 * native "Share" action is a feature this chunk does not build; what this module gives
 * that future wiring is the proven native primitive itself, via the first-party
 * `bittery-share` plugin (`src-tauri/plugins/share`) — verified from `/debug`.
 */
import { invoke } from "@tauri-apps/api/core";

export interface ShareTextArgs {
	text: string;
	title?: string;
}

/** Hands `text` to Android's `ACTION_SEND` chooser. Rejects with `Unsupported` off Android. */
export function shareText({ text, title }: ShareTextArgs): Promise<void> {
	return invoke("plugin:bittery-share|share_text", { text, title });
}

export interface ShareFileArgs {
	/** Base64 of the decrypted bytes. Base64 and not a byte array because the IPC is JSON. */
	base64Data: string;
	fileName: string;
	mimeType?: string;
	title?: string;
}

/**
 * The attachment-download path. Android has no "write this to the user's Downloads" API that
 * does not need a storage permission or a `MediaStore` insert, so the plugin writes the
 * plaintext to app-private cache and hands out a `content://` URI with a per-URI read grant —
 * exactly what `expo-sharing`'s `shareAsync` did for `apps/mobile`. "Save to Files" and "Save
 * to Drive" are entries in the chooser that opens.
 */
export function shareFile({
	base64Data,
	fileName,
	mimeType,
	title,
}: ShareFileArgs): Promise<void> {
	return invoke("plugin:bittery-share|share_file", {
		base64Data,
		fileName,
		mimeType,
		title,
	});
}
