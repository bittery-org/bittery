/**
 * Enhanced Form Field Detection Module
 *
 * This module provides advanced form field detection capabilities including:
 * - Shadow DOM traversal
 * - Multi-step form detection
 * - Dynamic form handling
 * - Advanced heuristics for field type identification
 */

export interface DetectedField {
	element: HTMLInputElement;
	type:
		| "username"
		| "email"
		| "password"
		| "name"
		| "phone"
		| "otp"
		| "cardNumber"
		| "cardExpiry"
		| "cardCvv"
		| "cardName"
		| "firstName"
		| "lastName"
		| "street"
		| "city"
		| "state"
		| "postalCode"
		| "country"
		| "dateOfBirth";
	confidence: number; // 0-1 confidence score
	form?: HTMLFormElement;
	shadowRoot?: ShadowRoot;
	stepIndex?: number; // For multi-step forms
}

export interface FormContext {
	form?: HTMLFormElement;
	fields: DetectedField[];
	isMultiStep: boolean;
	currentStep: number;
	totalSteps: number;
	shadowRoot?: ShadowRoot;
}

// Field type patterns with weights for scoring
const FIELD_PATTERNS = {
	username: {
		namePatterns: [
			/user/i,
			/login/i,
			/account/i,
			/identifier/i,
			/uid/i,
			/handle/i,
		],
		idPatterns: [
			/user/i,
			/login/i,
			/account/i,
			/identifier/i,
			/uid/i,
			/handle/i,
		],
		placeholderPatterns: [
			/user/i,
			/login/i,
			/account/i,
			/enter.*name/i,
			/your.*name/i,
		],
		autocompleteValues: ["username", "user", "nickname"],
		labelPatterns: [/user/i, /login/i, /account/i, /sign.*in/i, /identifier/i],
		ariaLabelPatterns: [/user/i, /login/i, /account/i, /sign.*in/i],
	},
	email: {
		typeValues: ["email"],
		namePatterns: [/email/i, /e-mail/i, /mail/i],
		idPatterns: [/email/i, /e-mail/i, /mail/i],
		placeholderPatterns: [/email/i, /e-mail/i, /@/],
		autocompleteValues: ["email", "username email"],
		labelPatterns: [/email/i, /e-mail/i],
		ariaLabelPatterns: [/email/i, /e-mail/i],
	},
	password: {
		typeValues: ["password"],
		namePatterns: [/pass/i, /pwd/i, /secret/i, /credential/i],
		idPatterns: [/pass/i, /pwd/i, /secret/i, /credential/i],
		placeholderPatterns: [/pass/i, /pwd/i, /secret/i],
		autocompleteValues: ["current-password", "new-password", "password", "off"],
		labelPatterns: [/password/i, /passwort/i, /contraseña/i, /mot.*passe/i],
		ariaLabelPatterns: [/password/i, /passwort/i, /contraseña/i, /mot.*passe/i],
	},
	otp: {
		namePatterns: [
			/otp/i,
			/code/i,
			/verify/i,
			/token/i,
			/pin/i,
			/2fa/i,
			/mfa/i,
		],
		idPatterns: [/otp/i, /code/i, /verify/i, /token/i, /pin/i, /2fa/i, /mfa/i],
		placeholderPatterns: [/code/i, /otp/i, /verify/i, /digit/i, /pin/i, /2fa/i],
		autocompleteValues: ["one-time-code"],
		labelPatterns: [
			/verification/i,
			/code/i,
			/otp/i,
			/2fa/i,
			/two.*factor/i,
			/mfa/i,
		],
		ariaLabelPatterns: [/verification/i, /code/i, /otp/i, /2fa/i],
		// OTP fields often have specific attributes
		maxLengthValues: [1, 4, 5, 6, 7, 8],
		inputModeValues: ["numeric", "tel"],
	},
	phone: {
		typeValues: ["tel"],
		namePatterns: [/phone/i, /mobile/i, /cell/i, /tel/i, /contact/i],
		idPatterns: [/phone/i, /mobile/i, /cell/i, /tel/i],
		placeholderPatterns: [/phone/i, /mobile/i, /\+?[0-9]/],
		autocompleteValues: ["tel", "tel-national", "tel-local", "mobile"],
		labelPatterns: [/phone/i, /mobile/i, /cell/i, /telephone/i],
		ariaLabelPatterns: [/phone/i, /mobile/i, /telephone/i],
	},
	name: {
		namePatterns: [
			/^name$/i,
			/fullname/i,
			/full.*name/i,
			/firstname/i,
			/first.*name/i,
			/lastname/i,
			/last.*name/i,
		],
		idPatterns: [
			/^name$/i,
			/fullname/i,
			/firstname/i,
			/lastname/i,
			/displayname/i,
		],
		placeholderPatterns: [/your.*name/i, /full.*name/i, /first.*name/i],
		autocompleteValues: ["name", "given-name", "family-name"],
		labelPatterns: [/^name$/i, /full.*name/i, /first.*name/i, /last.*name/i],
		ariaLabelPatterns: [/^name$/i, /full.*name/i],
	},
	// Credit card field patterns
	cardNumber: {
		namePatterns: [
			/card.*num/i,
			/cardnum/i,
			/cc.*num/i,
			/ccnum/i,
			/credit.*card/i,
			/card.*no/i,
			/pan/i,
		],
		idPatterns: [
			/card.*num/i,
			/cardnum/i,
			/cc.*num/i,
			/ccnum/i,
			/credit.*card/i,
			/card.*no/i,
			/pan/i,
		],
		placeholderPatterns: [
			/card.*number/i,
			/credit.*card/i,
			/4242/i,
			/1234.*5678/i,
			/xxxx.*xxxx/i,
			/•••• ••••/i,
		],
		autocompleteValues: ["cc-number"],
		labelPatterns: [
			/card.*number/i,
			/credit.*card/i,
			/debit.*card/i,
			/numéro.*carte/i,
			/kartennummer/i,
			/número.*tarjeta/i,
		],
		ariaLabelPatterns: [/card.*number/i, /credit.*card/i],
		// Card number fields typically have specific attributes
		maxLengthValues: [16, 19, 23], // 16 digits, or with spaces
		inputModeValues: ["numeric"],
	},
	cardExpiry: {
		namePatterns: [
			/exp/i,
			/expir/i,
			/valid/i,
			/cc.*exp/i,
			/card.*exp/i,
			/mm.*yy/i,
		],
		idPatterns: [/exp/i, /expir/i, /valid/i, /cc.*exp/i, /card.*exp/i],
		placeholderPatterns: [
			/mm\s*\/\s*yy/i,
			/mm\/yy/i,
			/expir/i,
			/valid.*thru/i,
			/valid.*until/i,
		],
		autocompleteValues: ["cc-exp", "cc-exp-month", "cc-exp-year"],
		labelPatterns: [
			/expir/i,
			/exp.*date/i,
			/valid.*thru/i,
			/valid.*until/i,
			/gültig.*bis/i,
			/fecha.*vencimiento/i,
		],
		ariaLabelPatterns: [/expir/i, /valid/i],
		maxLengthValues: [5, 7], // MM/YY or MM/YYYY
	},
	cardCvv: {
		namePatterns: [
			/cvv/i,
			/cvc/i,
			/cid/i,
			/cvn/i,
			/security.*code/i,
			/sec.*code/i,
			/card.*code/i,
		],
		idPatterns: [
			/cvv/i,
			/cvc/i,
			/cid/i,
			/cvn/i,
			/security.*code/i,
			/sec.*code/i,
		],
		placeholderPatterns: [
			/cvv/i,
			/cvc/i,
			/cid/i,
			/security.*code/i,
			/\d{3,4}/,
			/•••/i,
		],
		autocompleteValues: ["cc-csc"],
		labelPatterns: [
			/cvv/i,
			/cvc/i,
			/cid/i,
			/security.*code/i,
			/card.*verification/i,
			/sicherheitscode/i,
			/código.*seguridad/i,
		],
		ariaLabelPatterns: [/cvv/i, /cvc/i, /security.*code/i],
		maxLengthValues: [3, 4], // 3 for most cards, 4 for Amex
		inputModeValues: ["numeric"],
	},
	cardName: {
		namePatterns: [
			/card.*holder/i,
			/cardholder/i,
			/cc.*name/i,
			/ccname/i,
			/name.*on.*card/i,
			/card.*name/i,
		],
		idPatterns: [
			/card.*holder/i,
			/cardholder/i,
			/cc.*name/i,
			/ccname/i,
			/name.*on.*card/i,
		],
		placeholderPatterns: [
			/name.*on.*card/i,
			/cardholder/i,
			/full.*name/i,
			/as.*on.*card/i,
		],
		autocompleteValues: ["cc-name"],
		labelPatterns: [
			/name.*on.*card/i,
			/cardholder.*name/i,
			/card.*holder/i,
			/nom.*sur.*carte/i,
			/karteninhaber/i,
			/titular.*tarjeta/i,
		],
		ariaLabelPatterns: [/name.*on.*card/i, /cardholder/i],
	},
	// Identity field patterns
	firstName: {
		namePatterns: [
			/^first/i,
			/firstname/i,
			/first.*name/i,
			/fname/i,
			/given.*name/i,
			/forename/i,
		],
		idPatterns: [
			/^first/i,
			/firstname/i,
			/first.*name/i,
			/fname/i,
			/given.*name/i,
		],
		placeholderPatterns: [/first.*name/i, /given.*name/i, /forename/i],
		autocompleteValues: ["given-name"],
		labelPatterns: [
			/first.*name/i,
			/given.*name/i,
			/forename/i,
			/prénom/i,
			/vorname/i,
			/nombre/i,
		],
		ariaLabelPatterns: [/first.*name/i, /given.*name/i],
	},
	lastName: {
		namePatterns: [
			/^last/i,
			/lastname/i,
			/last.*name/i,
			/lname/i,
			/surname/i,
			/family.*name/i,
		],
		idPatterns: [
			/^last/i,
			/lastname/i,
			/last.*name/i,
			/lname/i,
			/surname/i,
			/family.*name/i,
		],
		placeholderPatterns: [/last.*name/i, /surname/i, /family.*name/i],
		autocompleteValues: ["family-name"],
		labelPatterns: [
			/last.*name/i,
			/surname/i,
			/family.*name/i,
			/nom.*famille/i,
			/nachname/i,
			/apellido/i,
		],
		ariaLabelPatterns: [/last.*name/i, /surname/i, /family.*name/i],
	},
	street: {
		namePatterns: [
			/street/i,
			/address/i,
			/addr/i,
			/address.*1/i,
			/address.*line/i,
			/street.*addr/i,
			/shipping.*address/i,
			/billing.*address/i,
		],
		idPatterns: [
			/street/i,
			/address/i,
			/addr/i,
			/address.*1/i,
			/address.*line/i,
		],
		placeholderPatterns: [
			/street/i,
			/address/i,
			/123.*main/i,
			/enter.*address/i,
		],
		autocompleteValues: [
			"street-address",
			"address-line1",
			"address-line2",
			"shipping street-address",
			"billing street-address",
		],
		labelPatterns: [
			/street/i,
			/address/i,
			/addr/i,
			/adresse/i,
			/dirección/i,
			/住所/i,
		],
		ariaLabelPatterns: [/street/i, /address/i],
	},
	city: {
		namePatterns: [/city/i, /town/i, /locality/i, /suburb/i, /municipality/i],
		idPatterns: [/city/i, /town/i, /locality/i, /suburb/i],
		placeholderPatterns: [/city/i, /town/i, /enter.*city/i],
		autocompleteValues: ["address-level2", "locality"],
		labelPatterns: [
			/city/i,
			/town/i,
			/locality/i,
			/ville/i,
			/stadt/i,
			/ciudad/i,
			/市/i,
		],
		ariaLabelPatterns: [/city/i, /town/i, /locality/i],
	},
	state: {
		namePatterns: [
			/state/i,
			/province/i,
			/region/i,
			/prefecture/i,
			/county/i,
			/territory/i,
		],
		idPatterns: [/state/i, /province/i, /region/i, /prefecture/i],
		placeholderPatterns: [/state/i, /province/i, /region/i, /select.*state/i],
		autocompleteValues: ["address-level1", "region"],
		labelPatterns: [
			/state/i,
			/province/i,
			/region/i,
			/prefecture/i,
			/county/i,
			/état/i,
			/bundesland/i,
			/provincia/i,
			/県/i,
		],
		ariaLabelPatterns: [/state/i, /province/i, /region/i],
	},
	postalCode: {
		namePatterns: [/zip/i, /postal/i, /postcode/i, /post.*code/i, /zip.*code/i],
		idPatterns: [/zip/i, /postal/i, /postcode/i, /post.*code/i],
		placeholderPatterns: [/zip/i, /postal/i, /postcode/i, /\d{5}/],
		autocompleteValues: ["postal-code"],
		labelPatterns: [
			/zip/i,
			/postal.*code/i,
			/postcode/i,
			/post.*code/i,
			/code.*postal/i,
			/plz/i,
			/código.*postal/i,
			/郵便番号/i,
		],
		ariaLabelPatterns: [/zip/i, /postal/i, /postcode/i],
		maxLengthValues: [5, 6, 7, 9, 10], // Common postal code lengths
	},
	country: {
		namePatterns: [/country/i, /nation/i, /country.*code/i],
		idPatterns: [/country/i, /nation/i],
		placeholderPatterns: [/country/i, /select.*country/i],
		autocompleteValues: ["country", "country-name"],
		labelPatterns: [/country/i, /nation/i, /pays/i, /land/i, /país/i, /国/i],
		ariaLabelPatterns: [/country/i, /nation/i],
	},
	dateOfBirth: {
		typeValues: ["date"],
		namePatterns: [
			/dob/i,
			/birth/i,
			/birthday/i,
			/date.*birth/i,
			/bday/i,
			/born/i,
		],
		idPatterns: [/dob/i, /birth/i, /birthday/i, /date.*birth/i, /bday/i],
		placeholderPatterns: [
			/birth/i,
			/birthday/i,
			/mm\/dd\/yyyy/i,
			/dd\/mm\/yyyy/i,
		],
		autocompleteValues: ["bday", "birthday"],
		labelPatterns: [
			/date.*birth/i,
			/birth.*date/i,
			/birthday/i,
			/dob/i,
			/date.*naissance/i,
			/geburtsdatum/i,
			/fecha.*nacimiento/i,
			/生年月日/i,
		],
		ariaLabelPatterns: [/birth/i, /birthday/i, /dob/i],
	},
};

