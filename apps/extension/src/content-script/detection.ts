import {
	type CreditCardFieldType,
	createEnhancedObserver,
	detectCredentialFields,
	detectCreditCardFields,
	detectIdentityFields,
	detectMultiStepForm,
	detectOTPFields,
	groupCreditCardFieldsByForm,
	groupIdentityFieldsByForm,
	type IdentityFieldType,
	observeShadowRoots,
} from "../lib/field-detection";
import {
	cleanupDetachedAutofillState,
	handleCreditCardFieldBlur,
	handleCreditCardFieldFocus,
	handleFieldBlur,
	handleFieldFocus,
	handleIdentityFieldBlur,
	handleIdentityFieldFocus,
	prewarmOverlay,
} from "./autofill";
import {
	disableChromeAutofill,
	disableChromeAutofillForCreditCard,
	disableChromeAutofillForIdentity,
	injectAutofillBlockerStyles,
} from "./browser-autofill";
import { attachFormSubmitListeners } from "./capture";
import { contentState, DETECTION_DEBOUNCE_MS } from "./state";
import type { CredentialField, CreditCardField, IdentityField } from "./types";

/**
 * Enhanced password field detection with support for:
 * - Shadow DOM traversal
 * - Multi-step forms
 * - Dynamic forms
 * - Advanced field type identification
 */
export function detectPasswordFields(root: Document | ShadowRoot = document) {
	// Use enhanced detection for comprehensive field discovery
	const enhancedFields = [
		...detectCredentialFields(root),
		...detectOTPFields(root),
	];

	for (const enhancedField of enhancedFields) {
		const input = enhancedField.element;

		if (contentState.detectedFields.has(input)) continue;

		// Only process credential-related fields with sufficient confidence
		if (enhancedField.confidence < 0.1) continue;

		// Filter to credential + OTP types
		if (
			!["username", "email", "password", "otp"].includes(enhancedField.type)
		) {
			continue;
		}

		const field: CredentialField = {
			input,
			type: enhancedField.type as "username" | "email" | "password" | "otp",
			confidence: enhancedField.confidence,
			shadowRoot: enhancedField.shadowRoot,
		};
		contentState.detectedFields.set(input, field);
		prewarmOverlay("credential");

		// Aggressively disable browser's native autofill
		// Chrome often ignores autocomplete="off", so we use multiple strategies
		disableChromeAutofill(input, field.type);
		input.setAttribute("data-bittery-detected", "true");

		// Also disable on the parent form if it exists
		const form = input.closest("form");
		if (form && !form.hasAttribute("data-bittery-processed")) {
			form.setAttribute("autocomplete", "off");
			form.setAttribute("data-lpignore", "true"); // LastPass ignore
			form.setAttribute("data-bittery-processed", "true");

			// Add CSS to hide Chrome's autofill dropdown UI
			injectAutofillBlockerStyles();

			// Detect multi-step form characteristics
			const multiStepInfo = detectMultiStepForm(form);
			if (multiStepInfo.isMultiStep) {
				form.setAttribute("data-bittery-multistep", "true");
				form.setAttribute(
					"data-bittery-total-steps",
					String(multiStepInfo.totalSteps),
				);
			}
		}

		// Add focus listener
		input.addEventListener("focus", () => handleFieldFocus(field));
		input.addEventListener("blur", () => handleFieldBlur(field));

		// Add form submission listeners
		if (form && !contentState.processedForms.has(form)) {
			attachFormSubmitListeners(form);
			contentState.processedForms.add(form);
		}
	}

	// Also scan for Shadow DOM roots and observe them
	scanForShadowRoots(root);

	// Detect credit card fields
	detectCreditCardFieldsOnPage(root);

	// Detect identity/address fields
	detectIdentityFieldsOnPage(root);
}

/**
 * Enhanced credit card field detection
 */
function detectCreditCardFieldsOnPage(root: Document | ShadowRoot = document) {
	const creditCardFields = detectCreditCardFields(root);
	const formGroups = groupCreditCardFieldsByForm(creditCardFields);

	for (const enhancedField of creditCardFields) {
		const input = enhancedField.element;

		if (contentState.detectedCreditCardFields.has(input)) continue;

		// Skip fields already registered as credential fields to avoid dual focus handlers
		if (contentState.detectedFields.has(input)) continue;

		// Only process credit card fields with sufficient confidence
		if (enhancedField.confidence < 0.1) continue;

		// Find the form group this field belongs to
		const formGroup = formGroups.find(
			(g) =>
				g.form === enhancedField.form ||
				g.cardNumberField?.element === input ||
				g.expiryField?.element === input ||
				g.cvvField?.element === input ||
				g.nameField?.element === input,
		);

		const field: CreditCardField = {
			input,
			type: enhancedField.type as CreditCardFieldType,
			confidence: enhancedField.confidence,
			shadowRoot: enhancedField.shadowRoot,
			formGroup,
		};
		contentState.detectedCreditCardFields.set(input, field);
		prewarmOverlay("creditCard");

		// Aggressively disable browser's native credit card autofill
		disableChromeAutofillForCreditCard(input);
		input.setAttribute("data-bittery-cc-detected", "true");

		// Add focus/blur listeners for credit card autofill
		input.addEventListener("focus", () => handleCreditCardFieldFocus(field));
		input.addEventListener("blur", () => handleCreditCardFieldBlur(field));
	}
}

