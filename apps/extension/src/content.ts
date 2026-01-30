/**
 * Content Script
 * Detects password fields and injects autofill UI via shadow DOM
 * Enhanced with improved form field detection for complex forms
 */

import type { DecryptedItem } from "@bittery/shared/types";
import {
	type CreditCardFieldType,
	createEnhancedObserver,
	type DetectedCreditCardForm,
	type DetectedIdentityForm,
	detectCredentialFields,
	detectCreditCardFields,
	detectFieldType,
	detectIdentityFields,
	detectMultiStepForm,
	getAllInputs,
	groupCreditCardFieldsByForm,
	groupIdentityFieldsByForm,
	type IdentityFieldType,
	isFieldVisible,
	observeShadowRoots,
} from "./lib/field-detection";

console.log("Bittery content script loaded");

// Track if we've already injected autofill blocker styles
let autofillBlockerStylesInjected = false;

/**
 * Inject CSS to hide Chrome's autofill dropdown suggestions
 */
function injectAutofillBlockerStyles() {
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
function disableChromeAutofill(
	input: HTMLInputElement,
	fieldType: "username" | "email" | "password",
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
function disableChromeAutofillForCreditCard(input: HTMLInputElement) {
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
function disableChromeAutofillForIdentity(input: HTMLInputElement) {
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

interface CredentialField {
	input: HTMLInputElement;
	type: "username" | "email" | "password";
	overlay?: HTMLElement;
	icon?: HTMLElement;
	messageHandler?: (event: MessageEvent) => void;
	inputHandler?: (event: Event) => void;
	readyTimeout?: NodeJS.Timeout;
	confidence?: number;
	shadowRoot?: ShadowRoot;
	hasItems?: boolean;
}

interface CreditCardField {
	input: HTMLInputElement;
	type: CreditCardFieldType;
	overlay?: HTMLElement;
	icon?: HTMLElement;
	messageHandler?: (event: MessageEvent) => void;
	inputHandler?: (event: Event) => void;
	readyTimeout?: NodeJS.Timeout;
	confidence?: number;
	shadowRoot?: ShadowRoot;
	formGroup?: DetectedCreditCardForm;
	hasItems?: boolean;
}

interface IdentityField {
	input: HTMLInputElement;
	type: IdentityFieldType;
	overlay?: HTMLElement;
	icon?: HTMLElement;
	messageHandler?: (event: MessageEvent) => void;
	inputHandler?: (event: Event) => void;
	readyTimeout?: NodeJS.Timeout;
	confidence?: number;
	shadowRoot?: ShadowRoot;
	formGroup?: DetectedIdentityForm;
	hasItems?: boolean;
}

const detectedFields = new Map<HTMLInputElement, CredentialField>();
const detectedCreditCardFields = new Map<HTMLInputElement, CreditCardField>();
const detectedIdentityFields = new Map<HTMLInputElement, IdentityField>();
let currentFocusedField: CredentialField | null = null;
let currentFocusedCreditCardField: CreditCardField | null = null;
let currentFocusedIdentityField: IdentityField | null = null;

// Track if we're currently autofilling to prevent filter triggering
let isAutofilling = false;

// Visual feedback styles for autofilled fields
const AUTOFILL_HIGHLIGHT_STYLE = {
	boxShadow: "0 0 0 2px rgba(34, 197, 94, 0.5)",
	transition: "box-shadow 0.3s ease-out",
};
const AUTOFILL_SUCCESS_DURATION = 2000; // How long to show the success highlight

// Track forms to avoid duplicate listeners
const processedForms = new WeakSet<HTMLFormElement>();

// Track shadow roots we've observed
const observedShadowRoots = new WeakSet<ShadowRoot>();

// Track recent form submissions to prevent duplicates (debounce)
const recentFormSubmissions = new WeakMap<HTMLFormElement, number>();
const FORM_SUBMISSION_DEBOUNCE_MS = 500; // 500ms debounce window

// Track pending AJAX requests for form submission detection
interface PendingRequest {
	url: string;
	method: string;
	body: Document | XMLHttpRequestBodyInit | BodyInit | null | undefined;
	timestamp: number;
	form?: HTMLFormElement;
}
const pendingAjaxRequests = new Map<string, PendingRequest>();

// Debounce field detection to prevent excessive processing
let detectionTimeout: NodeJS.Timeout | null = null;
const DETECTION_DEBOUNCE_MS = 100;

/**
 * Enhanced password field detection with support for:
 * - Shadow DOM traversal
 * - Multi-step forms
 * - Dynamic forms
 * - Advanced field type identification
 */
function detectPasswordFields(root: Document | ShadowRoot = document) {
	// Use enhanced detection for comprehensive field discovery
	const enhancedFields = detectCredentialFields(root);

	for (const enhancedField of enhancedFields) {
		const input = enhancedField.element;

		if (detectedFields.has(input)) continue;

		// Only process credential-related fields with sufficient confidence
		if (enhancedField.confidence < 0.1) continue;

		// Filter to only username, email, and password types
		if (!["username", "email", "password"].includes(enhancedField.type)) {
			continue;
		}

		const field: CredentialField = {
			input,
			type: enhancedField.type as "username" | "email" | "password",
			confidence: enhancedField.confidence,
			shadowRoot: enhancedField.shadowRoot,
		};
		detectedFields.set(input, field);

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
				console.log(
					`Detected multi-step form: ${multiStepInfo.currentStep}/${multiStepInfo.totalSteps}`,
				);
			}
		}

		// Add focus listener
		input.addEventListener("focus", () => handleFieldFocus(field));
		input.addEventListener("blur", () => handleFieldBlur(field));

		// Add form submission listeners
		if (form && !processedForms.has(form)) {
			attachFormSubmitListeners(form);
			processedForms.add(form);
		}

		console.log(
			`Detected ${field.type} field with confidence ${field.confidence?.toFixed(2)}:`,
			input.name || input.id || "unnamed",
		);
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

		if (detectedCreditCardFields.has(input)) continue;

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
		detectedCreditCardFields.set(input, field);

		// Aggressively disable browser's native credit card autofill
		disableChromeAutofillForCreditCard(input);
		input.setAttribute("data-bittery-cc-detected", "true");

		// Add focus/blur listeners for credit card autofill
		input.addEventListener("focus", () => handleCreditCardFieldFocus(field));
		input.addEventListener("blur", () => handleCreditCardFieldBlur(field));

		console.log(
			`Detected credit card ${field.type} field with confidence ${field.confidence?.toFixed(2)}:`,
			input.name || input.id || "unnamed",
		);
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

		if (detectedIdentityFields.has(input)) continue;

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
		detectedIdentityFields.set(input, field);

		// Aggressively disable browser's native address/identity autofill
		disableChromeAutofillForIdentity(input);
		input.setAttribute("data-bittery-identity-detected", "true");

		// Add focus/blur listeners for identity autofill
		input.addEventListener("focus", () => handleIdentityFieldFocus(field));
		input.addEventListener("blur", () => handleIdentityFieldBlur(field));

		console.log(
			`Detected identity ${field.type} field with confidence ${field.confidence?.toFixed(2)}:`,
			input.name || input.id || "unnamed",
		);
	}
}

/**
 * Scan for existing shadow roots in the document
 */
function scanForShadowRoots(root: Document | ShadowRoot = document) {
	const elements = root.querySelectorAll("*");
	for (const element of elements) {
		if (element.shadowRoot && !observedShadowRoots.has(element.shadowRoot)) {
			observedShadowRoots.add(element.shadowRoot);
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
		if (detectionTimeout) {
			clearTimeout(detectionTimeout);
		}
		detectionTimeout = setTimeout(() => {
			detectPasswordFields(shadowRoot);
		}, DETECTION_DEBOUNCE_MS);
	}, shadowRoot);
}

/**
 * Legacy fallback detection for basic forms
 * Used when enhanced detection doesn't find fields
 */
function detectPasswordFieldsLegacy() {
	const inputs = document.querySelectorAll<HTMLInputElement>(
		'input[type="password"], input[type="email"], input[type="text"][autocomplete*="username"], input[type="text"][autocomplete*="email"]',
	);

	inputs.forEach((input) => {
		if (detectedFields.has(input)) return;

		// Determine field type
		let type: "username" | "email" | "password" = "username";
		if (input.type === "password") {
			type = "password";
		} else if (
			input.type === "email" ||
			input.autocomplete?.includes("email")
		) {
			type = "email";
		}

		const field: CredentialField = { input, type };
		detectedFields.set(input, field);

		// Disable browser's native autofill
		input.setAttribute("autocomplete", "off");
		input.setAttribute("data-form-type", "other");

		// Also disable on the parent form if it exists
		const form = input.closest("form");
		if (form && !form.hasAttribute("data-bittery-processed")) {
			form.setAttribute("autocomplete", "off");
			form.setAttribute("data-bittery-processed", "true");
		}

		// Add focus listener
		input.addEventListener("focus", () => handleFieldFocus(field));
		input.addEventListener("blur", () => handleFieldBlur(field));

		// Add form submission listeners
		if (form && !processedForms.has(form)) {
			attachFormSubmitListeners(form);
			processedForms.add(form);
		}
	});
}

// Attach form submission listeners
function attachFormSubmitListeners(form: HTMLFormElement) {
	// Track form interactions for AJAX detection
	const trackInteraction = () => trackFormInteraction(form);

	// Listen for form submit event (traditional submission)
	form.addEventListener(
		"submit",
		(event) => {
			trackInteraction();
			handleFormSubmit(event, form);
		},
		true, // Use capture phase to ensure we catch it early
	);

	// Listen for submit button clicks (in case form.submit() is called via JS)
	const submitButtons = form.querySelectorAll<
		HTMLButtonElement | HTMLInputElement
	>('button[type="submit"], input[type="submit"], button:not([type])');

	submitButtons.forEach((button) => {
		button.addEventListener("click", () => {
			trackInteraction();
			// Wait a tiny bit for the form to process the click
			setTimeout(() => {
				// Check if form is still valid and might be submitting
				if (form.checkValidity()) {
					handleFormSubmit(null, form);
				}
			}, 50);
		});
	});

	// Listen for Enter key in input fields (common form submission trigger)
	const formInputs = form.querySelectorAll<HTMLInputElement>("input");
	formInputs.forEach((input) => {
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && !event.shiftKey) {
				trackInteraction();
				// Wait for form to process the Enter key
				setTimeout(() => {
					if (form.checkValidity()) {
						handleFormSubmit(null, form);
					}
				}, 50);
			}
		});
	});
}

// Capture credentials from a form
interface CapturedCredentials {
	username: string;
	password: string;
	url: string;
	hostname: string;
	usernameField?: HTMLInputElement;
	passwordField?: HTMLInputElement;
}

