import { contentState } from "../state";
import { hideAutofillOverlay } from "./credential";
import { hideCreditCardAutofillOverlay } from "./credit-card";
import { hideFieldIcon } from "./icon";
import { hideIdentityAutofillOverlay } from "./identity";

let outsideClickHandlerRegistered = false;

export function setupOutsideClickHandler() {
	if (outsideClickHandlerRegistered) return;
	outsideClickHandlerRegistered = true;

	document.addEventListener(
		"mousedown",
		(event) => {
			const path = event.composedPath();

			if (contentState.currentFocusedField) {
				const isOnInput = path.includes(contentState.currentFocusedField.input);
				const isOnOverlay =
					contentState.currentFocusedField.overlay &&
					path.includes(contentState.currentFocusedField.overlay);
				const isOnIcon =
					contentState.currentFocusedField.icon &&
					path.includes(contentState.currentFocusedField.icon);

				if (!isOnInput && !isOnOverlay && !isOnIcon) {
					hideAutofillOverlay(contentState.currentFocusedField);
					hideFieldIcon(contentState.currentFocusedField);
					contentState.currentFocusedField = null;
				}
			}

			if (contentState.currentFocusedCreditCardField) {
				const isOnInput = path.includes(
					contentState.currentFocusedCreditCardField.input,
				);
				const isOnOverlay =
					contentState.currentFocusedCreditCardField.overlay &&
					path.includes(contentState.currentFocusedCreditCardField.overlay);
				const isOnIcon =
					contentState.currentFocusedCreditCardField.icon &&
					path.includes(contentState.currentFocusedCreditCardField.icon);

				if (!isOnInput && !isOnOverlay && !isOnIcon) {
					hideCreditCardAutofillOverlay(
						contentState.currentFocusedCreditCardField,
					);
					hideFieldIcon(contentState.currentFocusedCreditCardField);
					contentState.currentFocusedCreditCardField = null;
				}
			}

			if (contentState.currentFocusedIdentityField) {
				const isOnInput = path.includes(
					contentState.currentFocusedIdentityField.input,
				);
				const isOnOverlay =
					contentState.currentFocusedIdentityField.overlay &&
					path.includes(contentState.currentFocusedIdentityField.overlay);
				const isOnIcon =
					contentState.currentFocusedIdentityField.icon &&
					path.includes(contentState.currentFocusedIdentityField.icon);

				if (!isOnInput && !isOnOverlay && !isOnIcon) {
					hideIdentityAutofillOverlay(contentState.currentFocusedIdentityField);
					hideFieldIcon(contentState.currentFocusedIdentityField);
					contentState.currentFocusedIdentityField = null;
				}
			}
		},
		true,
	);
}
