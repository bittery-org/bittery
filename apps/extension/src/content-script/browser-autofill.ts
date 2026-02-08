import type { CredentialFieldType } from "./types";

let autofillBlockerStylesInjected = false;

/**
 * Inject CSS to hide Chrome's autofill dropdown suggestions
 */
export function injectAutofillBlockerStyles() {
	if (autofillBlockerStylesInjected) return;
	autofillBlockerStylesInjected = true;

	const style = document.createElement("style");
	style.textContent = `
		/* Hide Chrome autofill suggestion popups */
		input:-webkit-autofill,
		input:-webkit-autofill:hover,
		input:-webkit-autofill:focus,
		input:-webkit-autofill:active {
			-webkit-box-shadow: 0 0 0 30px white inset !important;
			box-shadow: 0 0 0 30px white inset !important;
		}

		/* Target Bittery-detected fields specifically */
		input[data-bittery-detected="true"]::-webkit-contacts-auto-fill-button,
		input[data-bittery-detected="true"]::-webkit-credentials-auto-fill-button {
			visibility: hidden;
			display: none !important;
			pointer-events: none;
			height: 0;
			width: 0;
			margin: 0;
		}
	`;
	document.head.appendChild(style);
}

/**
 * Aggressively disable Chrome's autofill for a specific input
 */
export function disableChromeAutofill(
	input: HTMLInputElement,
	fieldType: CredentialFieldType,
) {
	// Strategy 1: Set autocomplete to a value Chrome respects
	// For password fields, "new-password" tells Chrome not to autofill existing passwords
	// For other fields, use a random unique value that Chrome won't recognize
	if (fieldType === "password") {
		input.setAttribute("autocomplete", "new-password");
	} else {
		// Random autocomplete value that Chrome won't recognize
		input.setAttribute(
			"autocomplete",
			`bittery-${Math.random().toString(36).slice(2)}`,
		);
	}

	// Strategy 2: Set data attributes that some browsers respect
	input.setAttribute("data-form-type", "other");
	input.setAttribute("data-lpignore", "true"); // LastPass ignore
	input.setAttribute("data-1p-ignore", "true"); // 1Password ignore

	// Strategy 3: Remove name temporarily and restore it
	// This can trick Chrome's autofill detection
	const originalName = input.name;
	if (originalName) {
		input.removeAttribute("name");
		// Restore after a brief delay so the form still works
		setTimeout(() => {
			input.name = originalName;
		}, 100);
	}
}

/**
 * Aggressively disable Chrome's autofill for credit card fields
 */
export function disableChromeAutofillForCreditCard(input: HTMLInputElement) {
	// Use random autocomplete value to prevent Chrome's credit card autofill
	input.setAttribute(
		"autocomplete",
		`bittery-cc-${Math.random().toString(36).slice(2)}`,
	);
	input.setAttribute("data-form-type", "other");
	input.setAttribute("data-lpignore", "true");
	input.setAttribute("data-1p-ignore", "true");

	// Inject styles if not already done
	injectAutofillBlockerStyles();

	// Remove name temporarily
	const originalName = input.name;
	if (originalName) {
		input.removeAttribute("name");
		setTimeout(() => {
			input.name = originalName;
		}, 100);
	}
}

/**
 * Aggressively disable Chrome's autofill for identity/address fields
 */
export function disableChromeAutofillForIdentity(input: HTMLInputElement) {
	// Use random autocomplete value to prevent Chrome's address autofill
	input.setAttribute(
		"autocomplete",
		`bittery-addr-${Math.random().toString(36).slice(2)}`,
	);
	input.setAttribute("data-form-type", "other");
	input.setAttribute("data-lpignore", "true");
	input.setAttribute("data-1p-ignore", "true");

	// Inject styles if not already done
	injectAutofillBlockerStyles();

	// Remove name temporarily
	const originalName = input.name;
	if (originalName) {
		input.removeAttribute("name");
		setTimeout(() => {
			input.name = originalName;
		}, 100);
	}
}
