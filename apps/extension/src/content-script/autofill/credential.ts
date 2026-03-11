import { generateTotp } from "@bittery/shared/totp";
import type { DecryptedItem } from "@bittery/shared/types";
import {
	detectFieldType,
	detectOTPFields,
	isFieldVisible,
} from "../../lib/field-detection";
import { contentState } from "../state";
import type { CredentialField } from "../types";
import { hideFieldIcon, showFieldIcon } from "./icon";
import {
	hideItemsOverlay,
	showItemsOverlay,
	showReauthPromptCard,
	showUnlockIframePrompt,
} from "./overlay-utils";

// Handle field focus
export async function handleFieldFocus(field: CredentialField) {
	if (
		contentState.currentFocusedField &&
		contentState.currentFocusedField !== field
	) {
		hideAutofillOverlay(contentState.currentFocusedField);
		hideFieldIcon(contentState.currentFocusedField);
	}

	contentState.currentFocusedField = field;

	const response = await chrome.runtime.sendMessage({
		type: "CHECK_AUTOFILL_AUTH",
	});

	if (contentState.currentFocusedField !== field) return;

	const handleIconToggle = async () => {
		if (field.overlay) {
			hideAutofillOverlay(field);
		} else {
			await handleFieldFocus(field);
		}
	};

	if (!response.authenticated) {
		field.hasItems = false;
		showFieldIcon(field, false, handleIconToggle);

		if (response.needsReauth) {
			showReauthPrompt(field);
		} else {
			showUnlockPrompt(field);
		}
		return;
	}

	const itemsResponse = await chrome.runtime.sendMessage({
		type: "GET_AUTOFILL_ITEMS",
		payload: { hostname: new URL(window.location.href).hostname },
	});

	if (contentState.currentFocusedField !== field) return;

	const hasItems = itemsResponse.items && itemsResponse.items.length > 0;
	field.hasItems = hasItems;

	if (hasItems) {
		showFieldIcon(field, true, handleIconToggle);
		showAutofillOverlay(field, itemsResponse.items);
	} else {
		showFieldIcon(field, false, handleIconToggle);
	}
}

// Handle field blur
export function handleFieldBlur(field: CredentialField) {
	setTimeout(() => {
		if (contentState.currentFocusedField === field) {
			hideAutofillOverlay(field);
			hideFieldIcon(field);
			contentState.currentFocusedField = null;
		}
	}, 200);
}

// Show autofill overlay
function showAutofillOverlay(field: CredentialField, items: DecryptedItem[]) {
	showItemsOverlay({
		field,
		items,
		iframeSrc: "autofill-iframe.html",
		readyMessageType: "IFRAME_READY",
		selectMessageType: "AUTOFILL_SELECT",
		itemsMessageType: "AUTOFILL_ITEMS",
		filterMessageType: "FILTER_ITEMS",
		fieldType: field.type,
		onSelect: handleAutofillSelect,
		setCurrentIframe: (iframe) => {
			contentState.currentAutofillIframe = iframe;
		},
		keyboardHandler: handleKeyboardNavigation,
		timeoutLog: "Timeout waiting for iframe ready, sending items anyway",
		isAutofilling: () => contentState.isAutofilling,
	});
}

// Hide autofill overlay
export function hideAutofillOverlay(field: CredentialField) {
	hideItemsOverlay(field, {
		setCurrentIframe: () => {
			contentState.currentAutofillIframe = null;
		},
		keyboardHandler: handleKeyboardNavigation,
	});
}

// Handle keyboard navigation
function handleKeyboardNavigation(event: KeyboardEvent) {
	if (event.key === "Escape") {
		if (contentState.currentFocusedField) {
			hideAutofillOverlay(contentState.currentFocusedField);
			contentState.currentFocusedField = null;
		}
	}
	if (
		event.key === "ArrowDown" ||
		event.key === "ArrowUp" ||
		event.key === "Enter"
	) {
		if (contentState.currentAutofillIframe) {
			event.preventDefault();
			const iframeOrigin = new URL(contentState.currentAutofillIframe.src).origin;
			const nonce =
				new URL(contentState.currentAutofillIframe.src).searchParams.get(
					"nonce",
				) ?? "";
			contentState.currentAutofillIframe.contentWindow?.postMessage(
				{ type: "KEYBOARD_NAV", key: event.key, nonce },
				iframeOrigin,
			);
		}
	}
}

function fillInputWithEvents(input: HTMLInputElement, value: string) {
	input.value = value;
	input.dispatchEvent(new Event("input", { bubbles: true }));
	input.dispatchEvent(new Event("change", { bubbles: true }));
}

function sortInputsByDomOrder(inputs: HTMLInputElement[]): HTMLInputElement[] {
	return [...inputs].sort((a, b) => {
		if (a === b) return 0;
		const position = a.compareDocumentPosition(b);
		if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
		if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
		return 0;
	});
}

function isPotentialOtpSegmentInput(input: HTMLInputElement): boolean {
	if (input.maxLength !== 1) return false;
	if (input.disabled || input.readOnly) return false;
	if (!isFieldVisible(input)) return false;

	const inputMode = input.inputMode?.toLowerCase() || "";
	const pattern = input.pattern?.toLowerCase() || "";
	return (
		inputMode === "numeric" ||
		inputMode === "tel" ||
		pattern.includes("[0-9]") ||
		pattern.includes("\\d")
	);
}