function captureCredentials(
	form?: HTMLFormElement,
): CapturedCredentials | null {
	// Determine the scope to search for fields
	const searchScope = form || document;

	// Find password field - prioritize detected fields, then search the form/document
	let passwordField: HTMLInputElement | undefined;
	let passwordValue = "";

	// First, check our detected fields for password fields in this form
	// Sort by confidence if available
	const passwordCandidates: Array<{
		input: HTMLInputElement;
		field: CredentialField;
	}> = [];

	for (const [input, field] of detectedFields) {
		if (field.type === "password" && input.value) {
			// If we have a form, ensure the field is within this form
			if (!form || input.closest("form") === form) {
				passwordCandidates.push({ input, field });
			}
		}
	}

	// Sort by confidence and visibility
	if (passwordCandidates.length > 0) {
		passwordCandidates.sort((a, b) => {
			// Prefer visible fields
			const aVisible = isFieldVisible(a.input);
			const bVisible = isFieldVisible(b.input);
			if (aVisible && !bVisible) return -1;
			if (!aVisible && bVisible) return 1;
			// Then by confidence
			return (b.field.confidence || 0) - (a.field.confidence || 0);
		});
		const firstCandidate = passwordCandidates[0];
		if (firstCandidate) {
			passwordField = firstCandidate.input;
			passwordValue = passwordField.value;
		}
	}

	// Fallback: search for password fields in the scope (including Shadow DOM)
	if (!passwordField) {
		const allInputs = getAllInputs(
			searchScope instanceof Document ? searchScope : document,
		);
		const passwordFields = allInputs
			.filter(({ input }) => input.type === "password" && input.value)
			.filter(
				({ input }) =>
					!form || input.closest("form") === form || !input.closest("form"),
			);

		if (passwordFields.length > 0) {
			// Prefer visible fields
			const visibleField = passwordFields.find(({ input }) =>
				isFieldVisible(input),
			);
			const firstPasswordField = passwordFields[0];
			passwordField = visibleField?.input || firstPasswordField?.input;
			passwordValue = passwordField?.value || "";
		}
	}

	// If no password found, we can't capture credentials
	if (!passwordValue || !passwordField) {
		console.log("No password field found or password is empty");
		return null;
	}

	// Find username/email field
	let usernameField: HTMLInputElement | undefined;
	let usernameValue = "";

	// First, check our detected fields for username/email fields in this form
	// Sort by confidence if available
	const usernameCandidates: Array<{
		input: HTMLInputElement;
		field: CredentialField;
	}> = [];

	for (const [input, field] of detectedFields) {
		if ((field.type === "username" || field.type === "email") && input.value) {
			// If we have a form, ensure the field is within this form
			if (!form || input.closest("form") === form) {
				usernameCandidates.push({ input, field });
			}
		}
	}

	// Sort by confidence and visibility
	if (usernameCandidates.length > 0) {
		usernameCandidates.sort((a, b) => {
			// Prefer visible fields
			const aVisible = isFieldVisible(a.input);
			const bVisible = isFieldVisible(b.input);
			if (aVisible && !bVisible) return -1;
			if (!aVisible && bVisible) return 1;
			// Then by confidence
			return (b.field.confidence || 0) - (a.field.confidence || 0);
		});
		const firstUsernameCandidate = usernameCandidates[0];
		if (firstUsernameCandidate) {
			usernameField = firstUsernameCandidate.input;
			usernameValue = usernameField.value;
		}
	}

	// Fallback: search for username/email fields in the scope (including Shadow DOM)
	if (!usernameField) {
		const allInputs = getAllInputs(
			searchScope instanceof Document ? searchScope : document,
		);

		const candidateFields = allInputs.filter(({ input }) => {
			// Exclude password fields and empty fields
			if (input.type === "password" || !input.value) return false;

			// If we have a form, ensure the field is within this form
			if (form && input.closest("form") !== form && input.closest("form"))
				return false;

			// Use enhanced field type detection
			const { type, confidence } = detectFieldType(input);

			// Check if it looks like a username/email field with sufficient confidence
			if ((type === "username" || type === "email") && confidence >= 0.2) {
				return true;
			}

			// Legacy check for backwards compatibility
			const name = input.name?.toLowerCase() || "";
			const id = input.id?.toLowerCase() || "";
			const autocomplete = input.autocomplete?.toLowerCase() || "";
			const placeholder = input.placeholder?.toLowerCase() || "";

			return (
				input.type === "email" ||
				autocomplete.includes("username") ||
				autocomplete.includes("email") ||
				name.includes("user") ||
				name.includes("email") ||
				name.includes("login") ||
				name.includes("identifier") ||
				name.includes("account") ||
				id.includes("user") ||
				id.includes("email") ||
				id.includes("login") ||
				id.includes("identifier") ||
				id.includes("account") ||
				placeholder.includes("user") ||
				placeholder.includes("email") ||
				placeholder.includes("login")
			);
		});

		if (candidateFields.length > 0) {
			// Prefer visible fields
			const visibleField = candidateFields.find(({ input }) =>
				isFieldVisible(input),
			);
			const firstCandidateField = candidateFields[0];
			usernameField = visibleField?.input || firstCandidateField?.input;
			usernameValue = usernameField?.value || "";
		}
	}

	// If no username found, we might still want to capture just the password
	// but for login forms, username is typically required
	if (!usernameValue) {
		console.log("No username field found or username is empty");
		// Still return null for now - we need both username and password
		// This could be adjusted in the future if needed
		return null;
	}

	// Capture URL information
	const url = window.location.href;
	const hostname = window.location.hostname;

	return {
		username: usernameValue,
		password: passwordValue,
		url,
		hostname,
		usernameField,
		passwordField,
	};
}

// Check if credentials should be saved
async function shouldSaveCredentials(
	credentials: CapturedCredentials,
): Promise<{ shouldSave: boolean; reason?: string }> {
	// Validate that credentials have required fields
	if (!credentials.username || !credentials.password) {
		return {
			shouldSave: false,
			reason: "Missing username or password",
		};
	}

	// Validate username is not too short (likely invalid)
	if (credentials.username.trim().length < 2) {
		return {
			shouldSave: false,
			reason: "Username too short (likely invalid)",
		};
	}

	// Validate password is not too short (likely invalid)
	if (credentials.password.length < 3) {
		return {
			shouldSave: false,
			reason: "Password too short (likely invalid)",
		};
	}

	// Check if extension is unlocked
	try {
		const authResponse = await chrome.runtime.sendMessage({
			type: "CHECK_AUTH",
		});

		if (!authResponse.unlocked) {
			console.log("Extension is locked - cannot save credentials");
			return {
				shouldSave: false,
				reason: "Extension is locked",
			};
		}

		// All checks passed
		return {
			shouldSave: true,
		};
	} catch (error) {
		console.error("Error checking auth status:", error);
		return {
			shouldSave: false,
			reason: "Failed to check extension lock state",
		};
	}
}

// Handle form submission
async function handleFormSubmit(_event: Event | null, form: HTMLFormElement) {
	// Check if we recently processed this form (debounce to prevent duplicates)
	const now = Date.now();
	const lastSubmission = recentFormSubmissions.get(form);

	if (lastSubmission && now - lastSubmission < FORM_SUBMISSION_DEBOUNCE_MS) {
		console.log("Form submission debounced - recently processed this form");
		return;
	}

	// Mark this form as recently submitted
	recentFormSubmissions.set(form, now);

	console.log("Form submission detected:", form);

	// Capture credentials from the form
	const credentials = captureCredentials(form);

	if (credentials) {
		console.log("Captured credentials:", {
			username: credentials.username,
			url: credentials.url,
			hostname: credentials.hostname,
			// Don't log password for security
		});

		// Check if credentials should be saved
		const { shouldSave, reason } = await shouldSaveCredentials(credentials);

		if (shouldSave) {
			console.log(
				"Credentials are valid and extension is unlocked - ready to show save prompt",
			);
			// Show save prompt to user
			showSavePrompt(credentials);
		} else {
			console.log("Credentials will not be saved:", reason);
		}
	} else {
		console.log("Could not capture credentials from form");
	}
}

// ==================== AJAX Detection ====================

// Intercept XMLHttpRequest
const originalXHROpen = XMLHttpRequest.prototype.open;
const originalXHRSend = XMLHttpRequest.prototype.send;

XMLHttpRequest.prototype.open = function (
	method: string,
	url: string | URL,
	async?: boolean,
	username?: string | null,
	password?: string | null,
) {
	// Store request info on the XHR instance
	interface XHRWithRequestInfo extends XMLHttpRequest {
		_bitteryRequestInfo?: { method: string; url: string };
	}
	(this as XHRWithRequestInfo)._bitteryRequestInfo = {
		method: method.toUpperCase(),
		url: url.toString(),
	};
	return originalXHROpen.call(
		this,
		method,
		url,
		async ?? true,
		username ?? null,
		password ?? null,
	);
};

XMLHttpRequest.prototype.send = function (
	body?: Document | XMLHttpRequestBodyInit | null,
) {
	interface XHRWithRequestInfo extends XMLHttpRequest {
		_bitteryRequestInfo?: { method: string; url: string };
	}
	const requestInfo = (this as XHRWithRequestInfo)._bitteryRequestInfo;

	if (
		requestInfo &&
		(requestInfo.method === "POST" || requestInfo.method === "PUT")
	) {
		// Check if this looks like a login request
		if (isLikelyLoginRequest(requestInfo.url, body)) {
			const requestId = `xhr_${Date.now()}_${Math.random()}`;

			// Find associated form if any
			const form = findRecentlyInteractedForm();

			pendingAjaxRequests.set(requestId, {
				url: requestInfo.url,
				method: requestInfo.method,
				body: body,
				timestamp: Date.now(),
				form: form || undefined,
			});

			// Listen for response
			this.addEventListener("readystatechange", function () {
				if (this.readyState === 4) {
					handleAjaxResponse(requestId, this.status, form);
				}
			});
		}
	}

	return originalXHRSend.apply(this, [body]);
};

