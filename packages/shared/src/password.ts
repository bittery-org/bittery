/**
 * Client-Side Cryptography Utilities
 * Unique utilities not available in @bittery/crypto
 */

export interface PasswordOptions {
	length?: number;
	lowercase?: boolean;
	uppercase?: boolean;
	numbers?: boolean;
	symbols?: boolean;
}

/**
 * Generate a secure random password
 */
export function generatePassword(options: PasswordOptions = {}): string {
	const {
		length = 20,
		lowercase = true,
		uppercase = true,
		numbers = true,
		symbols = true,
	} = options;

	const lowercaseChars = "abcdefghijklmnopqrstuvwxyz";
	const uppercaseChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
	const numberChars = "0123456789";
	const symbolChars = "!@#$%^&*()_+-=[]{}|;:,.<>?";

	let allChars = "";
	const requiredChars: string[] = [];
	const charSets: string[] = [];

	if (lowercase) {
		allChars += lowercaseChars;
		charSets.push(lowercaseChars);
	}
	if (uppercase) {
		allChars += uppercaseChars;
		charSets.push(uppercaseChars);
	}
	if (numbers) {
		allChars += numberChars;
		charSets.push(numberChars);
	}
	if (symbols) {
		allChars += symbolChars;
		charSets.push(symbolChars);
	}

	// Need at least one character set
	if (allChars.length === 0) {
		allChars = lowercaseChars + uppercaseChars + numberChars + symbolChars;
		charSets.push(lowercaseChars, uppercaseChars, numberChars, symbolChars);
	}

	const randomValues = new Uint8Array(length + charSets.length);
	crypto.getRandomValues(randomValues);

	// Ensure at least one character from each enabled character set
	for (let i = 0; i < charSets.length; i++) {
		const charSet = charSets[i];
		const val = randomValues[i];
		if (charSet && val !== undefined) {
			requiredChars.push(charSet[val % charSet.length] ?? "");
		}
	}

	// Fill the rest randomly from all allowed characters
	for (let i = requiredChars.length; i < length; i++) {
		const val = randomValues[i];
		if (val !== undefined) {
			requiredChars.push(allChars[val % allChars.length] ?? "");
		}
	}

	// Shuffle the password
	for (let i = requiredChars.length - 1; i > 0; i--) {
		const val = randomValues[charSets.length + i];
		if (val !== undefined) {
			const j = val % (i + 1);
			const temp = requiredChars[i];
			const tempJ = requiredChars[j];
			if (temp !== undefined && tempJ !== undefined) {
				requiredChars[i] = tempJ;
				requiredChars[j] = temp;
			}
		}
	}

	return requiredChars.join("");
}

/**
 * Copy text to clipboard with auto-clear
 */
export async function copyToClipboard(
	text: string,
	autoClearMs = 30000,
): Promise<void> {
	await navigator.clipboard.writeText(text);

	if (autoClearMs > 0) {
		setTimeout(() => {
			navigator.clipboard.writeText("").catch(() => {
				// Ignore errors when clearing
			});
		}, autoClearMs);
	}
}
