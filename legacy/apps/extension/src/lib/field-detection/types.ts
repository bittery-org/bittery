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
	confidence: number;
	form?: HTMLFormElement;
	shadowRoot?: ShadowRoot;
	stepIndex?: number;
}

export interface FormContext {
	form?: HTMLFormElement;
	fields: DetectedField[];
	isMultiStep: boolean;
	currentStep: number;
	totalSteps: number;
	shadowRoot?: ShadowRoot;
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