// Intercept fetch API
const originalFetch = window.fetch;
window.fetch = function (
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> {
	const url =
		typeof input === "string"
			? input
			: input instanceof URL
				? input.toString()
				: input.url;
	const method = init?.method?.toUpperCase() || "GET";

	if (method === "POST" || method === "PUT") {
		// Check if this looks like a login request
		if (isLikelyLoginRequest(url, init?.body)) {
			const requestId = `fetch_${Date.now()}_${Math.random()}`;

			// Find associated form if any
			const form = findRecentlyInteractedForm();

			pendingAjaxRequests.set(requestId, {
				url: url,
				method: method,
				body: init?.body,
				timestamp: Date.now(),
				form: form || undefined,
			});

			// Call original fetch and handle response
			return originalFetch
				.apply(this, [input, init])
				.then((response) => {
					handleAjaxResponse(requestId, response.status, form);
					return response;
				})
				.catch((error) => {
					// Clean up on error
					pendingAjaxRequests.delete(requestId);
					throw error;
				});
		}
	}

	return originalFetch.apply(this, [input, init]);
};

// Check if a request looks like a login/authentication request
function isLikelyLoginRequest(
	url: string,
	body: Document | XMLHttpRequestBodyInit | BodyInit | null | undefined,
): boolean {
	const urlLower = url.toLowerCase();

	// Check URL for common login/auth patterns
	const loginUrlPatterns = [
		"login",
		"signin",
		"sign-in",
		"authenticate",
		"auth",
		"session",
		"account",
		"user",
	];

	const hasLoginUrl = loginUrlPatterns.some((pattern) =>
		urlLower.includes(pattern),
	);

	// Check if body contains password-like fields
	let hasPasswordField = false;
	if (body) {
		try {
			let bodyStr = "";
			if (typeof body === "string") {
				bodyStr = body.toLowerCase();
			} else if (body instanceof FormData) {
				// Check FormData keys
				for (const key of (body as FormData).keys()) {
					if (
						key.toLowerCase().includes("password") ||
						key.toLowerCase().includes("pass")
					) {
						hasPasswordField = true;
						break;
					}
				}
			} else if (body instanceof URLSearchParams) {
				bodyStr = body.toString().toLowerCase();
			} else {
				bodyStr = JSON.stringify(body).toLowerCase();
			}

			if (!hasPasswordField && bodyStr) {
				hasPasswordField =
					bodyStr.includes("password") || bodyStr.includes("passwd");
			}
		} catch {
			// Ignore errors parsing body
		}
	}

	// Consider it a login request if URL suggests login OR body has password
	return hasLoginUrl || hasPasswordField;
}

// Find the most recently interacted form
let lastInteractedForm: HTMLFormElement | null = null;
let lastInteractionTime = 0;

function findRecentlyInteractedForm(): HTMLFormElement | null {
	// Return form if interaction was recent (within 5 seconds)
	if (lastInteractedForm && Date.now() - lastInteractionTime < 5000) {
		return lastInteractedForm;
	}
	return null;
}

// Track form interactions to associate AJAX requests with forms
function trackFormInteraction(form: HTMLFormElement) {
	lastInteractedForm = form;
	lastInteractionTime = Date.now();
}

// Handle AJAX response
function handleAjaxResponse(
	requestId: string,
	statusCode: number,
	form?: HTMLFormElement | null,
) {
	const request = pendingAjaxRequests.get(requestId);
	if (!request) return;

	// Consider successful responses (2xx) as potential successful logins
	if (statusCode >= 200 && statusCode < 300) {
		console.log("AJAX login request detected:", request.url, statusCode);

		// Treat this like a form submission
		if (form) {
			handleFormSubmit(null, form);
		} else {
			// If no form is associated, try to find password fields on the page
			// This will be useful for custom login implementations
			console.log(
				"AJAX login detected but no form associated - credentials may have been submitted",
			);
			handleAjaxLoginWithoutForm(request);
		}
	}

	// Clean up old requests (older than 30 seconds)
	const now = Date.now();
	for (const [id, req] of pendingAjaxRequests.entries()) {
		if (now - req.timestamp > 30000) {
			pendingAjaxRequests.delete(id);
		}
	}

	pendingAjaxRequests.delete(requestId);
}

// Handle AJAX login when no form is associated
async function handleAjaxLoginWithoutForm(_request: PendingRequest) {
	console.log("Detected AJAX login without associated form");

	// Try to capture credentials from the page (without a specific form)
	const credentials = captureCredentials();

	if (credentials) {
		console.log("Captured credentials from AJAX request:", {
			username: credentials.username,
			url: credentials.url,
			hostname: credentials.hostname,
			// Don't log password for security
		});

		// Check if credentials should be saved
		const { shouldSave, reason } = await shouldSaveCredentials(credentials);

		if (shouldSave) {
			console.log(
				"Credentials are valid and extension is unlocked - ready to show save prompt",
			);
			// Show save prompt to user
			showSavePrompt(credentials);
		} else {
			console.log("Credentials will not be saved:", reason);
		}
	} else {
		console.log("Could not capture credentials from AJAX login");
	}
}

// ==================== End AJAX Detection ====================

// ==================== Save Prompt ====================

// Track active save prompt
let activeSavePrompt: {
	shadowHost: HTMLElement;
	messageHandler: (event: MessageEvent) => void;
} | null = null;

type SavePromptOptions = {
	persist?: boolean;
};

function persistPendingSavePrompt(credentials: CapturedCredentials) {
	chrome.runtime
		.sendMessage({
			type: "SET_PENDING_SAVE_PROMPT",
			payload: {
				username: credentials.username,
				password: credentials.password,
				url: credentials.url,
				hostname: credentials.hostname,
			},
		})
		.catch((error) => {
			console.warn("Failed to persist save prompt:", error);
		});
}

function clearPendingSavePrompt() {
	chrome.runtime
		.sendMessage({ type: "CLEAR_PENDING_SAVE_PROMPT" })
		.catch((error) => {
			console.warn("Failed to clear save prompt:", error);
		});
}

async function restorePendingSavePrompt() {
	try {
		const response = await chrome.runtime.sendMessage({
			type: "GET_PENDING_SAVE_PROMPT",
		});

		if (response?.data) {
			await showSavePrompt(response.data, { persist: false });
		}
	} catch (error) {
		console.warn("Failed to restore save prompt:", error);
	}
}

// Show save prompt overlay
async function showSavePrompt(
	credentials: CapturedCredentials,
	options?: SavePromptOptions,
) {
	// Remove any existing save prompt
	if (activeSavePrompt) {
		hideSavePrompt();
	}

	if (options?.persist !== false) {
		persistPendingSavePrompt(credentials);
	}

	// Check for existing credentials before showing the prompt
	interface ExistingCredential {
		id: string;
		vaultId: string;
		username: string;
		url: string;
	}
	let existingCredentials: ExistingCredential[] = [];
	let hasDuplicates = false;
	let hasChanges = true; // Default to true (show prompt if check fails)
	try {
		const duplicateCheckResponse = await chrome.runtime.sendMessage({
			type: "CHECK_EXISTING_CREDENTIALS",
			payload: {
				url: credentials.url,
				username: credentials.username,
				password: credentials.password, // Pass password to check for changes
			},
		});

		if (duplicateCheckResponse.success) {
			existingCredentials = duplicateCheckResponse.existingCredentials || [];
			hasDuplicates = duplicateCheckResponse.hasDuplicates || false;
			hasChanges = duplicateCheckResponse.hasChanges ?? true; // Use ?? to handle undefined
		}
	} catch (error) {
		console.error("Error checking for existing credentials:", error);
		// Continue with empty array - if check fails, we'll treat as no duplicates
	}

	// Only show the prompt if credentials are new or have changed (like 1Password)
	if (!hasChanges) {
		console.log(
			"Credentials unchanged - skipping save prompt (matches existing credential)",
		);
		return;
	}

	// Get writable vaults from background script
	interface VaultOption {
		id: string;
		name: string;
		type: "personal" | "team";
		role: "owner" | "admin" | "member" | "read-only";
	}
	let vaults: VaultOption[] = [];
	try {
		const vaultsResponse = await chrome.runtime.sendMessage({
			type: "GET_WRITABLE_VAULTS",
		});

		if (vaultsResponse.vaults) {
			vaults = vaultsResponse.vaults;
		}
	} catch (error) {
		console.error("Error fetching writable vaults:", error);
		// Continue with empty vaults array - UI will handle the error state
	}

	// Create shadow host
	const shadowHost = document.createElement("div");
	shadowHost.style.position = "fixed";
	shadowHost.style.top = "20px";
	shadowHost.style.right = "20px";
	shadowHost.style.zIndex = "2147483647"; // Max z-index
	shadowHost.style.width = "360px";
	shadowHost.style.opacity = "0";
	shadowHost.style.transform = "translateY(-8px)";
	shadowHost.style.transition =
		"opacity 0.2s ease-out, transform 0.2s ease-out";
	document.body.appendChild(shadowHost);

	// Attach shadow DOM
	const shadow = shadowHost.attachShadow({ mode: "open" });

	// Create iframe
	const iframe = document.createElement("iframe");
	iframe.style.border = "none";
	iframe.style.width = "100%";
	iframe.style.height = "0px"; // Start with 0 height, allow content to dictate
	iframe.style.minHeight = "50px";
	iframe.style.display = "block";
	iframe.style.borderRadius = "8px"; // Match popup radius
	iframe.style.boxShadow = "0 4px 12px rgba(0, 0, 0, 0.15)"; // Softer shadow
	iframe.style.overflow = "hidden"; // Prevent scrollbars
	iframe.src = chrome.runtime.getURL("save-prompt-iframe.html");

	shadow.appendChild(iframe);

	// Trigger animation after a brief delay
	setTimeout(() => {
		shadowHost.style.opacity = "1";
		shadowHost.style.transform = "translateY(0)";
	}, 10);

	// Set up message handler
	const messageHandler = (event: MessageEvent) => {
		// Ignore messages not from our iframe
		if (!event.data?.type) return;

		// Log all messages for debugging (only save-related and resize messages)
		if (
			event.data.type.includes("SAVE") ||
			event.data.type === "RESIZE_IFRAME"
		) {
			console.log("Content script received message:", event.data.type);
		}

		if (event.data.type === "SAVE_IFRAME_READY") {
			// Send credentials, vaults, and duplicate info to iframe
			iframe.contentWindow?.postMessage(
				{
					type: "SAVE_PROMPT_DATA",
					data: {
						username: credentials.username,
						password: credentials.password,
						url: credentials.url,
						vaults: vaults,
						hasDuplicates: hasDuplicates,
						existingCredentials: existingCredentials,
					},
				},
				"*",
			);
		} else if (event.data.type === "RESIZE_IFRAME") {
			if (event.data.height > 0) {
				iframe.style.height = `${event.data.height}px`;
			}
		} else if (event.data.type === "SAVE_CREDENTIAL") {
			handleSaveCredential(event.data, iframe);
		} else if (event.data.type === "UPDATE_EXISTING_CREDENTIAL") {
			handleUpdateCredential(event.data, iframe);
		} else if (event.data.type === "CANCEL_SAVE") {
			console.log("Content script: Hiding save prompt due to CANCEL_SAVE");
			hideSavePrompt();
		}
	};

	window.addEventListener("message", messageHandler);

	// Store reference
	activeSavePrompt = {
		shadowHost,
		messageHandler,
	};

	// Auto-hide after 30 seconds if user doesn't interact
	setTimeout(() => {
		if (activeSavePrompt && activeSavePrompt.shadowHost === shadowHost) {
			hideSavePrompt();
		}
	}, 30000);
}

// Hide save prompt
function hideSavePrompt() {
	if (!activeSavePrompt) {
		console.log("Content script: hideSavePrompt called but no active prompt");
		return;
	}

	console.log("Content script: Hiding save prompt");
	clearPendingSavePrompt();

	// Store reference to current prompt before clearing
	const promptToRemove = activeSavePrompt;

	// Clear the active prompt reference immediately to prevent duplicate closes
	activeSavePrompt = null;

	// Fade out
	promptToRemove.shadowHost.style.opacity = "0";
	promptToRemove.shadowHost.style.transform = "translateY(-8px)";

	// Remove after animation
	setTimeout(() => {
		try {
			promptToRemove.shadowHost.remove();
			window.removeEventListener("message", promptToRemove.messageHandler);
			console.log("Content script: Save prompt removed successfully");
		} catch (error) {
			console.error("Error removing save prompt:", error);
		}
	}, 200);
}

// Handle save credential request
async function handleSaveCredential(
	data: { vaultId: string; username: string; password: string; url: string },
	iframe: HTMLIFrameElement,
) {
	try {
		// Send save request to background script
		const response = await chrome.runtime.sendMessage({
			type: "SAVE_NEW_CREDENTIAL",
			payload: {
				vaultId: data.vaultId,
				username: data.username,
				password: data.password,
				url: data.url,
			},
		});

		// Send result back to iframe
		iframe.contentWindow?.postMessage(
			{
				type: "SAVE_RESULT",
				success: response.success,
				error: response.error,
				errorType: response.errorType,
			},
			"*",
		);

		// If successful, hide prompt after brief delay (handled by iframe)
		if (response.success) {
			console.log("Credentials saved successfully");
		} else {
			console.error("Failed to save credentials:", response.error);
		}
	} catch (error) {
		console.error("Error saving credentials:", error);
		// Send error to iframe
		iframe.contentWindow?.postMessage(
			{
				type: "SAVE_RESULT",
				success: false,
				error:
					error instanceof Error
						? error.message
						: "An unexpected error occurred. Please try again.",
				errorType: "exception",
			},
			"*",
		);
	}
}

// Handle update credential request
async function handleUpdateCredential(
	data: {
		itemId: string;
		vaultId: string;
		username: string;
		password: string;
		url: string;
	},
	iframe: HTMLIFrameElement,
) {
	try {
		// Send update request to background script
		const response = await chrome.runtime.sendMessage({
			type: "UPDATE_EXISTING_CREDENTIAL",
			payload: {
				itemId: data.itemId,
				vaultId: data.vaultId,
				username: data.username,
				password: data.password,
				url: data.url,
			},
		});

		// Send result back to iframe
		iframe.contentWindow?.postMessage(
			{
				type: "SAVE_RESULT",
				success: response.success,
				error: response.error,
				errorType: response.errorType,
			},
			"*",
		);

		// If successful, hide prompt after brief delay (handled by iframe)
		if (response.success) {
			console.log("Credentials updated successfully");
		} else {
			console.error("Failed to update credentials:", response.error);
		}
	} catch (error) {
		console.error("Error updating credentials:", error);
		// Send error to iframe
		iframe.contentWindow?.postMessage(
			{
				type: "SAVE_RESULT",
				success: false,
				error:
					error instanceof Error
						? error.message
						: "An unexpected error occurred. Please try again.",
				errorType: "exception",
			},
			"*",
		);
	}
}

// ==================== End Save Prompt ====================

// Handle field focus
async function handleFieldFocus(field: CredentialField) {
	// Hide any existing overlays from other fields
	if (currentFocusedField && currentFocusedField !== field) {
		hideAutofillOverlay(currentFocusedField);
		hideFieldIcon(currentFocusedField);
	}

	currentFocusedField = field;

	// Check auth status before showing autofill
	const response = await chrome.runtime.sendMessage({
		type: "CHECK_AUTOFILL_AUTH",
	});

	if (!response.authenticated) {
		// Show icon even when locked (to indicate autofill is available)
		field.hasItems = false;
		showFieldIcon(field, false);

		if (response.needsReauth) {
			showReauthPrompt(field);
		} else {
			// Extension is locked, needs quick unlock
			showUnlockPrompt(field);
		}
		return;
	}

	// Get available logins for current site
	const hostname = window.location.hostname;
	const itemsResponse = await chrome.runtime.sendMessage({
		type: "GET_AUTOFILL_ITEMS",
		payload: { hostname },
	});

	const hasItems = itemsResponse.items && itemsResponse.items.length > 0;
	field.hasItems = hasItems;

	// Show icon if there are items
	if (hasItems) {
		showFieldIcon(field, true);
		showAutofillOverlay(field, itemsResponse.items);
	} else {
		// Still show icon to indicate field is detected, but no items available
		showFieldIcon(field, false);
	}
}

// Handle field blur
function handleFieldBlur(field: CredentialField) {
	// Delay to allow clicking on overlay or icon
	setTimeout(() => {
		if (currentFocusedField === field) {
			hideAutofillOverlay(field);
			hideFieldIcon(field);
			currentFocusedField = null;
		}
	}, 200);
}

// ==================== Credit Card Autofill ====================

// Handle credit card field focus
async function handleCreditCardFieldFocus(field: CreditCardField) {
	// Hide any existing overlays from other fields
	if (
		currentFocusedCreditCardField &&
		currentFocusedCreditCardField !== field
	) {
		hideCreditCardAutofillOverlay(currentFocusedCreditCardField);
		hideFieldIcon(currentFocusedCreditCardField);
	}
	// Also hide credential overlays
	if (currentFocusedField) {
		hideAutofillOverlay(currentFocusedField);
		hideFieldIcon(currentFocusedField);
		currentFocusedField = null;
	}

	currentFocusedCreditCardField = field;

	// Check auth status before showing autofill
	const response = await chrome.runtime.sendMessage({
		type: "CHECK_AUTOFILL_AUTH",
	});

	if (!response.authenticated) {
		// Show icon even when locked
		field.hasItems = false;
		showFieldIcon(field, false);

		if (response.needsReauth) {
			showCreditCardReauthPrompt(field);
		} else {
			// Extension is locked, needs quick unlock
			showCreditCardUnlockPrompt(field);
		}
		return;
	}

	// Get available credit cards
	const itemsResponse = await chrome.runtime.sendMessage({
		type: "GET_AUTOFILL_CREDIT_CARDS",
	});

	const hasItems = itemsResponse.items && itemsResponse.items.length > 0;
	field.hasItems = hasItems;

	// Show icon if there are items
	if (hasItems) {
		showFieldIcon(field, true);
		showCreditCardAutofillOverlay(field, itemsResponse.items);
	} else {
		showFieldIcon(field, false);
	}
}

// Handle credit card field blur
function handleCreditCardFieldBlur(field: CreditCardField) {
	// Delay to allow clicking on overlay or icon
	setTimeout(() => {
		if (currentFocusedCreditCardField === field) {
			hideCreditCardAutofillOverlay(field);
			hideFieldIcon(field);
			currentFocusedCreditCardField = null;
		}
	}, 200);
}

// Show credit card autofill overlay
function showCreditCardAutofillOverlay(
	field: CreditCardField,
	items: DecryptedItem[],
) {
	// Remove existing overlay
	if (field.overlay) {
		field.overlay.remove();
	}

	// Create shadow host
	const shadowHost = document.createElement("div");
	shadowHost.style.position = "fixed";
	shadowHost.style.zIndex = "2147483647"; // Max z-index
	shadowHost.style.opacity = "0";
	shadowHost.style.transform = "translateY(-8px)";
	shadowHost.style.transition =
		"opacity 0.15s ease-out, transform 0.15s ease-out";
	document.body.appendChild(shadowHost);

	// Attach shadow DOM
	const shadow = shadowHost.attachShadow({ mode: "open" });

	// Position overlay
	const rect = field.input.getBoundingClientRect();
	shadowHost.style.top = `${rect.bottom + window.scrollY}px`;
	shadowHost.style.left = `${rect.left}px`;
	shadowHost.style.width = `${Math.max(rect.width, 300)}px`;

	// Create iframe for credit card selection
	const iframe = document.createElement("iframe");
	iframe.style.border = "none";
	iframe.style.width = "100%";
	iframe.style.height = "auto";
	iframe.style.maxHeight = "300px";
	iframe.style.display = "block";
	iframe.src = chrome.runtime.getURL("credit-card-autofill-iframe.html");

	shadow.appendChild(iframe);
	field.overlay = shadowHost;

	// Trigger animation after a brief delay
	setTimeout(() => {
		shadowHost.style.opacity = "1";
		shadowHost.style.transform = "translateY(0)";
	}, 10);

	// Wait for iframe to signal it's ready
	const messageHandler = (event: MessageEvent) => {
		if (event.data.type === "CC_IFRAME_READY") {
			if (field.readyTimeout) {
				clearTimeout(field.readyTimeout);
				field.readyTimeout = undefined;
			}

			// Send credit card items to iframe
			iframe.contentWindow?.postMessage(
				{
					type: "CREDIT_CARD_ITEMS",
					items,
					fieldType: field.type,
				},
				"*",
			);
		} else if (event.data.type === "CREDIT_CARD_SELECT") {
			handleCreditCardAutofillSelect(field, event.data.item);
		}
	};

	field.messageHandler = messageHandler;
	window.addEventListener("message", messageHandler);

	// Fallback: send items after a delay if ready signal not received
	field.readyTimeout = setTimeout(() => {
		console.log(
			"Timeout waiting for credit card iframe ready, sending items anyway",
		);
		iframe.contentWindow?.postMessage(
			{
				type: "CREDIT_CARD_ITEMS",
				items,
				fieldType: field.type,
			},
			"*",
		);
	}, 100);

	// Add keyboard navigation
	document.addEventListener("keydown", handleCreditCardKeyboardNavigation);

	// Add input event listener for real-time filtering
	let filterTimeout: NodeJS.Timeout;
	const inputHandler = (event: Event) => {
		if (isAutofilling) return;

		const input = event.target as HTMLInputElement;
		const query = input.value;

		// Debounce filtering (150ms)
		clearTimeout(filterTimeout);
		filterTimeout = setTimeout(() => {
			iframe.contentWindow?.postMessage(
				{
					type: "FILTER_CREDIT_CARDS",
					query,
				},
				"*",
			);
		}, 150);
	};

	field.inputHandler = inputHandler;
	field.input.addEventListener("input", inputHandler);
}

// Hide credit card autofill overlay
function hideCreditCardAutofillOverlay(field: CreditCardField) {
	if (field.overlay) {
		field.overlay.remove();
		field.overlay = undefined;
	}
	if (field.messageHandler) {
		window.removeEventListener("message", field.messageHandler);
		field.messageHandler = undefined;
	}
	if (field.inputHandler) {
		field.input.removeEventListener("input", field.inputHandler);
		field.inputHandler = undefined;
	}
	if (field.readyTimeout) {
		clearTimeout(field.readyTimeout);
		field.readyTimeout = undefined;
	}
	document.removeEventListener("keydown", handleCreditCardKeyboardNavigation);
}

// Handle keyboard navigation for credit card overlay
function handleCreditCardKeyboardNavigation(event: KeyboardEvent) {
	if (event.key === "Escape") {
		if (currentFocusedCreditCardField) {
			hideCreditCardAutofillOverlay(currentFocusedCreditCardField);
			currentFocusedCreditCardField = null;
		}
	}
	// Arrow keys and Enter are handled by iframe
}

// Apply visual feedback highlight to an input field
function applyAutofillHighlight(input: HTMLInputElement) {
	// Store original styles
	const originalBoxShadow = input.style.boxShadow;
	const originalTransition = input.style.transition;

	// Apply highlight
	input.style.boxShadow = AUTOFILL_HIGHLIGHT_STYLE.boxShadow;
	input.style.transition = AUTOFILL_HIGHLIGHT_STYLE.transition;

	// Mark as autofilled for potential CSS targeting
	input.setAttribute("data-bittery-autofilled", "true");

	// Remove highlight after duration
	setTimeout(() => {
		input.style.boxShadow = originalBoxShadow;
		input.style.transition = originalTransition;
		// Keep the data attribute for reference but mark as complete
		input.setAttribute("data-bittery-autofilled", "complete");
	}, AUTOFILL_SUCCESS_DURATION);
}

// Handle credit card autofill selection
async function handleCreditCardAutofillSelect(
	field: CreditCardField,
	item: DecryptedItem,
) {
	// Update autofill timestamp
	await chrome.runtime.sendMessage({
		type: "UPDATE_AUTOFILL_TIMESTAMP",
	});

	// Set flag to prevent filtering during autofill
	isAutofilling = true;

	// Get the form group to fill all related fields
	const formGroup = field.formGroup;

	// Helper function to fill a field with visual feedback
	const fillField = (input: HTMLInputElement, value: string) => {
		if (!value) return;

		input.value = value;
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new Event("change", { bubbles: true }));

		// Apply visual feedback
		applyAutofillHighlight(input);
	};

	// Fill the focused field first
	if (field.type === "cardNumber" && item.cardNumber) {
		fillField(field.input, item.cardNumber);
	} else if (field.type === "cardExpiry" && item.expiryDate) {
		fillField(field.input, item.expiryDate);
	} else if (field.type === "cardCvv" && item.cvv) {
		fillField(field.input, item.cvv);
	} else if (field.type === "cardName" && item.cardholderName) {
		fillField(field.input, item.cardholderName);
	}

	// Fill other related fields in the form group
	if (formGroup) {
		// Fill card number if not the current field
		if (
			formGroup.cardNumberField &&
			formGroup.cardNumberField.element !== field.input &&
			item.cardNumber
		) {
			fillField(formGroup.cardNumberField.element, item.cardNumber);
		}

		// Fill expiry if not the current field
		if (
			formGroup.expiryField &&
			formGroup.expiryField.element !== field.input &&
			item.expiryDate
		) {
			fillField(formGroup.expiryField.element, item.expiryDate);
		}

		// Fill CVV if not the current field
		if (
			formGroup.cvvField &&
			formGroup.cvvField.element !== field.input &&
			item.cvv
		) {
			fillField(formGroup.cvvField.element, item.cvv);
		}

		// Fill name if not the current field
		if (
			formGroup.nameField &&
			formGroup.nameField.element !== field.input &&
			item.cardholderName
		) {
			fillField(formGroup.nameField.element, item.cardholderName);
		}
	} else {
		// Try to find related credit card fields in the same form
		for (const [input, ccField] of detectedCreditCardFields) {
			if (input === field.input) continue;

			// Check if in same form
			const inputForm = input.closest("form");
			if (inputForm !== (field.input.closest("form") || null)) continue;

			switch (ccField.type) {
				case "cardNumber":
					if (item.cardNumber) fillField(input, item.cardNumber);
					break;
				case "cardExpiry":
					if (item.expiryDate) fillField(input, item.expiryDate);
					break;
				case "cardCvv":
					if (item.cvv) fillField(input, item.cvv);
					break;
				case "cardName":
					if (item.cardholderName) fillField(input, item.cardholderName);
					break;
			}
		}
	}

	// Reset autofilling flag after a brief delay
	setTimeout(() => {
		isAutofilling = false;
	}, 100);

	// Hide overlay
	hideCreditCardAutofillOverlay(field);
	currentFocusedCreditCardField = null;

	console.log("Credit card autofill completed for:", item.title);
}

