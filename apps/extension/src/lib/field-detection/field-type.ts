import { findLabel } from "./dom";
import { shouldExcludeField } from "./exclusion";
import { FIELD_PATTERNS } from "./patterns";
import type { DetectedField } from "./types";

/**
 * Calculate confidence score for field type
 */
function calculateFieldTypeScore(
	input: HTMLInputElement,
	fieldType: keyof typeof FIELD_PATTERNS,
	labelText: string,
): number {
	const patterns = FIELD_PATTERNS[fieldType];
	let score = 0;
	let maxScore = 0;

	// Check input type
	if ("typeValues" in patterns && patterns.typeValues) {
		maxScore += 30;
		if (patterns.typeValues.includes(input.type)) {
			score += 30;
		}
	}

	// Check name attribute
	if ("namePatterns" in patterns && patterns.namePatterns) {
		maxScore += 15;
		const name = input.name?.toLowerCase() || "";
		if (patterns.namePatterns.some((p) => p.test(name))) {
			score += 15;
		}
	}

	// Check id attribute
	if ("idPatterns" in patterns && patterns.idPatterns) {
		maxScore += 15;
		const id = input.id?.toLowerCase() || "";
		if (patterns.idPatterns.some((p) => p.test(id))) {
			score += 15;
		}
	}

	// Check placeholder
	if ("placeholderPatterns" in patterns && patterns.placeholderPatterns) {
		maxScore += 10;
		const placeholder = input.placeholder?.toLowerCase() || "";
		if (patterns.placeholderPatterns.some((p) => p.test(placeholder))) {
			score += 10;
		}
	}

	// Check autocomplete
	if ("autocompleteValues" in patterns && patterns.autocompleteValues) {
		maxScore += 20;
		const autocomplete = input.autocomplete?.toLowerCase() || "";
		if (patterns.autocompleteValues.some((v) => autocomplete.includes(v))) {
			score += 20;
		}
	}

	// Check label text
	if ("labelPatterns" in patterns && patterns.labelPatterns) {
		maxScore += 15;
		if (patterns.labelPatterns.some((p) => p.test(labelText))) {
			score += 15;
		}
	}

	// Check aria-label
	if ("ariaLabelPatterns" in patterns && patterns.ariaLabelPatterns) {
		maxScore += 10;
		const ariaLabel = input.getAttribute("aria-label")?.toLowerCase() || "";
		if (patterns.ariaLabelPatterns.some((p) => p.test(ariaLabel))) {
			score += 10;
		}
	}

	// OTP-specific checks
	if (fieldType === "otp") {
		const otpPatterns = FIELD_PATTERNS.otp;

		// Check maxlength
		if ("maxLengthValues" in otpPatterns && otpPatterns.maxLengthValues) {
			maxScore += 10;
			const maxLength = input.maxLength;
			if (maxLength > 0 && otpPatterns.maxLengthValues.includes(maxLength)) {
				score += 10;
			}
		}

		// Check inputmode
		if ("inputModeValues" in otpPatterns && otpPatterns.inputModeValues) {
			maxScore += 5;
			const inputMode = input.inputMode || "";
			if (otpPatterns.inputModeValues.includes(inputMode)) {
				score += 5;
			}
		}

		// Check for pattern attribute (common in OTP fields)
		maxScore += 5;
		if (input.pattern && /^\[0-9\]/.test(input.pattern)) {
			score += 5;
		}
	}

	// Credit card field specific checks
	if (
		fieldType === "cardNumber" ||
		fieldType === "cardCvv" ||
		fieldType === "cardExpiry"
	) {
		const cardPatterns = FIELD_PATTERNS[fieldType];

		// Check maxlength for card fields
		if ("maxLengthValues" in cardPatterns && cardPatterns.maxLengthValues) {
			maxScore += 10;
			const maxLength = input.maxLength;
			if (maxLength > 0 && cardPatterns.maxLengthValues.includes(maxLength)) {
				score += 10;
			}
		}

		// Check inputmode for card number and CVV (should be numeric)
		if ("inputModeValues" in cardPatterns && cardPatterns.inputModeValues) {
			maxScore += 5;
			const inputMode = input.inputMode || "";
			if (cardPatterns.inputModeValues.includes(inputMode)) {
				score += 5;
			}
		}

		// Additional card number pattern check - look for card-related formatting patterns
		if (fieldType === "cardNumber") {
			maxScore += 5;
			if (
				input.pattern &&
				(/\d{4}/.test(input.pattern) || /[0-9]/.test(input.pattern))
			) {
				score += 5;
			}
		}
	}

	// Additional context scoring
	// Check for data attributes
	maxScore += 5;
	const dataType = input.dataset.type?.toLowerCase() || "";
	const dataField = input.dataset.field?.toLowerCase() || "";
	if (
		fieldType === "password" &&
		(dataType.includes("password") || dataField.includes("password"))
	) {
		score += 5;
	} else if (
		fieldType === "email" &&
		(dataType.includes("email") || dataField.includes("email"))
	) {
		score += 5;
	} else if (
		fieldType === "username" &&
		(dataType.includes("user") || dataField.includes("user"))
	) {
		score += 5;
	}

	return maxScore > 0 ? score / maxScore : 0;
}

