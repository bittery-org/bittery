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