function getOtpInputCandidates(
	referenceInput: HTMLInputElement,
): HTMLInputElement[] {
	const referenceForm = referenceInput.closest("form");
	const detectedOtpInputs = detectOTPFields(document)
		.map((field) => field.element)
		.filter(
			(input) =>
				input.isConnected &&
				!input.disabled &&
				!input.readOnly &&
				isFieldVisible(input),
		);

	const fallbackScope: ParentNode = referenceForm || document;
	const fallbackOtpSegments = Array.from(
		fallbackScope.querySelectorAll<HTMLInputElement>("input"),
	).filter(isPotentialOtpSegmentInput);

	let candidates = Array.from(
		new Set([...detectedOtpInputs, ...fallbackOtpSegments]),
	);

	if (referenceForm) {
		const sameFormCandidates = candidates.filter(
			(input) => input.closest("form") === referenceForm,
		);
		if (sameFormCandidates.length > 0) {
			candidates = sameFormCandidates;
		}
	}

	const { type: referenceType } = detectFieldType(referenceInput);
	if (
		(referenceType === "otp" || isPotentialOtpSegmentInput(referenceInput)) &&
		!candidates.includes(referenceInput)
	) {
		candidates.push(referenceInput);
	}

	return sortInputsByDomOrder(candidates);
}

async function autofillTotpCodeForItem(
	referenceInput: HTMLInputElement,
	item: DecryptedItem,
): Promise<boolean> {
	if (!item.totpSecret) return false;

	try {
		const result = await generateTotp({
			secret: item.totpSecret,
			algorithm: item.totpAlgorithm,
			digits: item.totpDigits,
			period: item.totpPeriod,
		});
		const otpCode = result.code.replace(/\s+/g, "");
		if (!otpCode) return false;

		const otpInputs = getOtpInputCandidates(referenceInput);
		if (otpInputs.length === 0) return false;

		const segmentedInputs = otpInputs.filter(isPotentialOtpSegmentInput);
		if (segmentedInputs.length >= 4 && segmentedInputs.length <= 8) {
			segmentedInputs.forEach((input, index) => {
				fillInputWithEvents(input, otpCode[index] ?? "");
			});
			return true;
		}

		const targetInput = otpInputs.includes(referenceInput)
			? referenceInput
			: otpInputs[0];
		if (!targetInput) return false;

		const valueToFill =
			targetInput.maxLength === 1 ? (otpCode[0] ?? "") : otpCode;
		fillInputWithEvents(targetInput, valueToFill);
		return true;
	} catch (error) {
		console.warn("Failed to autofill TOTP code:", error);
		return false;
	}
}

// Handle autofill selection
async function handleAutofillSelect(
	field: CredentialField,
	item: DecryptedItem,
) {
	await chrome.runtime.sendMessage({
		type: "UPDATE_AUTOFILL_TIMESTAMP",
	});

	contentState.isAutofilling = true;

	if (field.type === "otp") {
		await autofillTotpCodeForItem(field.input, item);
	} else {
		if (field.type === "password" && item.password) {
			fillInputWithEvents(field.input, item.password);
		} else if (
			(field.type === "username" || field.type === "email") &&
			item.username
		) {
			fillInputWithEvents(field.input, item.username);
		}

		const form = field.input.closest("form") || document;

		if (field.type === "password") {
			let usernameField: HTMLInputElement | undefined;

			for (const [input, detectedField] of contentState.detectedFields) {
				if (
					input !== field.input &&
					(detectedField.type === "username" || detectedField.type === "email")
				) {
					const fieldForm = input.closest("form");
					if (fieldForm === (field.input.closest("form") || null)) {
						usernameField = input;
						break;
					}
					if (!usernameField) {
						usernameField = input;
					}
				}
			}

			if (!usernameField) {
				usernameField = Array.from(
					form.querySelectorAll<HTMLInputElement>(
						'input[type="text"], input[type="email"]',
					),
				).find(
					(input) =>
						input !== field.input &&
						(input.autocomplete?.includes("username") ||
							input.autocomplete?.includes("email") ||
							input.name?.toLowerCase().includes("username") ||
							input.name?.toLowerCase().includes("email")),
				);
			}

			if (usernameField && item.username) {
				fillInputWithEvents(usernameField, item.username);
			}
		} else if (field.type === "username" || field.type === "email") {
			const passwordField = Array.from(
				form.querySelectorAll<HTMLInputElement>('input[type="password"]'),
			).find((input) => input !== field.input);

			if (passwordField && item.password) {
				fillInputWithEvents(passwordField, item.password);
			}
		}

		await autofillTotpCodeForItem(field.input, item);
	}

	setTimeout(() => {
		contentState.isAutofilling = false;
	}, 100);

	hideAutofillOverlay(field);
	contentState.currentFocusedField = null;
}

// Show unlock prompt (when extension is locked)
function showUnlockPrompt(field: CredentialField) {
	showUnlockIframePrompt(field, {
		iframeSrc: "autofill-iframe.html",
		readyMessageType: "IFRAME_READY",
	});
}

// Show re-authentication prompt
function showReauthPrompt(field: CredentialField) {
	showReauthPromptCard(field, "Please re-authenticate to use autofill");
}
