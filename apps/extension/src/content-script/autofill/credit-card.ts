import type { DecryptedItem } from "@bittery/shared/types";
import { contentState } from "../state";
import type { CreditCardField } from "../types";
import { hideAutofillOverlay } from "./credential";
import { hideFieldIcon, showFieldIcon } from "./icon";
import { updateAutofillTimestamp } from "./timestamp";
import {
	applyAutofillHighlight,
	hideItemsOverlay,
	showItemsOverlay,
	showReauthPromptCard,
	showUnlockIframePrompt,
} from "./overlay-utils";

// Handle credit card field focus
export async function handleCreditCardFieldFocus(field: CreditCardField) {
	if (
		contentState.currentFocusedCreditCardField &&
		contentState.currentFocusedCreditCardField !== field
	) {
		hideCreditCardAutofillOverlay(contentState.currentFocusedCreditCardField);
		hideFieldIcon(contentState.currentFocusedCreditCardField);
	}
	if (contentState.currentFocusedField) {
		hideAutofillOverlay(contentState.currentFocusedField);
		hideFieldIcon(contentState.currentFocusedField);
		contentState.currentFocusedField = null;
	}

	contentState.currentFocusedCreditCardField = field;

	const response = await chrome.runtime.sendMessage({
		type: "CHECK_AUTOFILL_AUTH",
	});

	if (contentState.currentFocusedCreditCardField !== field) return;

	const handleIconToggle = async () => {
		if (field.overlay) {
			hideCreditCardAutofillOverlay(field);
		} else {
			await handleCreditCardFieldFocus(field);
		}
	};

	if (!response.authenticated) {
		field.hasItems = false;
		showFieldIcon(field, false, handleIconToggle);

		if (response.needsReauth) {
			showCreditCardReauthPrompt(field);
		} else {
			showCreditCardUnlockPrompt(field);
		}
		return;
	}

	const itemsResponse = await chrome.runtime.sendMessage({
		type: "GET_AUTOFILL_CREDIT_CARDS",
	});

	if (contentState.currentFocusedCreditCardField !== field) return;

	const hasItems = itemsResponse.items && itemsResponse.items.length > 0;
	field.hasItems = hasItems;

	if (hasItems) {
		showFieldIcon(field, true, handleIconToggle);
		showCreditCardAutofillOverlay(field, itemsResponse.items);
	} else {
		showFieldIcon(field, false, handleIconToggle);
	}
}

// Handle credit card field blur
export function handleCreditCardFieldBlur(field: CreditCardField) {
	setTimeout(() => {
		if (contentState.currentFocusedCreditCardField === field) {
			hideCreditCardAutofillOverlay(field);
			hideFieldIcon(field);
			contentState.currentFocusedCreditCardField = null;
		}
	}, 200);
}

// Show credit card autofill overlay
function showCreditCardAutofillOverlay(
	field: CreditCardField,
	items: DecryptedItem[],
) {
	showItemsOverlay({
		field,
		items,
		iframeSrc: "credit-card-autofill-iframe.html",
		readyMessageType: "CC_IFRAME_READY",
		selectMessageType: "CREDIT_CARD_SELECT",
		itemsMessageType: "CREDIT_CARD_ITEMS",
		filterMessageType: "FILTER_CREDIT_CARDS",
		fieldType: field.type,
		onSelect: handleCreditCardAutofillSelect,
		setCurrentIframe: (iframe) => {
			contentState.currentCreditCardIframe = iframe;
		},
		keyboardHandler: handleCreditCardKeyboardNavigation,
		timeoutLog:
			"Timeout waiting for credit card iframe ready, sending items anyway",
		isAutofilling: () => contentState.isAutofilling,
	});
}

// Hide credit card autofill overlay
export function hideCreditCardAutofillOverlay(field: CreditCardField) {
	hideItemsOverlay(field, {
		setCurrentIframe: () => {
			contentState.currentCreditCardIframe = null;
		},
		keyboardHandler: handleCreditCardKeyboardNavigation,
	});
}