// Multi-step form indicators
const MULTI_STEP_INDICATORS = {
	// Classes that suggest multi-step forms
	stepClasses: [
		/step/i,
		/wizard/i,
		/stage/i,
		/phase/i,
		/page/i,
		/slide/i,
		/tab.*panel/i,
		/carousel/i,
	],
	// Navigation elements
	navSelectors: [
		".steps",
		".wizard-steps",
		".step-indicator",
		".progress-steps",
		'[role="progressbar"]',
		".form-steps",
		".multi-step",
	],
	// Next/Previous button patterns
	buttonPatterns: [
		/next/i,
		/continue/i,
		/proceed/i,
		/forward/i,
		/weiter/i,
		/suivant/i,
		/previous/i,
		/back/i,
		/zurück/i,
	],
	// Hidden step containers
	hiddenStepSelectors: [
		'.step[style*="display: none"]',
		'.step[style*="visibility: hidden"]',
		".step.hidden",
		".step.inactive",
		'[data-step]:not([data-step="current"])',
		".form-step:not(.active)",
	],
};

/**
 * Get all inputs including those in Shadow DOM
 */
export function getAllInputs(root: Document | ShadowRoot = document): {
	input: HTMLInputElement;
	shadowRoot?: ShadowRoot;
}[] {
	const results: { input: HTMLInputElement; shadowRoot?: ShadowRoot }[] = [];

	// Get inputs from current context
	const inputs = root.querySelectorAll<HTMLInputElement>("input");
	for (const input of inputs) {
		results.push({
			input,
			shadowRoot: root instanceof ShadowRoot ? root : undefined,
		});
	}

	// Recursively search Shadow DOMs
	const elementsWithShadow = root.querySelectorAll("*");
	for (const element of elementsWithShadow) {
		if (element.shadowRoot) {
			const shadowInputs = getAllInputs(element.shadowRoot);
			results.push(
				...shadowInputs.map((si) => ({
					input: si.input,
					// biome-ignore lint/style/noNonNullAssertion: Its okay here
					shadowRoot: si.shadowRoot || element.shadowRoot!,
				})),
			);
		}
	}

	return results;
}

