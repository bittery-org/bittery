import type { DecryptedItem } from "@bittery/shared/types";
import { contentState } from "../state";
import type { IdentityField } from "../types";
import { hideFieldIcon, showFieldIcon } from "./icon";
import {
	applyAutofillHighlight,
	hideItemsOverlay,
	showItemsOverlay,
	showReauthPromptCard,
	showUnlockIframePrompt,
} from "./overlay-utils";
import { hideAutofillOverlay } from "./credential";
import { hideCreditCardAutofillOverlay } from "./credit-card";

// Handle identity field focus
export async function handleIdentityFieldFocus(field: IdentityField) {
	if (
		contentState.currentFocusedIdentityField &&
		contentState.currentFocusedIdentityField !== field
	) {
		hideIdentityAutofillOverlay(contentState.currentFocusedIdentityField);
		hideFieldIcon(contentState.currentFocusedIdentityField);
	}
	if (contentState.currentFocusedField) {
		hideAutofillOverlay(contentState.currentFocusedField);
		hideFieldIcon(contentState.currentFocusedField);
		contentState.currentFocusedField = null;
	}
	if (contentState.currentFocusedCreditCardField) {
		hideCreditCardAutofillOverlay(contentState.currentFocusedCreditCardField);
		hideFieldIcon(contentState.currentFocusedCreditCardField);
		contentState.currentFocusedCreditCardField = null;
	}

	contentState.currentFocusedIdentityField = field;

	const response = await chrome.runtime.sendMessage({
		type: "CHECK_AUTOFILL_AUTH",
	});

	if (contentState.currentFocusedIdentityField !== field) return;

	const handleIconToggle = async () => {
		if (field.overlay) {
			hideIdentityAutofillOverlay(field);
		} else {
			await handleIdentityFieldFocus(field);
		}
	};

	if (!response.authenticated) {
		field.hasItems = false;
		showFieldIcon(field, false, handleIconToggle);

		if (response.needsReauth) {
			showIdentityReauthPrompt(field);
		} else {
			showIdentityUnlockPrompt(field);
		}
		return;
	}

	const itemsResponse = await chrome.runtime.sendMessage({
		type: "GET_AUTOFILL_IDENTITIES",
	});

	if (contentState.currentFocusedIdentityField !== field) return;

	const hasItems = itemsResponse.items && itemsResponse.items.length > 0;
	field.hasItems = hasItems;

	if (hasItems) {
		showFieldIcon(field, true, handleIconToggle);
		showIdentityAutofillOverlay(field, itemsResponse.items);
	} else {
		showFieldIcon(field, false, handleIconToggle);
	}
}

// Handle identity field blur
export function handleIdentityFieldBlur(field: IdentityField) {
	setTimeout(() => {
		if (contentState.currentFocusedIdentityField === field) {
			hideIdentityAutofillOverlay(field);
			hideFieldIcon(field);
			contentState.currentFocusedIdentityField = null;
		}
	}, 200);
}

// Show identity autofill overlay
function showIdentityAutofillOverlay(field: IdentityField, items: DecryptedItem[]) {
	showItemsOverlay({
		field,
		items,
		iframeSrc: "identity-autofill-iframe.html",
		readyMessageType: "IDENTITY_IFRAME_READY",
		selectMessageType: "IDENTITY_SELECT",
		itemsMessageType: "IDENTITY_ITEMS",
		filterMessageType: "FILTER_IDENTITIES",
		fieldType: field.type,
		onSelect: handleIdentityAutofillSelect,
		setCurrentIframe: (iframe) => {
			contentState.currentIdentityIframe = iframe;
		},
		keyboardHandler: handleIdentityKeyboardNavigation,
		timeoutLog: "Timeout waiting for identity iframe ready, sending items anyway",
		isAutofilling: () => contentState.isAutofilling,
	});
}

// Hide identity autofill overlay
export function hideIdentityAutofillOverlay(field: IdentityField) {
	hideItemsOverlay(field, {
		setCurrentIframe: () => {
			contentState.currentIdentityIframe = null;
		},
		keyboardHandler: handleIdentityKeyboardNavigation,
	});
}

// Handle keyboard navigation for identity overlay
function handleIdentityKeyboardNavigation(event: KeyboardEvent) {
	if (event.key === "Escape") {
		if (contentState.currentFocusedIdentityField) {
			hideIdentityAutofillOverlay(contentState.currentFocusedIdentityField);
			contentState.currentFocusedIdentityField = null;
		}
	}
	if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter") {
		if (contentState.currentIdentityIframe) {
			event.preventDefault();
			contentState.currentIdentityIframe.contentWindow?.postMessage(
				{ type: "KEYBOARD_NAV", key: event.key },
				"*",
			);
		}
	}
}