// Show unlock prompt for credit card fields
function showCreditCardUnlockPrompt(field: CreditCardField) {
	// Remove existing overlay
	if (field.overlay) {
		field.overlay.remove();
	}

	// Create shadow host
	const shadowHost = document.createElement("div");
	shadowHost.style.position = "fixed";
	shadowHost.style.zIndex = "2147483647";
	shadowHost.style.opacity = "0";
	shadowHost.style.transform = "translateY(-8px)";
	shadowHost.style.transition =
		"opacity 0.15s ease-out, transform 0.15s ease-out";
	document.body.appendChild(shadowHost);

	// Attach shadow DOM
	const shadow = shadowHost.attachShadow({ mode: "open" });

	// Position overlay
	const rect = field.input.getBoundingClientRect();
	shadowHost.style.top = `${rect.bottom + window.scrollY}px`;
	shadowHost.style.left = `${rect.left}px`;
	shadowHost.style.width = `${Math.max(rect.width, 300)}px`;

	// Create iframe
	const iframe = document.createElement("iframe");
	iframe.style.border = "none";
	iframe.style.width = "100%";
	iframe.style.height = "auto";
	iframe.style.maxHeight = "300px";
	iframe.style.display = "block";
	iframe.src = chrome.runtime.getURL("credit-card-autofill-iframe.html");

	shadow.appendChild(iframe);
	field.overlay = shadowHost;

	// Trigger animation
	setTimeout(() => {
		shadowHost.style.opacity = "1";
		shadowHost.style.transform = "translateY(0)";
	}, 10);

	// Wait for iframe to signal it's ready
	const messageHandler = (event: MessageEvent) => {
		if (event.data.type === "CC_IFRAME_READY") {
			if (field.readyTimeout) {
				clearTimeout(field.readyTimeout);
				field.readyTimeout = undefined;
			}

			// Send unlock needed message
			iframe.contentWindow?.postMessage(
				{
					type: "NEEDS_UNLOCK",
				},
				"*",
			);
		}
	};

	field.messageHandler = messageHandler;
	window.addEventListener("message", messageHandler);

	// Fallback
	field.readyTimeout = setTimeout(() => {
		iframe.contentWindow?.postMessage(
			{
				type: "NEEDS_UNLOCK",
			},
			"*",
		);
	}, 100);
}

