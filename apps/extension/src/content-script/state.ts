import type { CredentialField, CreditCardField, IdentityField } from "./types";

export const FORM_SUBMISSION_DEBOUNCE_MS = 500;
export const DETECTION_DEBOUNCE_MS = 100;

export const contentState = {
	detectedFields: new Map<HTMLInputElement, CredentialField>(),
	detectedCreditCardFields: new Map<HTMLInputElement, CreditCardField>(),
	detectedIdentityFields: new Map<HTMLInputElement, IdentityField>(),
	currentFocusedField: null as CredentialField | null,
	currentFocusedCreditCardField: null as CreditCardField | null,
	currentFocusedIdentityField: null as IdentityField | null,
	currentAutofillIframe: null as HTMLIFrameElement | null,
	currentCreditCardIframe: null as HTMLIFrameElement | null,
	currentIdentityIframe: null as HTMLIFrameElement | null,
	isAutofilling: false,
	processedForms: new WeakSet<HTMLFormElement>(),
	observedShadowRoots: new WeakSet<ShadowRoot>(),
	detectionTimeout: null as NodeJS.Timeout | null,
};
