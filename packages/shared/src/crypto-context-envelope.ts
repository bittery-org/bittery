export interface EncryptionContextEnvelopeInput {
	vaultId: string;
	entityId: string;
	entityType:
		| "item"
		| "attachment_name"
		| "attachment_content_type"
		| "attachment_blob";
	version: number;
	userId: string;
}

const CONTEXT_ENVELOPE_MARKER = "bittery-context-envelope-v1";

interface ContextEnvelope {
	marker: typeof CONTEXT_ENVELOPE_MARKER;
	context: string;
	payload: string;
}

/**
 * Deterministically serialize an encryption context.
 */
export function serializeEncryptionContext(
	context: EncryptionContextEnvelopeInput,
): string {
	return [
		context.vaultId,
		context.entityId,
		context.entityType,
		String(context.version),
		context.userId,
	].join("\0");
}

/**
 * Wrap plaintext with context metadata before encryption.
 * This enforces semantic binding even on crypto backends that only expose
 * two-argument encrypt/decrypt operations.
 */
export function wrapPlaintextWithContext(
	plaintext: string,
	context: EncryptionContextEnvelopeInput,
): string {
	const envelope: ContextEnvelope = {
		marker: CONTEXT_ENVELOPE_MARKER,
		context: serializeEncryptionContext(context),
		payload: plaintext,
	};
	return JSON.stringify(envelope);
}

/**
 * Unwrap and verify context-bound plaintext after decryption.
 */
export function unwrapPlaintextWithContext(
	decrypted: string,
	context: EncryptionContextEnvelopeInput,
): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(decrypted);
	} catch {
		throw new Error("Missing encryption context envelope");
	}

	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!Object.prototype.hasOwnProperty.call(parsed, "marker") ||
		!Object.prototype.hasOwnProperty.call(parsed, "context") ||
		!Object.prototype.hasOwnProperty.call(parsed, "payload")
	) {
		throw new Error("Invalid encryption context envelope");
	}

	const envelope = parsed as ContextEnvelope;
	if (envelope.marker !== CONTEXT_ENVELOPE_MARKER) {
		throw new Error("Invalid encryption context marker");
	}

	if (envelope.context !== serializeEncryptionContext(context)) {
		throw new Error("Encryption context mismatch");
	}

	return envelope.payload;
}