// Show re-auth prompt for credit card fields
function showCreditCardReauthPrompt(field: CreditCardField) {
	// Create shadow host
	const shadowHost = document.createElement("div");
	shadowHost.style.position = "fixed";
	shadowHost.style.zIndex = "2147483647";
	document.body.appendChild(shadowHost);

	const shadow = shadowHost.attachShadow({ mode: "open" });

	// Position prompt
	const rect = field.input.getBoundingClientRect();
	shadowHost.style.top = `${rect.bottom + window.scrollY}px`;
	shadowHost.style.left = `${rect.left + window.scrollX}px`;
	shadowHost.style.width = `${Math.max(rect.width, 250)}px`;

	// Create prompt UI
	const container = document.createElement("div");
	container.style.cssText = `
		background: white;
		border: 1px solid #e2e8f0;
		border-radius: 8px;
		box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
		padding: 12px;
		font-family: system-ui, -apple-system, sans-serif;
		font-size: 13px;
	`;

	container.innerHTML = `
		<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
			<span style="font-size: 16px;">🔒</span>
			<span style="font-weight: 500;">Authentication Required</span>
		</div>
		<p style="margin: 0 0 8px 0; color: #64748b; font-size: 12px;">
			Please re-authenticate to use credit card autofill
		</p>
		<button style="
			width: 100%;
			padding: 6px 12px;
			background: #3b82f6;
			color: white;
			border: none;
			border-radius: 6px;
			font-size: 12px;
			font-weight: 500;
			cursor: pointer;
		">
			Open Bittery
		</button>
	`;

	const button = container.querySelector("button");
	button?.addEventListener("click", () => {
		chrome.runtime.sendMessage({ type: "OPEN_POPUP" });
		shadowHost.remove();
	});

	shadow.appendChild(container);
	field.overlay = shadowHost;

	// Auto-hide after 5 seconds
	setTimeout(() => {
		shadowHost.remove();
	}, 5000);
}

// ==================== End Credit Card Autofill ====================

// ==================== Identity Autofill ====================

// Handle identity field focus
async function handleIdentityFieldFocus(field: IdentityField) {
	// Hide any existing overlays from other fields
	if (currentFocusedIdentityField && currentFocusedIdentityField !== field) {
		hideIdentityAutofillOverlay(currentFocusedIdentityField);
		hideFieldIcon(currentFocusedIdentityField);
	}
	// Also hide credential overlays
	if (currentFocusedField) {
		hideAutofillOverlay(currentFocusedField);
		hideFieldIcon(currentFocusedField);
		currentFocusedField = null;
	}
	// Also hide credit card overlays
	if (currentFocusedCreditCardField) {
		hideCreditCardAutofillOverlay(currentFocusedCreditCardField);
		hideFieldIcon(currentFocusedCreditCardField);
		currentFocusedCreditCardField = null;
	}

	currentFocusedIdentityField = field;

	// Check auth status before showing autofill
	const response = await chrome.runtime.sendMessage({
		type: "CHECK_AUTOFILL_AUTH",
	});

	if (!response.authenticated) {
		// Show icon even when locked
		field.hasItems = false;
		showFieldIcon(field, false);

		if (response.needsReauth) {
			showIdentityReauthPrompt(field);
		} else {
			// Extension is locked, needs quick unlock
			showIdentityUnlockPrompt(field);
		}
		return;
	}

	// Get available identity items
	const itemsResponse = await chrome.runtime.sendMessage({
		type: "GET_AUTOFILL_IDENTITIES",
	});

	const hasItems = itemsResponse.items && itemsResponse.items.length > 0;
	field.hasItems = hasItems;

	// Show icon if there are items
	if (hasItems) {
		showFieldIcon(field, true);
		showIdentityAutofillOverlay(field, itemsResponse.items);
	} else {
		showFieldIcon(field, false);
	}
}

