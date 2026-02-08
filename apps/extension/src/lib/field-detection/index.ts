/**
 * Enhanced Form Field Detection Module
 *
 * This module provides advanced form field detection capabilities including:
 * - Shadow DOM traversal
 * - Multi-step form detection
 * - Dynamic form handling
 * - Advanced heuristics for field type identification
 */

export type {
	CreditCardFieldType,
	DetectedCreditCardForm,
	DetectedField,
	DetectedIdentityForm,
	FormContext,
	IdentityFieldType,
} from "./types";

export { FIELD_PATTERNS, MULTI_STEP_INDICATORS } from "./patterns";
export { getAllInputs, isFieldVisible } from "./dom";
export { shouldExcludeField } from "./exclusion";
export { detectFieldType } from "./field-type";
export {
	detectAllFields,
	detectCredentialFields,
	detectCreditCardFields,
	detectIdentityFields,
	detectOTPFields,
	isCreditCardFieldType,
	isIdentityFieldType,
} from "./detectors";
export {
	findCredentialPair,
	groupCreditCardFieldsByForm,
	groupFieldsByForm,
	groupIdentityFieldsByForm,
} from "./grouping";
export {
	detectMultiStepForm,
	isLikelyAddressForm,
	isLikelyLoginForm,
	isLikelyPaymentForm,
	isLikelyRegistrationForm,
} from "./form-heuristics";
export { createEnhancedObserver, observeShadowRoots } from "./observers";
