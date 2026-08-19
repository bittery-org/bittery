/**
 * Enhanced Form Field Detection Module
 *
 * This module provides advanced form field detection capabilities including:
 * - Shadow DOM traversal
 * - Multi-step form detection
 * - Dynamic form handling
 * - Advanced heuristics for field type identification
 */

export {
	detectAllFields,
	detectCredentialFields,
	detectCreditCardFields,
	detectIdentityFields,
	detectOTPFields,
	isCreditCardFieldType,
	isIdentityFieldType,
} from "./detectors";
export { getAllInputs, isFieldVisible } from "./dom";
export { shouldExcludeField } from "./exclusion";
export { detectFieldType } from "./field-type";
export {
	detectMultiStepForm,
	isLikelyAddressForm,
	isLikelyLoginForm,
	isLikelyPaymentForm,
	isLikelyRegistrationForm,
} from "./form-heuristics";
export {
	findCredentialPair,
	groupCreditCardFieldsByForm,
	groupFieldsByForm,
	groupIdentityFieldsByForm,
} from "./grouping";
export { createEnhancedObserver, observeShadowRoots } from "./observers";
export { FIELD_PATTERNS, MULTI_STEP_INDICATORS } from "./patterns";
export type {
	CreditCardFieldType,
	DetectedCreditCardForm,
	DetectedField,
	DetectedIdentityForm,
	FormContext,
	IdentityFieldType,
} from "./types";