// Handle identity field blur
function handleIdentityFieldBlur(field: IdentityField) {
	// Delay to allow clicking on overlay or icon
	setTimeout(() => {
		if (currentFocusedIdentityField === field) {
			hideIdentityAutofillOverlay(field);
			hideFieldIcon(field);
			currentFocusedIdentityField = null;
		}
	}, 200);
}

// Show identity autofill overlay
function showIdentityAutofillOverlay(
	field: IdentityField,
	items: DecryptedItem[],
) {
	// Remove existing overlay
	if (field.overlay) {
		field.overlay.remove();
	}

	// Create shadow host
	const shadowHost = document.createElement("div");
	shadowHost.style.position = "fixed";
	shadowHost.style.zIndex = "2147483647"; // Max z-index
	shadowHost.style.opacity = "0";
	shadowHost.style.transform = "translateY(-8px)";
	shadowHost.style.transition =
		"opacity 0.15s ease-out, transform 0.15s ease-out";
	document.body.appendChild(shadowHost);

	// Attach shadow DOM
	const shadow = shadowHost.attachShadow({ mode: "open" });

	// Position overlay
	const rect = field.input.getBoundingClientRect();
	shadowHost.style.top = `${rect.bottom + window.scrollY}px`;
	shadowHost.style.left = `${rect.left}px`;
	shadowHost.style.width = `${Math.max(rect.width, 300)}px`;

	// Create iframe for identity selection
	const iframe = document.createElement("iframe");
	iframe.style.border = "none";
	iframe.style.width = "100%";
	iframe.style.height = "auto";
	iframe.style.maxHeight = "300px";
	iframe.style.display = "block";
	iframe.src = chrome.runtime.getURL("identity-autofill-iframe.html");

	shadow.appendChild(iframe);
	field.overlay = shadowHost;

	// Trigger animation after a brief delay
	setTimeout(() => {
		shadowHost.style.opacity = "1";
		shadowHost.style.transform = "translateY(0)";
	}, 10);

	// Wait for iframe to signal it's ready
	const messageHandler = (event: MessageEvent) => {
		if (event.data.type === "IDENTITY_IFRAME_READY") {
			if (field.readyTimeout) {
				clearTimeout(field.readyTimeout);
				field.readyTimeout = undefined;
			}

			// Send identity items to iframe
			iframe.contentWindow?.postMessage(
				{
					type: "IDENTITY_ITEMS",
					items,
					fieldType: field.type,
				},
				"*",
			);
		} else if (event.data.type === "IDENTITY_SELECT") {
			handleIdentityAutofillSelect(field, event.data.item);
		}
	};

	field.messageHandler = messageHandler;
	window.addEventListener("message", messageHandler);

	// Fallback: send items after a delay if ready signal not received
	field.readyTimeout = setTimeout(() => {
		console.log(
			"Timeout waiting for identity iframe ready, sending items anyway",
		);
		iframe.contentWindow?.postMessage(
			{
				type: "IDENTITY_ITEMS",
				items,
				fieldType: field.type,
			},
			"*",
		);
	}, 100);

	// Add keyboard navigation
	document.addEventListener("keydown", handleIdentityKeyboardNavigation);

	// Add input event listener for real-time filtering
	let filterTimeout: NodeJS.Timeout;
	const inputHandler = (event: Event) => {
		if (isAutofilling) return;

		const input = event.target as HTMLInputElement;
		const query = input.value;

		// Debounce filtering (150ms)
		clearTimeout(filterTimeout);
		filterTimeout = setTimeout(() => {
			iframe.contentWindow?.postMessage(
				{
					type: "FILTER_IDENTITIES",
					query,
				},
				"*",
			);
		}, 150);
	};

	field.inputHandler = inputHandler;
	field.input.addEventListener("input", inputHandler);
}

// Hide identity autofill overlay
function hideIdentityAutofillOverlay(field: IdentityField) {
	if (field.overlay) {
		field.overlay.remove();
		field.overlay = undefined;
	}
	if (field.messageHandler) {
		window.removeEventListener("message", field.messageHandler);
		field.messageHandler = undefined;
	}
	if (field.inputHandler) {
		field.input.removeEventListener("input", field.inputHandler);
		field.inputHandler = undefined;
	}
	if (field.readyTimeout) {
		clearTimeout(field.readyTimeout);
		field.readyTimeout = undefined;
	}
	document.removeEventListener("keydown", handleIdentityKeyboardNavigation);
}

// Handle keyboard navigation for identity overlay
function handleIdentityKeyboardNavigation(event: KeyboardEvent) {
	if (event.key === "Escape") {
		if (currentFocusedIdentityField) {
			hideIdentityAutofillOverlay(currentFocusedIdentityField);
			currentFocusedIdentityField = null;
		}
	}
	// Arrow keys and Enter are handled by iframe
}

// Handle identity autofill selection
async function handleIdentityAutofillSelect(
	field: IdentityField,
	item: DecryptedItem,
) {
	// Update autofill timestamp
	await chrome.runtime.sendMessage({
		type: "UPDATE_AUTOFILL_TIMESTAMP",
	});

	// Set flag to prevent filtering during autofill
	isAutofilling = true;

	// Get the form group to fill all related fields
	const formGroup = field.formGroup;

	// Helper function to fill a field with visual feedback
	const fillField = (input: HTMLInputElement, value: string) => {
		if (!value) return;

		input.value = value;
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new Event("change", { bubbles: true }));

		// Apply visual feedback
		applyAutofillHighlight(input);
	};

	// Get first address if available
	const address = item.addresses?.[0];
	// Get first phone number if available
	const phoneNumber = item.phoneNumbers?.[0];

	// Fill the focused field first based on its type
	switch (field.type) {
		case "firstName":
			if (item.firstName) fillField(field.input, item.firstName);
			break;
		case "lastName":
			if (item.lastName) fillField(field.input, item.lastName);
			break;
		case "email":
			if (item.email) fillField(field.input, item.email);
			break;
		case "phone":
			if (phoneNumber?.number) fillField(field.input, phoneNumber.number);
			break;
		case "street":
			if (address?.street) fillField(field.input, address.street);
			break;
		case "city":
			if (address?.city) fillField(field.input, address.city);
			break;
		case "state":
			if (address?.state) fillField(field.input, address.state);
			break;
		case "postalCode":
			if (address?.zip) fillField(field.input, address.zip);
			break;
		case "country":
			if (address?.country) fillField(field.input, address.country);
			break;
		case "dateOfBirth":
			if (item.dateOfBirth) fillField(field.input, item.dateOfBirth);
			break;
	}

	// Fill other related fields in the form group
	if (formGroup) {
		// Fill first name if not the current field
		if (
			formGroup.firstNameField &&
			formGroup.firstNameField.element !== field.input &&
			item.firstName
		) {
			fillField(formGroup.firstNameField.element, item.firstName);
		}

		// Fill last name if not the current field
		if (
			formGroup.lastNameField &&
			formGroup.lastNameField.element !== field.input &&
			item.lastName
		) {
			fillField(formGroup.lastNameField.element, item.lastName);
		}

		// Fill email if not the current field
		if (
			formGroup.emailField &&
			formGroup.emailField.element !== field.input &&
			item.email
		) {
			fillField(formGroup.emailField.element, item.email);
		}

		// Fill phone if not the current field
		if (
			formGroup.phoneField &&
			formGroup.phoneField.element !== field.input &&
			phoneNumber?.number
		) {
			fillField(formGroup.phoneField.element, phoneNumber.number);
		}

		// Fill address fields
		if (address) {
			if (
				formGroup.streetField &&
				formGroup.streetField.element !== field.input &&
				address.street
			) {
				fillField(formGroup.streetField.element, address.street);
			}
			if (
				formGroup.cityField &&
				formGroup.cityField.element !== field.input &&
				address.city
			) {
				fillField(formGroup.cityField.element, address.city);
			}
			if (
				formGroup.stateField &&
				formGroup.stateField.element !== field.input &&
				address.state
			) {
				fillField(formGroup.stateField.element, address.state);
			}
			if (
				formGroup.postalCodeField &&
				formGroup.postalCodeField.element !== field.input &&
				address.zip
			) {
				fillField(formGroup.postalCodeField.element, address.zip);
			}
			if (
				formGroup.countryField &&
				formGroup.countryField.element !== field.input &&
				address.country
			) {
				fillField(formGroup.countryField.element, address.country);
			}
		}

		// Fill date of birth if not the current field
		if (
			formGroup.dateOfBirthField &&
			formGroup.dateOfBirthField.element !== field.input &&
			item.dateOfBirth
		) {
			fillField(formGroup.dateOfBirthField.element, item.dateOfBirth);
		}
	} else {
		// Try to find related identity fields in the same form
		for (const [input, identityField] of detectedIdentityFields) {
			if (input === field.input) continue;

			// Check if in same form
			const inputForm = input.closest("form");
			if (inputForm !== (field.input.closest("form") || null)) continue;

			switch (identityField.type) {
				case "firstName":
					if (item.firstName) fillField(input, item.firstName);
					break;
				case "lastName":
					if (item.lastName) fillField(input, item.lastName);
					break;
				case "email":
					if (item.email) fillField(input, item.email);
					break;
				case "phone":
					if (phoneNumber?.number) fillField(input, phoneNumber.number);
					break;
				case "street":
					if (address?.street) fillField(input, address.street);
					break;
				case "city":
					if (address?.city) fillField(input, address.city);
					break;
				case "state":
					if (address?.state) fillField(input, address.state);
					break;
				case "postalCode":
					if (address?.zip) fillField(input, address.zip);
					break;
				case "country":
					if (address?.country) fillField(input, address.country);
					break;
				case "dateOfBirth":
					if (item.dateOfBirth) fillField(input, item.dateOfBirth);
					break;
			}
		}
	}

	// Reset autofilling flag after a brief delay
	setTimeout(() => {
		isAutofilling = false;
	}, 100);

	// Hide overlay
	hideIdentityAutofillOverlay(field);
	currentFocusedIdentityField = null;

	console.log("Identity autofill completed for:", item.title);
}