// Handle identity autofill selection
async function handleIdentityAutofillSelect(field: IdentityField, item: DecryptedItem) {
	await chrome.runtime.sendMessage({
		type: "UPDATE_AUTOFILL_TIMESTAMP",
	});

	contentState.isAutofilling = true;

	const formGroup = field.formGroup;

	const fillField = (input: HTMLInputElement, value: string) => {
		if (!value) return;

		input.value = value;
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new Event("change", { bubbles: true }));

		applyAutofillHighlight(input);
	};

	const address = item.addresses?.[0];
	const phoneNumber = item.phoneNumbers?.[0];

	switch (field.type) {
		case "firstName":
			if (item.firstName) fillField(field.input, item.firstName);
			break;
		case "lastName":
			if (item.lastName) fillField(field.input, item.lastName);
			break;
		case "email":
			if (item.email) fillField(field.input, item.email);
			break;
		case "phone":
			if (phoneNumber?.number) fillField(field.input, phoneNumber.number);
			break;
		case "street":
			if (address?.street) fillField(field.input, address.street);
			break;
		case "city":
			if (address?.city) fillField(field.input, address.city);
			break;
		case "state":
			if (address?.state) fillField(field.input, address.state);
			break;
		case "postalCode":
			if (address?.zip) fillField(field.input, address.zip);
			break;
		case "country":
			if (address?.country) fillField(field.input, address.country);
			break;
		case "dateOfBirth":
			if (item.dateOfBirth) fillField(field.input, item.dateOfBirth);
			break;
	}

	if (formGroup) {
		if (
			formGroup.firstNameField &&
			formGroup.firstNameField.element !== field.input &&
			item.firstName
		) {
			fillField(formGroup.firstNameField.element, item.firstName);
		}

		if (
			formGroup.lastNameField &&
			formGroup.lastNameField.element !== field.input &&
			item.lastName
		) {
			fillField(formGroup.lastNameField.element, item.lastName);
		}

		if (
			formGroup.emailField &&
			formGroup.emailField.element !== field.input &&
			item.email
		) {
			fillField(formGroup.emailField.element, item.email);
		}

		if (
			formGroup.phoneField &&
			formGroup.phoneField.element !== field.input &&
			phoneNumber?.number
		) {
			fillField(formGroup.phoneField.element, phoneNumber.number);
		}

		if (address) {
			if (
				formGroup.streetField &&
				formGroup.streetField.element !== field.input &&
				address.street
			) {
				fillField(formGroup.streetField.element, address.street);
			}
			if (
				formGroup.cityField &&
				formGroup.cityField.element !== field.input &&
				address.city
			) {
				fillField(formGroup.cityField.element, address.city);
			}
			if (
				formGroup.stateField &&
				formGroup.stateField.element !== field.input &&
				address.state
			) {
				fillField(formGroup.stateField.element, address.state);
			}
			if (
				formGroup.postalCodeField &&
				formGroup.postalCodeField.element !== field.input &&
				address.zip
			) {
				fillField(formGroup.postalCodeField.element, address.zip);
			}
			if (
				formGroup.countryField &&
				formGroup.countryField.element !== field.input &&
				address.country
			) {
				fillField(formGroup.countryField.element, address.country);
			}
		}

		if (
			formGroup.dateOfBirthField &&
			formGroup.dateOfBirthField.element !== field.input &&
			item.dateOfBirth
		) {
			fillField(formGroup.dateOfBirthField.element, item.dateOfBirth);
		}
	} else {
		for (const [input, identityField] of contentState.detectedIdentityFields) {
			if (input === field.input) continue;

			const inputForm = input.closest("form");
			if (inputForm !== (field.input.closest("form") || null)) continue;

			switch (identityField.type) {
				case "firstName":
					if (item.firstName) fillField(input, item.firstName);
					break;
				case "lastName":
					if (item.lastName) fillField(input, item.lastName);
					break;
				case "email":
					if (item.email) fillField(input, item.email);
					break;
				case "phone":
					if (phoneNumber?.number) fillField(input, phoneNumber.number);
					break;
				case "street":
					if (address?.street) fillField(input, address.street);
					break;
				case "city":
					if (address?.city) fillField(input, address.city);
					break;
				case "state":
					if (address?.state) fillField(input, address.state);
					break;
				case "postalCode":
					if (address?.zip) fillField(input, address.zip);
					break;
				case "country":
					if (address?.country) fillField(input, address.country);
					break;
				case "dateOfBirth":
					if (item.dateOfBirth) fillField(input, item.dateOfBirth);
					break;
			}
		}
	}

	setTimeout(() => {
		contentState.isAutofilling = false;
	}, 100);

	hideIdentityAutofillOverlay(field);
	contentState.currentFocusedIdentityField = null;

	console.log("Identity autofill completed for:", item.title);
}

// Show unlock prompt for identity fields
function showIdentityUnlockPrompt(field: IdentityField) {
	showUnlockIframePrompt(field, {
		iframeSrc: "identity-autofill-iframe.html",
		readyMessageType: "IDENTITY_IFRAME_READY",
	});
}

// Show re-auth prompt for identity fields
function showIdentityReauthPrompt(field: IdentityField) {
	showReauthPromptCard(field, "Please re-authenticate to use identity autofill");
}