// Handle keyboard navigation for credit card overlay
function handleCreditCardKeyboardNavigation(event: KeyboardEvent) {
	if (event.key === "Escape") {
		if (contentState.currentFocusedCreditCardField) {
			hideCreditCardAutofillOverlay(contentState.currentFocusedCreditCardField);
			contentState.currentFocusedCreditCardField = null;
		}
	}
	if (
		event.key === "ArrowDown" ||
		event.key === "ArrowUp" ||
		event.key === "Enter"
	) {
		if (contentState.currentCreditCardIframe) {
			event.preventDefault();
			const iframeOrigin = new URL(contentState.currentCreditCardIframe.src)
				.origin;
			const nonce =
				new URL(contentState.currentCreditCardIframe.src).searchParams.get(
					"nonce",
				) ?? "";
			contentState.currentCreditCardIframe.contentWindow?.postMessage(
				{ type: "KEYBOARD_NAV", key: event.key, nonce },
				iframeOrigin,
			);
		}
	}
}

// Handle credit card autofill selection
async function handleCreditCardAutofillSelect(
	field: CreditCardField,
	item: DecryptedItem,
) {
	await updateAutofillTimestamp();

	contentState.isAutofilling = true;

	const formGroup = field.formGroup;

	const fillField = (input: HTMLInputElement, value: string) => {
		if (!value) return;

		input.value = value;
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new Event("change", { bubbles: true }));

		applyAutofillHighlight(input);
	};

	if (field.type === "cardNumber" && item.cardNumber) {
		fillField(field.input, item.cardNumber);
	} else if (field.type === "cardExpiry" && item.expiryDate) {
		fillField(field.input, item.expiryDate);
	} else if (field.type === "cardCvv" && item.cvv) {
		fillField(field.input, item.cvv);
	} else if (field.type === "cardName" && item.cardholderName) {
		fillField(field.input, item.cardholderName);
	}

	if (formGroup) {
		if (
			formGroup.cardNumberField &&
			formGroup.cardNumberField.element !== field.input &&
			item.cardNumber
		) {
			fillField(formGroup.cardNumberField.element, item.cardNumber);
		}

		if (
			formGroup.expiryField &&
			formGroup.expiryField.element !== field.input &&
			item.expiryDate
		) {
			fillField(formGroup.expiryField.element, item.expiryDate);
		}

		if (
			formGroup.cvvField &&
			formGroup.cvvField.element !== field.input &&
			item.cvv
		) {
			fillField(formGroup.cvvField.element, item.cvv);
		}

		if (
			formGroup.nameField &&
			formGroup.nameField.element !== field.input &&
			item.cardholderName
		) {
			fillField(formGroup.nameField.element, item.cardholderName);
		}
	} else {
		for (const [input, ccField] of contentState.detectedCreditCardFields) {
			if (input === field.input) continue;

			const inputForm = input.closest("form");
			if (inputForm !== (field.input.closest("form") || null)) continue;

			switch (ccField.type) {
				case "cardNumber":
					if (item.cardNumber) fillField(input, item.cardNumber);
					break;
				case "cardExpiry":
					if (item.expiryDate) fillField(input, item.expiryDate);
					break;
				case "cardCvv":
					if (item.cvv) fillField(input, item.cvv);
					break;
				case "cardName":
					if (item.cardholderName) fillField(input, item.cardholderName);
					break;
			}
		}
	}

	setTimeout(() => {
		contentState.isAutofilling = false;
	}, 100);

	hideCreditCardAutofillOverlay(field);
	contentState.currentFocusedCreditCardField = null;
}

// Show unlock prompt for credit card fields
function showCreditCardUnlockPrompt(field: CreditCardField) {
	showUnlockIframePrompt(field, {
		iframeSrc: "credit-card-autofill-iframe.html",
		readyMessageType: "CC_IFRAME_READY",
	});
}

// Show re-auth prompt for credit card fields
function showCreditCardReauthPrompt(field: CreditCardField) {
	showReauthPromptCard(
		field,
		"Please re-authenticate to use credit card autofill",
	);
}
