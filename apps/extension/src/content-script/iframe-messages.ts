import { z } from "zod";

export {
	appendNonceToIframeSrc,
	createIframeNonce,
	getIframeNonceFromLocation,
} from "../lib/iframe-nonce";

const iframeNonceSchema = z.string().min(1).max(128);

export const resizeIframeMessageSchema = z
	.object({
		type: z.literal("RESIZE_IFRAME"),
		height: z.number().positive().max(4096),
		nonce: iframeNonceSchema,
	})
	.strict();

export const saveIframeReadyMessageSchema = z
	.object({
		type: z.literal("SAVE_IFRAME_READY"),
		nonce: iframeNonceSchema,
	})
	.strict();

export const saveCredentialMessageSchema = z
	.object({
		type: z.literal("SAVE_CREDENTIAL"),
		vaultId: z.string().min(1),
		username: z.string(),
		password: z.string(),
		url: z.string(),
		nonce: iframeNonceSchema,
	})
	.strict();

export const updateExistingCredentialMessageSchema = z
	.object({
		type: z.literal("UPDATE_EXISTING_CREDENTIAL"),
		itemId: z.string().min(1),
		vaultId: z.string().min(1),
		username: z.string(),
		password: z.string(),
		url: z.string(),
		nonce: iframeNonceSchema,
	})
	.strict();

/** Sent by an overlay's locked / re-auth state when the user asks to sign in. */
export const openPopupMessageSchema = z
	.object({
		type: z.literal("OPEN_POPUP"),
		nonce: iframeNonceSchema,
	})
	.strict();

/**
 * Sent by an overlay's desktop-locked state. The popup can't resolve a locked
 * desktop app, so this asks the desktop to raise its own unlock screen instead.
 */
export const unlockDesktopMessageSchema = z
	.object({
		type: z.literal("UNLOCK_DESKTOP"),
		nonce: iframeNonceSchema,
	})
	.strict();

export const cancelSaveMessageSchema = z
	.object({
		type: z.literal("CANCEL_SAVE"),
		nonce: iframeNonceSchema,
	})
	.strict();

export function createAutofillReadySchema(readyMessageType: string) {
	return z
		.object({
			type: z.literal(readyMessageType),
			nonce: iframeNonceSchema,
		})
		.strict();
}

export function createAutofillSelectSchema(selectMessageType: string) {
	return z
		.object({
			type: z.literal(selectMessageType),
			item: z.unknown(),
			nonce: iframeNonceSchema,
		})
		.strict();
}

export function createAutofillFilterSchema(filterMessageType: string) {
	return z
		.object({
			type: z.literal(filterMessageType),
			query: z.string(),
			nonce: iframeNonceSchema,
		})
		.strict();
}

export function validateIframeMessage<T extends { nonce: string }>(
	event: Pick<MessageEvent, "source" | "origin" | "data">,
	options: {
		expectedSource: Window | null;
		expectedOrigin: string;
		schema: z.ZodType<T>;
		expectedNonce: string;
	},
): T | null {
	if (event.source !== options.expectedSource) {
		return null;
	}

	if (event.origin !== options.expectedOrigin) {
		return null;
	}

	const result = options.schema.safeParse(event.data);
	if (!result.success) {
		return null;
	}

	if (result.data.nonce !== options.expectedNonce) {
		return null;
	}

	return result.data;
}
