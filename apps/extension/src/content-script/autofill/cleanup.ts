import { contentState } from "../state";
import type { AutofillField } from "../types";
import { hideAutofillOverlay } from "./credential";
import { hideCreditCardAutofillOverlay } from "./credit-card";
import { hideFieldIcon } from "./icon";
import { hideIdentityAutofillOverlay } from "./identity";
import { destroyOverlayPool } from "./iframe-pool";
import { resetOverlayPrewarm } from "./prewarm";

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

	if (
		contentState.currentFocusedField &&
		!contentState.currentFocusedField.input.isConnected
	) {
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

	// Warm overlay frames outlive individual fields, so they have to be torn
	// down explicitly — otherwise a navigation would leave decrypted items in a
	// detached frame.
	destroyOverlayPool();
	// ...and the prewarm bookkeeping goes with them, so the next detection pass
	// warms again instead of assuming the frames it asked for still exist.
	resetOverlayPrewarm();
}
