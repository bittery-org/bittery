/**
 * Secret Key Generation
 * Generates a 1Password-style Secret Key in format: A3-XXXXXX-XXXXXX-XXXXX-XXXXX-XXXXX
 */

const CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // Base32 without confusing chars

/**
 * Generate a cryptographically secure Secret Key
 * Format: A3-XXXXXX-XXXXXX-XXXXX-XXXXX-XXXXX (34 characters including dashes)
 */
export function generateSecretKey(): string {
	const segments = [
		"A3", // Version prefix
		generateSegment(6),
		generateSegment(6),
		generateSegment(5),
		generateSegment(5),
		generateSegment(5),
	];
	return segments.join("-");
}

/**
 * Generate a random segment of specified length
 */
function generateSegment(length: number): string {
	const randomBytes = new Uint8Array(length);
	crypto.getRandomValues(randomBytes);

	let segment = "";
	for (let i = 0; i < length; i++) {
		const byte = randomBytes[i];
		if (byte !== undefined) {
			segment += CHARSET[byte % CHARSET.length];
		}
	}
	return segment;
}

/**
 * Validate Secret Key format
 */
export function validateSecretKey(secretKey: string): boolean {
	const pattern =
		/^A3-[A-Z2-7]{6}-[A-Z2-7]{6}-[A-Z2-7]{5}-[A-Z2-7]{5}-[A-Z2-7]{5}$/;
	return pattern.test(secretKey);
}

/**
 * Get Secret Key hint (first segment for UX)
 */
export function getSecretKeyHint(secretKey: string): string {
	const parts = secretKey.split("-");
	return parts.length >= 2 ? `${parts[0]}-${parts[1]}` : "";
}
