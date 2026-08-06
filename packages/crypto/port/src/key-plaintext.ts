import type { LegacyKeyEnvelope } from "./crypto-port";
import { CryptoPortError } from "./errors";

export function extractKeyPayload(
	plaintext: string,
	legacyEnvelope?: LegacyKeyEnvelope,
): string {
	if (!legacyEnvelope) {
		return plaintext;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(plaintext);
	} catch (cause) {
		throw new CryptoPortError(
			"invalid-input",
			"Invalid input: missing encryption context envelope.",
			{ cause },
		);
	}

	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("marker" in parsed) ||
		!("context" in parsed) ||
		!("payload" in parsed)
	) {
		throw new CryptoPortError(
			"invalid-input",
			"Invalid input: invalid encryption context envelope.",
		);
	}

	const envelope = parsed as {
		marker: unknown;
		context: unknown;
		payload: unknown;
	};
	if (
		envelope.marker !== legacyEnvelope.marker ||
		envelope.context !== legacyEnvelope.context ||
		typeof envelope.payload !== "string"
	) {
		throw new CryptoPortError(
			"invalid-input",
			"Invalid input: encryption context envelope mismatch.",
		);
	}

	return envelope.payload;
}