/**
 * Enhanced identity field detection
 */
function detectIdentityFieldsOnPage(root: Document | ShadowRoot = document) {
	const identityFields = detectIdentityFields(root);
	const formGroups = groupIdentityFieldsByForm(identityFields);

	for (const enhancedField of identityFields) {
		const input = enhancedField.element;

		if (contentState.detectedIdentityFields.has(input)) continue;

		// Skip fields already registered as credential or credit card fields to avoid dual focus handlers
		if (contentState.detectedFields.has(input)) continue;
		if (contentState.detectedCreditCardFields.has(input)) continue;

		// Only process identity fields with sufficient confidence
		if (enhancedField.confidence < 0.1) continue;

		// Find the form group this field belongs to
		const formGroup = formGroups.find(
			(g) =>
				g.form === enhancedField.form ||
				g.firstNameField?.element === input ||
				g.lastNameField?.element === input ||
				g.emailField?.element === input ||
				g.phoneField?.element === input ||
				g.streetField?.element === input ||
				g.cityField?.element === input ||
				g.stateField?.element === input ||
				g.postalCodeField?.element === input ||
				g.countryField?.element === input ||
				g.dateOfBirthField?.element === input,
		);

		const field: IdentityField = {
			input,
			type: enhancedField.type as IdentityFieldType,
			confidence: enhancedField.confidence,
			shadowRoot: enhancedField.shadowRoot,
			formGroup,
		};
		contentState.detectedIdentityFields.set(input, field);
		prewarmOverlay("identity");

		// Aggressively disable browser's native address/identity autofill
		disableChromeAutofillForIdentity(input);
		input.setAttribute("data-bittery-identity-detected", "true");

		// Add focus/blur listeners for identity autofill
		input.addEventListener("focus", () => handleIdentityFieldFocus(field));
		input.addEventListener("blur", () => handleIdentityFieldBlur(field));
	}
}

/**
 * Scan for existing shadow roots in the document
 */
function scanForShadowRoots(root: Document | ShadowRoot = document) {
	const elements = root.querySelectorAll("*");
	for (const element of elements) {
		if (
			element.shadowRoot &&
			!contentState.observedShadowRoots.has(element.shadowRoot)
		) {
			contentState.observedShadowRoots.add(element.shadowRoot);
			// Detect fields within shadow root
			detectPasswordFields(element.shadowRoot);
			// Set up observer for this shadow root
			setupShadowRootObserver(element.shadowRoot);
		}
	}
}

/**
 * Set up mutation observer for a shadow root
 */
function setupShadowRootObserver(shadowRoot: ShadowRoot) {
	createEnhancedObserver(() => {
		// Debounce detection
		if (contentState.detectionTimeout) {
			clearTimeout(contentState.detectionTimeout);
		}
		contentState.detectionTimeout = setTimeout(() => {
			cleanupDetachedAutofillState();
			detectPasswordFields(shadowRoot);
		}, DETECTION_DEBOUNCE_MS);
	}, shadowRoot);
}

// Set up watcher for dynamically attached shadow roots
export function setupShadowRootWatcher() {
	observeShadowRoots((shadowRoot, _host) => {
		if (!contentState.observedShadowRoots.has(shadowRoot)) {
			contentState.observedShadowRoots.add(shadowRoot);
			// Small delay to allow shadow DOM content to initialize
			setTimeout(() => {
				detectPasswordFields(shadowRoot);
				setupShadowRootObserver(shadowRoot);
			}, 50);
		}
	});
}

export function setupDynamicDetectionObserver() {
	// Watch for dynamic content with enhanced observer
	createEnhancedObserver(() => {
		// Debounce detection to prevent excessive processing
		if (contentState.detectionTimeout) {
			clearTimeout(contentState.detectionTimeout);
		}
		contentState.detectionTimeout = setTimeout(() => {
			cleanupDetachedAutofillState();
			detectPasswordFields();
		}, DETECTION_DEBOUNCE_MS);
	}, document);
}