/**
 * Find associated label for an input element
 */
function findLabel(
	input: HTMLInputElement,
	root: Document | ShadowRoot = document,
): string {
	// Check for explicit label via for attribute
	if (input.id) {
		const label = root.querySelector(`label[for="${input.id}"]`);
		if (label?.textContent) {
			return label.textContent.trim();
		}
	}

	// Check for wrapping label
	const parentLabel = input.closest("label");
	if (parentLabel?.textContent) {
		return parentLabel.textContent.trim();
	}

	// Check for aria-labelledby
	const labelledBy = input.getAttribute("aria-labelledby");
	if (labelledBy) {
		const labelElement = root.getElementById(labelledBy);
		if (labelElement?.textContent) {
			return labelElement.textContent.trim();
		}
	}

	// Check for preceding sibling text
	const prevSibling = input.previousElementSibling;
	if (
		prevSibling &&
		(prevSibling.tagName === "LABEL" || prevSibling.tagName === "SPAN")
	) {
		return prevSibling.textContent?.trim() || "";
	}

	// Check parent for label-like text
	const parent = input.parentElement;
	if (parent) {
		const labelChild = parent.querySelector("label, .label, .form-label");
		if (labelChild?.textContent) {
			return labelChild.textContent.trim();
		}
	}

	return "";
}

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
			// Check if field has a pattern for card numbers
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

