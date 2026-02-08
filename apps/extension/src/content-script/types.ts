import type {
	CreditCardFieldType,
	DetectedCreditCardForm,
	DetectedIdentityForm,
	IdentityFieldType,
} from "../lib/field-detection";

export type CredentialFieldType = "username" | "email" | "password" | "otp";

interface BaseAutofillField {
	input: HTMLInputElement;
	overlay?: HTMLElement;
	icon?: HTMLElement;
	messageHandler?: (event: MessageEvent) => void;
	inputHandler?: (event: Event) => void;
	repositionCleanup?: () => void;
	readyTimeout?: NodeJS.Timeout;
	confidence?: number;
	shadowRoot?: ShadowRoot;
	hasItems?: boolean;
}

export interface CredentialField extends BaseAutofillField {
	type: CredentialFieldType;
}

export interface CreditCardField extends BaseAutofillField {
	type: CreditCardFieldType;
	formGroup?: DetectedCreditCardForm;
}

export interface IdentityField extends BaseAutofillField {
	type: IdentityFieldType;
	formGroup?: DetectedIdentityForm;
}

export type AutofillField = CredentialField | CreditCardField | IdentityField;

export interface CapturedCredentials {
	username: string;
	password: string;
	url: string;
	hostname: string;
	usernameField?: HTMLInputElement;
	passwordField?: HTMLInputElement;
}

export interface PendingRequest {
	url: string;
	method: string;
	body: Document | XMLHttpRequestBodyInit | BodyInit | null | undefined;
	timestamp: number;
	form?: HTMLFormElement;
}

export interface ActiveSavePrompt {
	shadowHost: HTMLElement;
	messageHandler: (event: MessageEvent) => void;
}
