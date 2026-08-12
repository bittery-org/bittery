/**
 * The desktop↔extension protocol, as this side sees it.
 *
 * The request/response unions, the event payloads and the version pin are
 * **generated** from `apps/desktop/src-tauri/src/desktop_ipc.rs` — the only
 * definition of this wire format — and re-exported here under the names the
 * background scripts have always used (ADR 0012). Regenerate with
 * `pnpm -F desktop generate:bindings`.
 *
 * The import reaches into the desktop app because that is where ts-rs writes,
 * and it is type-only, so nothing about the extension bundle changes. Only this
 * file may reach across; everything else imports the protocol from here.
 *
 * What is still hand-written below is the extension's own vocabulary: the
 * normalised status it hands to its UI, the "the desktop is unlocking" sentinel,
 * and the mismatch error. None of those exist on the wire.
 */

import type {
	DesktopEvent,
	DesktopProtocolVersion,
	DesktopTheme,
	ProtocolEnvelope,
} from "../../../desktop/src/generated/desktop-ipc";

export type {
	DesktopAccountEntry,
	DesktopRequest,
	DesktopResponse,
	DesktopTheme,
} from "../../../desktop/src/generated/desktop-ipc";

/** Pinned on both ends; the annotation is what fails the build if Rust moves. */
export const DESKTOP_PROTOCOL_VERSION: DesktopProtocolVersion = 1;

/** A pushed event and its payload, correlated by the `event` tag. */
export type DesktopEventPayload = DesktopEvent;

/** The payload of one pushed desktop event, selected by its `event` tag. */
export type DesktopEventOf<E extends DesktopEvent["event"]> = Extract<
	DesktopEvent,
	{ event: E }
>["payload"];

/** Every frame in either direction carries the version and an optional id. */
export type DesktopEnvelope<T> = ProtocolEnvelope<T>;

/**
 * The desktop lock state as the extension keeps it: every field resolved, so a
 * reader never has to invent a timestamp or a default. `DESKTOP_STATUS` on the
 * wire leaves `theme` absent when the desktop app has not synced one yet.
 */
export interface DesktopStatus {
	available: boolean;
	locked: boolean;
	unlockedAccounts: string[];
	timestamp: number;
	autolockTimeoutMs: number;
	/** The desktop app's appearance setting; null when unknown. */
	theme: DesktopTheme | null;
}

/**
 * True when the desktop app is available, unlocked, and has at least one
 * unlocked account.
 *
 * Accepts a partial status because callers in the UI read it straight off a
 * `chrome.runtime.sendMessage` response, where every field may be absent.
 */
export function isDesktopStatusUnlocked(
	status: Partial<DesktopStatus> | null | undefined,
): boolean {
	return !!(
		status?.available &&
		!status.locked &&
		(status.unlockedAccounts?.length ?? 0) > 0
	);
}

/**
 * Status the background returns instead of unlocking when a connected desktop
 * app is locked — the desktop was asked to raise its own unlock screen (see
 * `desktop-unlock.ts`), and the popup waits for the pushed `DESKTOP_UNLOCKED`
 * event.
 */
export const PENDING_DESKTOP_UNLOCK = "pending-desktop-unlock" as const;

export class DesktopProtocolMismatchError extends Error {
	readonly expectedVersion: number;
	readonly receivedVersion: number | undefined;

	constructor(expectedVersion: number, receivedVersion: number | undefined) {
		super(
			`Desktop protocol mismatch (expected ${expectedVersion}, received ${receivedVersion ?? "missing"})`,
		);
		this.name = "DesktopProtocolMismatchError";
		this.expectedVersion = expectedVersion;
		this.receivedVersion = receivedVersion;
	}
}
