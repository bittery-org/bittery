import { contentState } from "../state";
import { hideAutofillOverlay } from "./credential";
import { hideCreditCardAutofillOverlay } from "./credit-card";
import { hideIdentityAutofillOverlay } from "./identity";
import { hideFieldIcon } from "./icon";

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