/**
 * Detect field type with confidence scoring
 */
export function detectFieldType(
	input: HTMLInputElement,
	root: Document | ShadowRoot = document,
): {
	type: DetectedField["type"];
	confidence: number;
} {
	const labelText = findLabel(input, root);

	// Quick check for obvious password fields
	if (input.type === "password") {
		return { type: "password", confidence: 1.0 };
	}

	// Quick check for email type
	if (input.type === "email") {
		return { type: "email", confidence: 0.95 };
	}

	// Check if input is hidden or not visible
	const computedStyle = window.getComputedStyle(input);
	if (
		computedStyle.display === "none" ||
		computedStyle.visibility === "hidden" ||
		input.type === "hidden"
	) {
		return { type: "username", confidence: 0 };
	}

	// Calculate scores for each field type
	const scores: Record<string, number> = {};
	for (const fieldType of Object.keys(FIELD_PATTERNS) as Array<
		keyof typeof FIELD_PATTERNS
	>) {
		scores[fieldType] = calculateFieldTypeScore(input, fieldType, labelText);
	}

	// Find the highest scoring type
	let bestType: DetectedField["type"] = "username";
	let bestScore = 0;

	for (const [type, score] of Object.entries(scores)) {
		if (score > bestScore) {
			bestScore = score;
			bestType = type as DetectedField["type"];
		}
	}

	// Apply minimum confidence thresholds
	// If no strong signals, default to username for text inputs in login forms
	// But only if the field appears before a password field and has no exclusionary indicators
	if (bestScore < 0.3 && input.type === "text") {
		// Check if this is in a login context
		const form = input.closest("form");
		if (form) {
			const passwordField = form.querySelector('input[type="password"]');
			if (passwordField) {
				// Check if this input comes before the password field in DOM order
				const formInputs = Array.from(form.querySelectorAll("input"));
				const inputIndex = formInputs.indexOf(input);
				const passwordIndex = formInputs.indexOf(
					passwordField as HTMLInputElement,
				);

				// Only consider it a username field if:
				// 1. It comes before the password field
				// 2. There aren't too many other text inputs (likely not a complex form)
				// 3. The form has login-like indicators
				const textInputsBeforePassword = formInputs
					.slice(0, passwordIndex)
					.filter((i) => i.type === "text" || i.type === "email");

				if (
					inputIndex < passwordIndex &&
					textInputsBeforePassword.length <= 2 &&
					!shouldExcludeField(input)
				) {
					// This is likely a username field in a login form
					return { type: "username", confidence: 0.35 };
				}
			}
		}
	}

	return { type: bestType, confidence: bestScore };
}