// Show unlock prompt for identity fields
function showIdentityUnlockPrompt(field: IdentityField) {
	// Remove existing overlay
	if (field.overlay) {
		field.overlay.remove();
	}

	// Create shadow host
	const shadowHost = document.createElement("div");
	shadowHost.style.position = "fixed";
	shadowHost.style.zIndex = "2147483647";
	shadowHost.style.opacity = "0";
	shadowHost.style.transform = "translateY(-8px)";
	shadowHost.style.transition =
		"opacity 0.15s ease-out, transform 0.15s ease-out";
	document.body.appendChild(shadowHost);

	// Attach shadow DOM
	const shadow = shadowHost.attachShadow({ mode: "open" });

	// Position overlay
	const rect = field.input.getBoundingClientRect();
	shadowHost.style.top = `${rect.bottom + window.scrollY}px`;
	shadowHost.style.left = `${rect.left}px`;
	shadowHost.style.width = `${Math.max(rect.width, 300)}px`;

	// Create iframe
	const iframe = document.createElement("iframe");
	iframe.style.border = "none";
	iframe.style.width = "100%";
	iframe.style.height = "auto";
	iframe.style.maxHeight = "300px";
	iframe.style.display = "block";
	iframe.src = chrome.runtime.getURL("identity-autofill-iframe.html");

	shadow.appendChild(iframe);
	field.overlay = shadowHost;

	// Trigger animation
	setTimeout(() => {
		shadowHost.style.opacity = "1";
		shadowHost.style.transform = "translateY(0)";
	}, 10);

	// Wait for iframe to signal it's ready
	const messageHandler = (event: MessageEvent) => {
		if (event.data.type === "IDENTITY_IFRAME_READY") {
			if (field.readyTimeout) {
				clearTimeout(field.readyTimeout);
				field.readyTimeout = undefined;
			}

			// Send unlock needed message
			iframe.contentWindow?.postMessage(
				{
					type: "NEEDS_UNLOCK",
				},
				"*",
			);
		}
	};

	field.messageHandler = messageHandler;
	window.addEventListener("message", messageHandler);

	// Fallback
	field.readyTimeout = setTimeout(() => {
		iframe.contentWindow?.postMessage(
			{
				type: "NEEDS_UNLOCK",
			},
			"*",
		);
	}, 100);
}

// Show re-auth prompt for identity fields
function showIdentityReauthPrompt(field: IdentityField) {
	// Create shadow host
	const shadowHost = document.createElement("div");
	shadowHost.style.position = "fixed";
	shadowHost.style.zIndex = "2147483647";
	document.body.appendChild(shadowHost);

	const shadow = shadowHost.attachShadow({ mode: "open" });

	// Position prompt
	const rect = field.input.getBoundingClientRect();
	shadowHost.style.top = `${rect.bottom + window.scrollY}px`;
	shadowHost.style.left = `${rect.left + window.scrollX}px`;
	shadowHost.style.width = `${Math.max(rect.width, 250)}px`;

	// Create prompt UI
	const container = document.createElement("div");
	container.style.cssText = `
		background: white;
		border: 1px solid #e2e8f0;
		border-radius: 8px;
		box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
		padding: 12px;
		font-family: system-ui, -apple-system, sans-serif;
		font-size: 13px;
	`;

	container.innerHTML = `
		<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
			<span style="font-size: 16px;">🔒</span>
			<span style="font-weight: 500;">Authentication Required</span>
		</div>
		<p style="margin: 0 0 8px 0; color: #64748b; font-size: 12px;">
			Please re-authenticate to use identity autofill
		</p>
		<button style="
			width: 100%;
			padding: 6px 12px;
			background: #3b82f6;
			color: white;
			border: none;
			border-radius: 6px;
			font-size: 12px;
			font-weight: 500;
			cursor: pointer;
		">
			Open Bittery
		</button>
	`;

	const button = container.querySelector("button");
	button?.addEventListener("click", () => {
		chrome.runtime.sendMessage({ type: "OPEN_POPUP" });
		shadowHost.remove();
	});

	shadow.appendChild(container);
	field.overlay = shadowHost;

	// Auto-hide after 5 seconds
	setTimeout(() => {
		shadowHost.remove();
	}, 5000);
}

// ==================== End Identity Autofill ====================

// ==================== Field Icon Indicator ====================

/**
 * Create and show the autofill icon indicator inside the input field
 */
function showFieldIcon(
	field: CredentialField | CreditCardField | IdentityField,
	hasItems: boolean,
) {
	// Remove existing icon if any
	if (field.icon) {
		field.icon.remove();
		field.icon = undefined;
	}

	// Only show icon if there are items or if unlock is needed
	if (!hasItems && field.hasItems !== false) {
		return;
	}

	const input = field.input;

	// Create icon container in a shadow DOM to avoid page CSS interference
	const iconHost = document.createElement("div");
	iconHost.style.cssText = `
		position: fixed;
		width: 24px;
		height: 24px;
		z-index: 2147483646;
		pointer-events: auto;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 4px;
		transition: background-color 0.15s ease;
	`;

	// Position relative to the input (fixed positioning, no scroll offset needed)
	const rect = input.getBoundingClientRect();
	// Place icon 8px from the right edge of the input
	iconHost.style.left = `${rect.right - 32}px`;
	// Center vertically: top of input + half the input height - half the icon height
	iconHost.style.top = `${rect.top + (rect.height - 24) / 2}px`;

	// Create shadow DOM for icon
	const shadow = iconHost.attachShadow({ mode: "open" });

	// Add icon SVG (chevron down + key icon similar to 1Password)
	const iconContainer = document.createElement("div");
	iconContainer.innerHTML = `
		<style>
			:host {
				all: initial;
			}
			.icon-wrapper {
				display: flex;
				align-items: center;
				justify-content: center;
				width: 24px;
				height: 24px;
				border-radius: 4px;
				transition: background-color 0.15s ease;
				cursor: pointer;
			}
			.icon-wrapper:hover {
				background-color: rgba(0, 0, 0, 0.05);
			}
			.icon-svg {
				width: 18px;
				height: 18px;
				color: #6b7280;
			}
		</style>
		<div class="icon-wrapper">
			<svg class="icon-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
				<!-- Chevron down -->
				<path d="M7 10L12 15L17 10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
				<!-- Key symbol in circle -->
				<circle cx="18" cy="6" r="5" fill="white" stroke="currentColor" stroke-width="1.5"/>
				<path d="M18 4.5V7.5M16.5 6H19.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
			</svg>
		</div>
	`;

	shadow.appendChild(iconContainer);
	document.body.appendChild(iconHost);

	field.icon = iconHost;

	// Prevent mousedown from blurring the input
	iconHost.addEventListener("mousedown", (e) => {
		e.preventDefault();
		e.stopPropagation();
	});

	// Make icon clickable to toggle autofill
	iconHost.addEventListener("click", async (e) => {
		e.preventDefault();
		e.stopPropagation();

		// Keep input focused
		input.focus();

		// Toggle overlay visibility
		if (field.overlay) {
			// Hide overlay
			if ("type" in field && typeof field.type === "string") {
				if (["username", "email", "password"].includes(field.type)) {
					hideAutofillOverlay(field as CredentialField);
				} else if (
					["cardNumber", "cardExpiry", "cardCvv", "cardName"].includes(
						field.type,
					)
				) {
					hideCreditCardAutofillOverlay(field as CreditCardField);
				} else {
					hideIdentityAutofillOverlay(field as IdentityField);
				}
			}
		} else {
			// Show overlay by manually triggering the appropriate handler
			if ("type" in field && typeof field.type === "string") {
				if (["username", "email", "password"].includes(field.type)) {
					await handleFieldFocus(field as CredentialField);
				} else if (
					["cardNumber", "cardExpiry", "cardCvv", "cardName"].includes(
						field.type,
					)
				) {
					await handleCreditCardFieldFocus(field as CreditCardField);
				} else {
					await handleIdentityFieldFocus(field as IdentityField);
				}
			}
		}
	});

	// Update icon position on scroll/resize
	const updateIconPosition = () => {
		if (!field.icon || !input.isConnected) {
			return;
		}
		const rect = input.getBoundingClientRect();
		iconHost.style.left = `${rect.right - 32}px`;
		// Center vertically: top of input + half the input height - half the icon height
		iconHost.style.top = `${rect.top + (rect.height - 24) / 2}px`;
	};

	window.addEventListener("scroll", updateIconPosition, { passive: true });
	window.addEventListener("resize", updateIconPosition, { passive: true });

	// Store cleanup function
	const cleanup = () => {
		window.removeEventListener("scroll", updateIconPosition);
		window.removeEventListener("resize", updateIconPosition);
	};

	// Attach cleanup to icon element
	(iconHost as any)._cleanup = cleanup;
}

/**
 * Hide and remove the field icon
 */
function hideFieldIcon(
	field: CredentialField | CreditCardField | IdentityField,
) {
	if (field.icon) {
		// Run cleanup if it exists
		if ((field.icon as any)._cleanup) {
			(field.icon as any)._cleanup();
		}
		field.icon.remove();
		field.icon = undefined;
	}
}

// ==================== End Field Icon Indicator ====================

// Show autofill overlay
function showAutofillOverlay(field: CredentialField, items: DecryptedItem[]) {
	// Remove existing overlay
	if (field.overlay) {
		field.overlay.remove();
	}

	// Create shadow host
	const shadowHost = document.createElement("div");
	shadowHost.style.position = "fixed";
	shadowHost.style.zIndex = "2147483647"; // Max z-index
	shadowHost.style.opacity = "0";
	shadowHost.style.transform = "translateY(-8px)";
	shadowHost.style.transition =
		"opacity 0.15s ease-out, transform 0.15s ease-out";
	document.body.appendChild(shadowHost);

	// Attach shadow DOM
	const shadow = shadowHost.attachShadow({ mode: "open" });

	// Position overlay
	const rect = field.input.getBoundingClientRect();
	shadowHost.style.top = `${rect.bottom + window.scrollY}px`;
	shadowHost.style.left = `${rect.left}px`;
	shadowHost.style.width = `${Math.max(rect.width, 300)}px`;

	// Create iframe
	const iframe = document.createElement("iframe");
	iframe.style.border = "none";
	iframe.style.width = "100%";
	iframe.style.height = "auto";
	iframe.style.maxHeight = "300px";
	iframe.style.display = "block";
	iframe.src = chrome.runtime.getURL("autofill-iframe.html");

	shadow.appendChild(iframe);
	field.overlay = shadowHost;

	// Trigger animation after a brief delay
	setTimeout(() => {
		shadowHost.style.opacity = "1";
		shadowHost.style.transform = "translateY(0)";
	}, 10);

	// Wait for iframe to signal it's ready
	const messageHandler = (event: MessageEvent) => {
		if (event.data.type === "IFRAME_READY") {
			if (field.readyTimeout) {
				clearTimeout(field.readyTimeout);
				field.readyTimeout = undefined;
			}

			// Send items to iframe
			iframe.contentWindow?.postMessage(
				{
					type: "AUTOFILL_ITEMS",
					items,
					fieldType: field.type,
				},
				"*",
			);
		} else if (event.data.type === "AUTOFILL_SELECT") {
			handleAutofillSelect(field, event.data.item);
		}
	};

	field.messageHandler = messageHandler;
	window.addEventListener("message", messageHandler);

	// Fallback: send items after a delay if ready signal not received
	field.readyTimeout = setTimeout(() => {
		console.log("Timeout waiting for iframe ready, sending items anyway");
		iframe.contentWindow?.postMessage(
			{
				type: "AUTOFILL_ITEMS",
				items,
				fieldType: field.type,
			},
			"*",
		);
	}, 100);

	// Add keyboard navigation
	document.addEventListener("keydown", handleKeyboardNavigation);

	// Add input event listener for real-time filtering
	let filterTimeout: NodeJS.Timeout;
	const inputHandler = (event: Event) => {
		if (isAutofilling) return;

		const input = event.target as HTMLInputElement;
		const query = input.value;

		// Debounce filtering (150ms)
		clearTimeout(filterTimeout);
		filterTimeout = setTimeout(() => {
			iframe.contentWindow?.postMessage(
				{
					type: "FILTER_ITEMS",
					query,
				},
				"*",
			);
		}, 150);
	};

	field.inputHandler = inputHandler;
	field.input.addEventListener("input", inputHandler);
}

