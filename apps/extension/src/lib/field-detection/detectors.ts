import { getAllInputs } from "./dom";
import { shouldExcludeField } from "./exclusion";
import { detectFieldType } from "./field-type";
import type { CreditCardFieldType, DetectedField, IdentityFieldType } from "./types";

/**
 * Check if a field type is a credit card field
 */
export function isCreditCardFieldType(
	type: DetectedField["type"],
): type is CreditCardFieldType {
	return ["cardNumber", "cardExpiry", "cardCvv", "cardName"].includes(type);
}

/**
 * Check if a field type is an identity field
 */
export function isIdentityFieldType(
	type: DetectedField["type"],
): type is IdentityFieldType {
	return [
		"firstName",
		"lastName",
		"email",
		"phone",
		"street",
		"city",
		"state",
		"postalCode",
		"country",
		"dateOfBirth",
	].includes(type);
}

/**
 * Detect all credential-related fields in the document
 */
export function detectAllFields(
	root: Document | ShadowRoot = document,
): DetectedField[] {
	const fields: DetectedField[] = [];
	const allInputs = getAllInputs(root);

	for (const { input, shadowRoot } of allInputs) {
		// Skip hidden inputs
		if (input.type === "hidden") {
			continue;
		}

		// Skip submit/button types
		if (["submit", "button", "image", "reset", "file"].includes(input.type)) {
			continue;
		}

		// Skip checkbox/radio
		if (["checkbox", "radio"].includes(input.type)) {
			continue;
		}

		// Skip excluded fields (search, filter, etc.)
		if (shouldExcludeField(input)) {
			continue;
		}

		const { type, confidence } = detectFieldType(input, shadowRoot || document);

		// Increased minimum confidence threshold from 0.1 to 0.3 (30%)
		// This prevents false positives on generic text fields
		if (confidence >= 0.3) {
			const form = input.closest("form") as HTMLFormElement | undefined;
			fields.push({
				element: input,
				type,
				confidence,
				form: form || undefined,
				shadowRoot,
			});
		}
	}

	// Sort by confidence
	fields.sort((a, b) => b.confidence - a.confidence);

	return fields;
}

/**
 * Detect credential fields specifically (username/email/password)
 */
export function detectCredentialFields(
	root: Document | ShadowRoot = document,
): DetectedField[] {
	const allFields = detectAllFields(root);

	// Filter to credential-relevant types
	return allFields.filter((f) =>
		["username", "email", "password"].includes(f.type),
	);
}

/**
 * Detect credit card fields in the document
 */
export function detectCreditCardFields(
	root: Document | ShadowRoot = document,
): DetectedField[] {
	const allFields = detectAllFields(root);

	// Filter to credit card field types
	return allFields.filter((f) => isCreditCardFieldType(f.type));
}

/**
 * Detect identity fields in the document
 */
export function detectIdentityFields(
	root: Document | ShadowRoot = document,
): DetectedField[] {
	const allFields = detectAllFields(root);

	// Filter to identity field types
	return allFields.filter((f) => isIdentityFieldType(f.type));
}

/**
 * Detect OTP/verification code fields
 */
export function detectOTPFields(
	root: Document | ShadowRoot = document,
): DetectedField[] {
	const allFields = detectAllFields(root);
	const otpFields = allFields.filter((f) => f.type === "otp");

	// Also look for grouped inputs that might be OTP
	// (common pattern: multiple single-digit inputs)
	const singleCharInputs = allFields.filter((f) => {
		const input = f.element;
		return (
			input.maxLength === 1 &&
			(input.inputMode === "numeric" || input.pattern === "[0-9]")
		);
	});

	if (singleCharInputs.length >= 4 && singleCharInputs.length <= 8) {
		// Likely OTP inputs
		for (const field of singleCharInputs) {
			if (!otpFields.includes(field)) {
				field.type = "otp";
				field.confidence = 0.8;
				otpFields.push(field);
			}
		}
	}

	return otpFields;
}
