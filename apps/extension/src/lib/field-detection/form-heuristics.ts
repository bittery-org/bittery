import {
	detectCreditCardFields,
	detectCredentialFields,
	detectIdentityFields,
} from "./detectors";
import { MULTI_STEP_INDICATORS } from "./patterns";

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
			Number.parseInt(form.dataset.steps || form.dataset.totalSteps || "0", 10) ||
			result.totalSteps;
		const currentStep =
			Number.parseInt(form.dataset.step || form.dataset.currentStep || "1", 10) || 1;
		result.totalSteps = Math.max(result.totalSteps, totalSteps);
		result.currentStep = currentStep;
	}

	return result;
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
 * Check if a form looks like a login form
 */
export function isLikelyLoginForm(form: HTMLFormElement): boolean {
	// Get fields within the form by filtering all document fields
	const allFields = detectCredentialFields(document);
	const fields = allFields.filter((f) => f.form === form);
	const hasPassword = fields.some((f) => f.type === "password");
	const hasUsername = fields.some((f) => f.type === "username" || f.type === "email");

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
