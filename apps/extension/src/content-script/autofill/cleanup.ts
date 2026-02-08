import { contentState } from "../state";
import { hideAutofillOverlay } from "./credential";
import { hideCreditCardAutofillOverlay } from "./credit-card";
import { hideFieldIcon } from "./icon";
import { hideIdentityAutofillOverlay } from "./identity";

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
