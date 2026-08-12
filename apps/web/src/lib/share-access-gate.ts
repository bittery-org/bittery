/**
 * Pure state machine for the public share-link page (`/share/$token`).
 *
 * The server consumes a share link (increments `access_count`, and for
 * one-time links flips it to `exhausted`) the moment `share.accessPublic`
 * or `share.verifyEmailAndAccess` succeeds. Neither call may therefore be
 * fired as a side effect of navigation: a plain page refresh would burn the
 * link, and under copy-once share links the owner cannot re-send it.
 *
 * This module decides which screen the recipient sees so that the consuming
 * call only ever happens behind a deliberate user action.
 */

export interface ShareLinkPublicInfo {
	valid: boolean;
	reason?: string | null;
	accessMode?: string | null;
	isOneTimeUse?: boolean | null;
	expiresAt?: string | null;
}

export type ShareLinkInfoStatus = "loading" | "error" | "ready";

export type ShareAccessStage =
	/** `share.getPublicInfo` is still in flight. */
	| "loading"
	/** `share.getPublicInfo` failed, or returned nothing. */
	| "link-not-found"
	/** The link is expired / revoked / exhausted / disabled. */
	| "link-unavailable"
	/** The URL fragment carrying the decryption key is absent. */
	| "missing-key"
	/** Access or decryption failed. */
	| "failed"
	/** The item has been decrypted and can be rendered. */
	| "revealed"
	/** The consuming call is in flight after an explicit user action. */
	| "revealing"
	/** Email-restricted link: the code-entry form is the explicit gate. */
	| "email-verification"
	/** Valid link, nothing consumed yet, waiting for the reveal click. */
	| "gate";

export interface ResolveShareAccessStageInput {
	linkInfoStatus: ShareLinkInfoStatus;
	linkInfo: ShareLinkPublicInfo | null | undefined;
	/** Whether the URL fragment supplied a decryption key. */
	hasShareKey: boolean;
	/** Whether a consuming API request is currently in flight. */
	revealPending: boolean;
	hasDecryptedItem: boolean;
	hasFailure: boolean;
}

/**
 * Resolves which screen to render. The ordering guarantees that no screen
 * capable of triggering a consuming API request is reachable while the link is
 * unusable (invalid, or missing its decryption key) — burning a link only to
 * then fail decryption is unrecoverable.
 */
export function resolveShareAccessStage({
	linkInfoStatus,
	linkInfo,
	hasShareKey,
	revealPending,
	hasDecryptedItem,
	hasFailure,
}: ResolveShareAccessStageInput): ShareAccessStage {
	if (linkInfoStatus === "loading") {
		return "loading";
	}

	if (linkInfoStatus === "error" || !linkInfo) {
		return "link-not-found";
	}

	if (!linkInfo.valid) {
		return "link-unavailable";
	}

	if (hasDecryptedItem) {
		return "revealed";
	}

	if (!hasShareKey) {
		return "missing-key";
	}

	if (hasFailure) {
		return "failed";
	}

	if (linkInfo.accessMode === "email-restricted") {
		return "email-verification";
	}

	if (revealPending) {
		return "revealing";
	}

	return "gate";
}

/**
 * A one-time link is spent by the first successful access, so the reveal
 * action needs to state that up front.
 */
export function isOneTimeShareLink(
	linkInfo: ShareLinkPublicInfo | null | undefined,
): boolean {
	return linkInfo?.isOneTimeUse === true;
}
