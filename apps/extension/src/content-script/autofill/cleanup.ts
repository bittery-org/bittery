import type { AutofillField } from "../types";
import { contentState } from "../state";
import { hideAutofillOverlay } from "./credential";
import { hideCreditCardAutofillOverlay } from "./credit-card";
import { hideFieldIcon } from "./icon";
import { hideIdentityAutofillOverlay } from "./identity";

function cleanupDetachedFields<T extends AutofillField>(
	fields: Map<HTMLInputElement, T>,
	hideOverlay: (field: T) => void,
) {
	for (const [input, field] of fields) {
		if (input.isConnected) continue;
		hideOverlay(field);
		hideFieldIcon(field);
		fields.delete(input);
	}
}

export function cleanupDetachedAutofillState() {
	cleanupDetachedFields(contentState.detectedFields, hideAutofillOverlay);
	cleanupDetachedFields(
		contentState.detectedCreditCardFields,
		hideCreditCardAutofillOverlay,
	);
	cleanupDetachedFields(
		contentState.detectedIdentityFields,
		hideIdentityAutofillOverlay,
	);

	if (contentState.currentFocusedField && !contentState.currentFocusedField.input.isConnected) {
		contentState.currentFocusedField = null;
	}
	if (
		contentState.currentFocusedCreditCardField &&
		!contentState.currentFocusedCreditCardField.input.isConnected
	) {
		contentState.currentFocusedCreditCardField = null;
	}
	if (
		contentState.currentFocusedIdentityField &&
		!contentState.currentFocusedIdentityField.input.isConnected
	) {
		contentState.currentFocusedIdentityField = null;
	}
}

export function cleanupAutofillState() {
	for (const field of contentState.detectedFields.values()) {
		hideAutofillOverlay(field);
		hideFieldIcon(field);
	}
	for (const field of contentState.detectedCreditCardFields.values()) {
		hideCreditCardAutofillOverlay(field);
		hideFieldIcon(field);
	}
	for (const field of contentState.detectedIdentityFields.values()) {
		hideIdentityAutofillOverlay(field);
		hideFieldIcon(field);
	}

	contentState.detectedFields.clear();
	contentState.detectedCreditCardFields.clear();
	contentState.detectedIdentityFields.clear();
}