// Hide autofill overlay
function hideAutofillOverlay(field: CredentialField) {
	if (field.overlay) {
		field.overlay.remove();
		field.overlay = undefined;
	}
	if (field.messageHandler) {
		window.removeEventListener("message", field.messageHandler);
		field.messageHandler = undefined;
	}
	if (field.inputHandler) {
		field.input.removeEventListener("input", field.inputHandler);
		field.inputHandler = undefined;
	}
	if (field.readyTimeout) {
		clearTimeout(field.readyTimeout);
		field.readyTimeout = undefined;
	}
	document.removeEventListener("keydown", handleKeyboardNavigation);
}

// Handle keyboard navigation
function handleKeyboardNavigation(event: KeyboardEvent) {
	if (event.key === "Escape") {
		if (currentFocusedField) {
			hideAutofillOverlay(currentFocusedField);
			currentFocusedField = null;
		}
		if (currentFocusedCreditCardField) {
			hideCreditCardAutofillOverlay(currentFocusedCreditCardField);
			currentFocusedCreditCardField = null;
		}
	}
	// Arrow keys and Enter are handled by iframe
}

// Handle autofill selection
async function handleAutofillSelect(
	field: CredentialField,
	item: DecryptedItem,
) {
	// Update autofill timestamp
	await chrome.runtime.sendMessage({
		type: "UPDATE_AUTOFILL_TIMESTAMP",
	});

	// Set flag to prevent filtering during autofill
	isAutofilling = true;

	// Fill the field
	if (field.type === "password" && item.password) {
		field.input.value = item.password;
	} else if (
		(field.type === "username" || field.type === "email") &&
		item.username
	) {
		field.input.value = item.username;
	}

	// Trigger input event for frameworks
	field.input.dispatchEvent(new Event("input", { bubbles: true }));
	field.input.dispatchEvent(new Event("change", { bubbles: true }));

	// Try to find and fill related fields
	const form = field.input.closest("form") || document;

	if (field.type === "password") {
		// Find username field when password is filled
		// First, check our detected fields
		let usernameField: HTMLInputElement | undefined;

		for (const [input, detectedField] of detectedFields) {
			if (
				input !== field.input &&
				(detectedField.type === "username" || detectedField.type === "email")
			) {
				// Prefer fields in the same form
				const fieldForm = input.closest("form");
				if (fieldForm === (field.input.closest("form") || null)) {
					usernameField = input;
					break;
				}
				if (!usernameField) {
					usernameField = input;
				}
			}
		}

		// Fallback: search for username fields in the form
		if (!usernameField) {
			usernameField = Array.from(
				form.querySelectorAll<HTMLInputElement>(
					'input[type="text"], input[type="email"]',
				),
			).find(
				(input) =>
					input !== field.input &&
					(input.autocomplete?.includes("username") ||
						input.autocomplete?.includes("email") ||
						input.name?.toLowerCase().includes("username") ||
						input.name?.toLowerCase().includes("email")),
			);
		}

		if (usernameField && item.username) {
			usernameField.value = item.username;
			usernameField.dispatchEvent(new Event("input", { bubbles: true }));
			usernameField.dispatchEvent(new Event("change", { bubbles: true }));
		}
	} else if (field.type === "username" || field.type === "email") {
		// Find password field when username/email is filled
		const passwordField = Array.from(
			form.querySelectorAll<HTMLInputElement>('input[type="password"]'),
		).find((input) => input !== field.input);

		if (passwordField && item.password) {
			passwordField.value = item.password;
			passwordField.dispatchEvent(new Event("input", { bubbles: true }));
			passwordField.dispatchEvent(new Event("change", { bubbles: true }));
		}
	}

	// Reset autofilling flag after a brief delay
	setTimeout(() => {
		isAutofilling = false;
	}, 100);

	// Hide overlay
	hideAutofillOverlay(field);
	currentFocusedField = null;
}

// Show unlock prompt (when extension is locked)
function showUnlockPrompt(field: CredentialField) {
	// Remove existing overlay
	if (field.overlay) {
		field.overlay.remove();
	}

	// Create shadow host
	const shadowHost = document.createElement("div");
	shadowHost.style.position = "fixed";
	shadowHost.style.zIndex = "2147483647"; // Max z-index
	shadowHost.style.opacity = "0";
	shadowHost.style.transform = "translateY(-8px)";
	shadowHost.style.transition =
		"opacity 0.15s ease-out, transform 0.15s ease-out";
	document.body.appendChild(shadowHost);

	// Attach shadow DOM
	const shadow = shadowHost.attachShadow({ mode: "open" });

	// Position overlay
	const rect = field.input.getBoundingClientRect();
	shadowHost.style.top = `${rect.bottom + window.scrollY}px`;
	shadowHost.style.left = `${rect.left}px`;
	shadowHost.style.width = `${Math.max(rect.width, 300)}px`;

	// Create iframe
	const iframe = document.createElement("iframe");
	iframe.style.border = "none";
	iframe.style.width = "100%";
	iframe.style.height = "auto";
	iframe.style.maxHeight = "300px";
	iframe.style.display = "block";
	iframe.src = chrome.runtime.getURL("autofill-iframe.html");

	shadow.appendChild(iframe);
	field.overlay = shadowHost;

	// Trigger animation after a brief delay
	setTimeout(() => {
		shadowHost.style.opacity = "1";
		shadowHost.style.transform = "translateY(0)";
	}, 10);

	// Wait for iframe to signal it's ready
	const messageHandler = (event: MessageEvent) => {
		if (event.data.type === "IFRAME_READY") {
			if (field.readyTimeout) {
				clearTimeout(field.readyTimeout);
				field.readyTimeout = undefined;
			}

			// Send unlock needed message to iframe
			iframe.contentWindow?.postMessage(
				{
					type: "NEEDS_UNLOCK",
				},
				"*",
			);
		}
	};

	field.messageHandler = messageHandler;
	window.addEventListener("message", messageHandler);

	// Fallback: send message after a delay if ready signal not received
	field.readyTimeout = setTimeout(() => {
		iframe.contentWindow?.postMessage(
			{
				type: "NEEDS_UNLOCK",
			},
			"*",
		);
	}, 100);
}

// Show re-authentication prompt
function showReauthPrompt(field: CredentialField) {
	// Create shadow host for prompt
	const shadowHost = document.createElement("div");
	shadowHost.style.position = "fixed";
	shadowHost.style.zIndex = "2147483647";
	document.body.appendChild(shadowHost);

	const shadow = shadowHost.attachShadow({ mode: "open" });

	// Position prompt
	const rect = field.input.getBoundingClientRect();
	shadowHost.style.top = `${rect.bottom + window.scrollY}px`;
	shadowHost.style.left = `${rect.left + window.scrollX}px`;
	shadowHost.style.width = `${Math.max(rect.width, 250)}px`;

	// Create prompt UI
	const container = document.createElement("div");
	container.style.cssText = `
		background: white;
		border: 1px solid #e2e8f0;
		border-radius: 8px;
		box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
		padding: 12px;
		font-family: system-ui, -apple-system, sans-serif;
		font-size: 13px;
	`;

	container.innerHTML = `
		<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
			<span style="font-size: 16px;">🔒</span>
			<span style="font-weight: 500;">Authentication Required</span>
		</div>
		<p style="margin: 0 0 8px 0; color: #64748b; font-size: 12px;">
			Please re-authenticate to use autofill
		</p>
		<button style="
			width: 100%;
			padding: 6px 12px;
			background: #3b82f6;
			color: white;
			border: none;
			border-radius: 6px;
			font-size: 12px;
			font-weight: 500;
			cursor: pointer;
		">
			Open Bittery
		</button>
	`;

	const button = container.querySelector("button");
	button?.addEventListener("click", () => {
		chrome.runtime.sendMessage({ type: "OPEN_POPUP" });
		shadowHost.remove();
	});

	shadow.appendChild(container);
	field.overlay = shadowHost;

	// Auto-hide after 5 seconds
	setTimeout(() => {
		shadowHost.remove();
	}, 5000);
}

// Run detection on load and on DOM changes
if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", () => {
		detectPasswordFields();
		// Also run legacy detection as fallback
		detectPasswordFieldsLegacy();
		restorePendingSavePrompt();
		// Set up shadow root observation for newly attached shadow roots
		setupShadowRootWatcher();
	});
} else {
	detectPasswordFields();
	// Also run legacy detection as fallback
	detectPasswordFieldsLegacy();
	restorePendingSavePrompt();
	// Set up shadow root observation for newly attached shadow roots
	setupShadowRootWatcher();
}

// Set up watcher for dynamically attached shadow roots
function setupShadowRootWatcher() {
	observeShadowRoots((shadowRoot, _host) => {
		if (!observedShadowRoots.has(shadowRoot)) {
			observedShadowRoots.add(shadowRoot);
			// Small delay to allow shadow DOM content to initialize
			setTimeout(() => {
				detectPasswordFields(shadowRoot);
				setupShadowRootObserver(shadowRoot);
			}, 50);
		}
	});
}

// Watch for dynamic content with enhanced observer
createEnhancedObserver(() => {
	// Debounce detection to prevent excessive processing
	if (detectionTimeout) {
		clearTimeout(detectionTimeout);
	}
	detectionTimeout = setTimeout(() => {
		detectPasswordFields();
		// Run legacy detection as fallback for any fields missed
		detectPasswordFieldsLegacy();
	}, DETECTION_DEBOUNCE_MS);
}, document);

// Clean up on unload
window.addEventListener("beforeunload", () => {
	detectedFields.forEach((field) => {
		if (field.overlay) {
			field.overlay.remove();
		}
	});
	detectedFields.clear();
});