/**
 * Credit card field types for grouping
 */
export type CreditCardFieldType =
	| "cardNumber"
	| "cardExpiry"
	| "cardCvv"
	| "cardName";

/**
 * Identity field types for grouping
 */
export type IdentityFieldType =
	| "firstName"
	| "lastName"
	| "email"
	| "phone"
	| "street"
	| "city"
	| "state"
	| "postalCode"
	| "country"
	| "dateOfBirth";

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
 * Detected credit card form with all relevant fields
 */
export interface DetectedCreditCardForm {
	form?: HTMLFormElement;
	cardNumberField?: DetectedField;
	expiryField?: DetectedField;
	cvvField?: DetectedField;
	nameField?: DetectedField;
	shadowRoot?: ShadowRoot;
}

/**
 * Detected identity form with all relevant fields
 */
export interface DetectedIdentityForm {
	form?: HTMLFormElement;
	firstNameField?: DetectedField;
	lastNameField?: DetectedField;
	emailField?: DetectedField;
	phoneField?: DetectedField;
	streetField?: DetectedField;
	cityField?: DetectedField;
	stateField?: DetectedField;
	postalCodeField?: DetectedField;
	countryField?: DetectedField;
	dateOfBirthField?: DetectedField;
	shadowRoot?: ShadowRoot;
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
 * Group credit card fields into forms
 */
export function groupCreditCardFieldsByForm(
	fields: DetectedField[],
): DetectedCreditCardForm[] {
	const formMap = new Map<HTMLFormElement | null, DetectedCreditCardForm>();

	for (const field of fields) {
		if (!isCreditCardFieldType(field.type)) continue;

		const form = field.form || null;
		let formGroup = formMap.get(form);

		if (!formGroup) {
			formGroup = {
				form: form || undefined,
				shadowRoot: field.shadowRoot,
			};
			formMap.set(form, formGroup);
		}

		// Assign field to appropriate slot based on type
		switch (field.type) {
			case "cardNumber":
				if (
					!formGroup.cardNumberField ||
					field.confidence > formGroup.cardNumberField.confidence
				) {
					formGroup.cardNumberField = field;
				}
				break;
			case "cardExpiry":
				if (
					!formGroup.expiryField ||
					field.confidence > formGroup.expiryField.confidence
				) {
					formGroup.expiryField = field;
				}
				break;
			case "cardCvv":
				if (
					!formGroup.cvvField ||
					field.confidence > formGroup.cvvField.confidence
				) {
					formGroup.cvvField = field;
				}
				break;
			case "cardName":
				if (
					!formGroup.nameField ||
					field.confidence > formGroup.nameField.confidence
				) {
					formGroup.nameField = field;
				}
				break;
		}
	}

	// Return only forms that have at least a card number field
	return Array.from(formMap.values()).filter((form) => form.cardNumberField);
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
 * Group identity fields by form
 */
export function groupIdentityFieldsByForm(
	fields: DetectedField[],
): DetectedIdentityForm[] {
	const formMap = new Map<HTMLFormElement | null, DetectedIdentityForm>();

	for (const field of fields) {
		if (!isIdentityFieldType(field.type)) continue;

		const form = field.form || null;
		let formGroup = formMap.get(form);

		if (!formGroup) {
			formGroup = {
				form: form || undefined,
				shadowRoot: field.shadowRoot,
			};
			formMap.set(form, formGroup);
		}

		// Assign field to appropriate slot based on type
		switch (field.type) {
			case "firstName":
				if (
					!formGroup.firstNameField ||
					field.confidence > formGroup.firstNameField.confidence
				) {
					formGroup.firstNameField = field;
				}
				break;
			case "lastName":
				if (
					!formGroup.lastNameField ||
					field.confidence > formGroup.lastNameField.confidence
				) {
					formGroup.lastNameField = field;
				}
				break;
			case "email":
				if (
					!formGroup.emailField ||
					field.confidence > formGroup.emailField.confidence
				) {
					formGroup.emailField = field;
				}
				break;
			case "phone":
				if (
					!formGroup.phoneField ||
					field.confidence > formGroup.phoneField.confidence
				) {
					formGroup.phoneField = field;
				}
				break;
			case "street":
				if (
					!formGroup.streetField ||
					field.confidence > formGroup.streetField.confidence
				) {
					formGroup.streetField = field;
				}
				break;
			case "city":
				if (
					!formGroup.cityField ||
					field.confidence > formGroup.cityField.confidence
				) {
					formGroup.cityField = field;
				}
				break;
			case "state":
				if (
					!formGroup.stateField ||
					field.confidence > formGroup.stateField.confidence
				) {
					formGroup.stateField = field;
				}
				break;
			case "postalCode":
				if (
					!formGroup.postalCodeField ||
					field.confidence > formGroup.postalCodeField.confidence
				) {
					formGroup.postalCodeField = field;
				}
				break;
			case "country":
				if (
					!formGroup.countryField ||
					field.confidence > formGroup.countryField.confidence
				) {
					formGroup.countryField = field;
				}
				break;
			case "dateOfBirth":
				if (
					!formGroup.dateOfBirthField ||
					field.confidence > formGroup.dateOfBirthField.confidence
				) {
					formGroup.dateOfBirthField = field;
				}
				break;
		}
	}

	// Return forms that have at least one identity field (not just firstName/lastName, but also address fields)
	return Array.from(formMap.values()).filter(
		(form) =>
			form.streetField ||
			form.cityField ||
			form.stateField ||
			form.postalCodeField ||
			form.countryField ||
			(form.firstNameField && form.lastNameField),
	);
}

/**
 * Check if a form looks like an address/identity form
 */
export function isLikelyAddressForm(form: HTMLFormElement): boolean {
	const identityFields = detectIdentityFields(document);
	const fieldsInForm = identityFields.filter((f) => f.form === form);

	// Must have address fields or name fields
	const hasAddressFields = fieldsInForm.some(
		(f) => f.type === "street" || f.type === "city" || f.type === "postalCode",
	);
	const hasNameFields = fieldsInForm.some(
		(f) => f.type === "firstName" || f.type === "lastName",
	);

	if (!hasAddressFields && !hasNameFields) return false;

	// Check form attributes for address indicators
	const formAction = form.action?.toLowerCase() || "";
	const formClass = form.className?.toLowerCase() || "";
	const formId = form.id?.toLowerCase() || "";

	const addressPatterns = [
		/address/i,
		/shipping/i,
		/billing/i,
		/delivery/i,
		/checkout/i,
		/registration/i,
		/signup/i,
		/profile/i,
		/contact/i,
	];

	const hasAddressIndicator = addressPatterns.some(
		(p) => p.test(formAction) || p.test(formClass) || p.test(formId),
	);

	return hasAddressFields || hasNameFields || hasAddressIndicator;
}

/**
 * Check if a form looks like a payment/checkout form
 */
export function isLikelyPaymentForm(form: HTMLFormElement): boolean {
	const creditCardFields = detectCreditCardFields(document);
	const fieldsInForm = creditCardFields.filter((f) => f.form === form);

	// Must have at least a card number field
	const hasCardNumber = fieldsInForm.some((f) => f.type === "cardNumber");
	if (!hasCardNumber) return false;

	// Check form attributes for payment indicators
	const formAction = form.action?.toLowerCase() || "";
	const formClass = form.className?.toLowerCase() || "";
	const formId = form.id?.toLowerCase() || "";

	const paymentPatterns = [
		/payment/i,
		/checkout/i,
		/billing/i,
		/purchase/i,
		/card/i,
		/stripe/i,
		/braintree/i,
		/paypal/i,
	];

	const hasPaymentIndicator = paymentPatterns.some(
		(p) => p.test(formAction) || p.test(formClass) || p.test(formId),
	);

	return hasCardNumber || hasPaymentIndicator;
}

/**
 * Detect if a form is multi-step
 */
export function detectMultiStepForm(form: HTMLFormElement): {
	isMultiStep: boolean;
	currentStep: number;
	totalSteps: number;
	stepContainers: Element[];
} {
	const result = {
		isMultiStep: false,
		currentStep: 1,
		totalSteps: 1,
		stepContainers: [] as Element[],
	};

	// Check for step navigation elements
	for (const selector of MULTI_STEP_INDICATORS.navSelectors) {
		const nav = form.querySelector(selector) || form.closest(selector);
		if (nav) {
			result.isMultiStep = true;
			// Try to count steps from navigation
			const stepItems = nav.querySelectorAll("li, .step, [data-step]");
			if (stepItems.length > 1) {
				result.totalSteps = stepItems.length;

				// Find current step
				for (let i = 0; i < stepItems.length; i++) {
					const item = stepItems[i];
					if (item) {
						if (
							item.classList.contains("active") ||
							item.classList.contains("current") ||
							item.getAttribute("aria-current") === "step"
						) {
							result.currentStep = i + 1;
							break;
						}
					}
				}
			}
		}
	}

	// Check for step containers with class patterns
	const allElements = form.querySelectorAll("*");
	const stepElements: Element[] = [];

	for (const element of allElements) {
		const className = element.className;
		if (typeof className === "string") {
			if (MULTI_STEP_INDICATORS.stepClasses.some((p) => p.test(className))) {
				stepElements.push(element);
			}
		}
	}

	if (stepElements.length > 1) {
		result.isMultiStep = true;
		result.stepContainers = stepElements;
		result.totalSteps = Math.max(result.totalSteps, stepElements.length);
	}

	// Check for next/continue buttons
	const buttons = form.querySelectorAll("button, input[type='button'], a");
	for (const button of buttons) {
		const text = button.textContent?.toLowerCase() || "";
		const value =
			(button as HTMLInputElement).value?.toLowerCase() ||
			button.getAttribute("aria-label")?.toLowerCase() ||
			"";

		if (
			MULTI_STEP_INDICATORS.buttonPatterns.some(
				(p) => p.test(text) || p.test(value),
			)
		) {
			result.isMultiStep = true;
			break;
		}
	}

	// Check for data attributes suggesting steps
	if (form.dataset.step || form.dataset.steps || form.dataset.currentStep) {
		result.isMultiStep = true;
		const totalSteps =
			Number.parseInt(
				form.dataset.steps || form.dataset.totalSteps || "0",
				10,
			) || result.totalSteps;
		const currentStep =
			Number.parseInt(
				form.dataset.step || form.dataset.currentStep || "1",
				10,
			) || 1;
		result.totalSteps = Math.max(result.totalSteps, totalSteps);
		result.currentStep = currentStep;
	}

	return result;
}

/**
 * Get visible fields only
 */
export function isFieldVisible(input: HTMLInputElement): boolean {
	// Check if element is in the DOM
	if (!input.isConnected) {
		return false;
	}

	// Check computed style
	const style = window.getComputedStyle(input);
	if (
		style.display === "none" ||
		style.visibility === "hidden" ||
		style.opacity === "0"
	) {
		return false;
	}

	// Check dimensions
	const rect = input.getBoundingClientRect();
	if (rect.width === 0 || rect.height === 0) {
		return false;
	}

	// Check if any ancestor is hidden
	let parent = input.parentElement;
	while (parent) {
		const parentStyle = window.getComputedStyle(parent);
		if (parentStyle.display === "none" || parentStyle.visibility === "hidden") {
			return false;
		}
		parent = parent.parentElement;
	}

	return true;
}

/**
 * Check if an input should be excluded from autofill detection
 */
function shouldExcludeField(input: HTMLInputElement): boolean {
	// Exclude fields with specific roles
	const role = input.getAttribute("role");
	if (role && ["search", "searchbox", "combobox"].includes(role)) {
		return true;
	}

	// Exclude fields with search-related attributes
	const type = input.type?.toLowerCase() || "text";
	if (type === "search") {
		return true;
	}

	// Check for search/filter/query patterns in various attributes
	const name = input.name?.toLowerCase() || "";
	const id = input.id?.toLowerCase() || "";
	const placeholder = input.placeholder?.toLowerCase() || "";
	const ariaLabel = input.getAttribute("aria-label")?.toLowerCase() || "";
	const className = input.className?.toLowerCase() || "";

	// Common search/filter/query patterns that should be excluded
	const excludePatterns = [
		/\bsearch\b/i,
		/\bquery\b/i,
		/\bfilter\b/i,
		/\bfind\b/i,
		/\blookup\b/i,
		/\bq\b/i, // Common query parameter
		/^s$/i, // Single 's' often used for search
		/\bkeyword/i,
		/\bchat\b/i,
		/\bmessage\b/i,
		/\bcomment\b/i,
		/\breply\b/i,
		/\bsubject\b/i,
		/\btitle\b(?!.*card)/i, // title but not related to card
		/\bdescription\b/i,
		/\bnote\b/i,
		/\bamount\b/i,
		/\bprice\b/i,
		/\bquantity\b/i,
		/\bqty\b/i,
		/\bcoupon\b/i,
		/\bpromo.*code\b(?!.*password)/i, // promo code but not password
		/\btracking\b/i,
		/\burl\b/i,
		/\blink\b/i,
		/\btag\b/i,
		/\bcategory\b/i,
	];

	const textToCheck = [name, id, placeholder, ariaLabel, className].join(" ");
	if (excludePatterns.some((pattern) => pattern.test(textToCheck))) {
		return true;
	}

	// Exclude inputs that have autocomplete="off" AND are search-like
	const autocomplete = input.autocomplete?.toLowerCase();
	if (
		autocomplete === "off" &&
		(textToCheck.includes("search") || textToCheck.includes("filter"))
	) {
		return true;
	}

	// Exclude inputs in search forms
	const form = input.closest("form");
	if (form) {
		const formRole = form.getAttribute("role");
		if (formRole === "search") {
			return true;
		}

		const formAction = form.action?.toLowerCase() || "";
		const formClass = form.className?.toLowerCase() || "";
		const formId = form.id?.toLowerCase() || "";

		if (
			/search/i.test(formAction) ||
			/search/i.test(formClass) ||
			/search/i.test(formId)
		) {
			return true;
		}
	}

	// Exclude contenteditable elements
	if (input.contentEditable === "true") {
		return true;
	}

	// Exclude read-only fields
	if (input.readOnly) {
		return true;
	}

	// Exclude disabled fields
	if (input.disabled) {
		return true;
	}

	return false;
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
 * Group fields by form context
 */
export function groupFieldsByForm(
	fields: DetectedField[],
): Map<HTMLFormElement | null, FormContext> {
	const formContexts = new Map<HTMLFormElement | null, FormContext>();

	for (const field of fields) {
		const form = field.form || null;
		let context = formContexts.get(form);

		if (!context) {
			const multiStepInfo = form
				? detectMultiStepForm(form)
				: { isMultiStep: false, currentStep: 1, totalSteps: 1 };

			context = {
				form: form || undefined,
				fields: [],
				isMultiStep: multiStepInfo.isMultiStep,
				currentStep: multiStepInfo.currentStep,
				totalSteps: multiStepInfo.totalSteps,
				shadowRoot: field.shadowRoot,
			};
			formContexts.set(form, context);
		}

		context.fields.push(field);
	}

	return formContexts;
}

/**
 * Find the best username/email and password pair in a form
 */
export function findCredentialPair(fields: DetectedField[]): {
	usernameField?: DetectedField;
	passwordField?: DetectedField;
} {
	let usernameField: DetectedField | undefined;
	let passwordField: DetectedField | undefined;

	// Find best password field
	const passwordFields = fields.filter((f) => f.type === "password");
	if (passwordFields.length > 0) {
		// Prefer visible password fields
		passwordField =
			passwordFields.find((f) => isFieldVisible(f.element)) ||
			passwordFields[0];
	}

	// Find best username/email field
	const usernameFields = fields.filter(
		(f) => f.type === "username" || f.type === "email",
	);
	if (usernameFields.length > 0) {
		// Prefer visible fields with higher confidence
		const visibleUserFields = usernameFields.filter((f) =>
			isFieldVisible(f.element),
		);
		if (visibleUserFields.length > 0) {
			// Sort by confidence and take the best
			visibleUserFields.sort((a, b) => b.confidence - a.confidence);
			usernameField = visibleUserFields[0];
		} else {
			usernameFields.sort((a, b) => b.confidence - a.confidence);
			usernameField = usernameFields[0];
		}
	}

	return { usernameField, passwordField };
}

/**
 * Enhanced mutation observer for dynamic form detection
 */
export function createEnhancedObserver(
	callback: (mutations: MutationRecord[]) => void,
	root: Document | ShadowRoot = document,
): MutationObserver {
	const observer = new MutationObserver((mutations) => {
		// Check if any mutations are relevant to form/input detection
		const relevantMutations = mutations.filter((mutation) => {
			// Check added nodes
			for (const node of mutation.addedNodes) {
				if (node instanceof HTMLElement) {
					if (
						node.tagName === "INPUT" ||
						node.tagName === "FORM" ||
						node.querySelector("input, form")
					) {
						return true;
					}
					// Check for shadow root additions
					if (node.shadowRoot) {
						return true;
					}
				}
			}

			// Check attribute changes on inputs
			if (
				mutation.type === "attributes" &&
				mutation.target instanceof HTMLInputElement
			) {
				const relevantAttrs = ["type", "name", "id", "autocomplete", "hidden"];
				if (
					mutation.attributeName &&
					relevantAttrs.includes(mutation.attributeName)
				) {
					return true;
				}
			}

			return false;
		});

		if (relevantMutations.length > 0) {
			callback(relevantMutations);
		}
	});

	// Observe the root with comprehensive settings
	const targetNode = root === document ? document.body : root;
	observer.observe(targetNode, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeFilter: ["type", "name", "id", "autocomplete", "hidden", "style"],
	});

	return observer;
}

/**
 * Watch for shadow roots being attached to elements
 */
export function observeShadowRoots(
	callback: (shadowRoot: ShadowRoot, host: Element) => void,
): void {
	// Store original attachShadow
	const originalAttachShadow = Element.prototype.attachShadow;

	// Override attachShadow to detect new shadow roots
	Element.prototype.attachShadow = function (init: ShadowRootInit): ShadowRoot {
		const shadowRoot = originalAttachShadow.call(this, init);

		// Notify about new shadow root after a small delay to allow initialization
		setTimeout(() => {
			callback(shadowRoot, this);
		}, 0);

		return shadowRoot;
	};
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

/**
 * Check if a form looks like a login form
 */
export function isLikelyLoginForm(form: HTMLFormElement): boolean {
	// Get fields within the form by filtering all document fields
	const allFields = detectCredentialFields(document);
	const fields = allFields.filter((f) => f.form === form);
	const hasPassword = fields.some((f) => f.type === "password");
	const hasUsername = fields.some(
		(f) => f.type === "username" || f.type === "email",
	);

	// Check form attributes
	const formAction = form.action?.toLowerCase() || "";
	const formClass = form.className?.toLowerCase() || "";
	const formId = form.id?.toLowerCase() || "";

	const loginPatterns = [/login/i, /signin/i, /sign-in/i, /auth/i, /session/i];

	const hasLoginIndicator = loginPatterns.some(
		(p) => p.test(formAction) || p.test(formClass) || p.test(formId),
	);

	return hasPassword && (hasUsername || hasLoginIndicator);
}

/**
 * Check if a form looks like a registration form
 */
export function isLikelyRegistrationForm(form: HTMLFormElement): boolean {
	// Get fields within the form by filtering all document fields
	const allFields = detectCredentialFields(document);
	const fields = allFields.filter((f) => f.form === form);
	const passwordFields = fields.filter((f) => f.type === "password");

	// Multiple password fields often indicate registration (password + confirm)
	if (passwordFields.length >= 2) {
		return true;
	}

	// Check form attributes
	const formAction = form.action?.toLowerCase() || "";
	const formClass = form.className?.toLowerCase() || "";
	const formId = form.id?.toLowerCase() || "";

	const registerPatterns = [
		/register/i,
		/signup/i,
		/sign-up/i,
		/create.*account/i,
		/join/i,
	];

	return registerPatterns.some(
		(p) => p.test(formAction) || p.test(formClass) || p.test(formId),
	);
}
