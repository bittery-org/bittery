import type { DecryptedItem } from "@bittery/shared/types";
import {
	cleanupAutofillState,
	fillCredentialItem,
	setupOutsideClickHandler,
} from "./autofill";
import { setupAjaxDetection } from "./capture";
import {
	detectPasswordFields,
	detectPasswordFieldsLegacy,
	setupDynamicDetectionObserver,
	setupShadowRootWatcher,
} from "./detection";
import { restorePendingSavePrompt } from "./save-prompt";

/**
 * Listen for popup-initiated fill requests. The popup sends the decrypted
 * credential for the item the user chose to autofill on the active tab.
 */
function setupPopupMessageHandler() {
	chrome.runtime.onMessage.addListener(
		(
			message: { type?: string; payload?: { item?: DecryptedItem } },
			sender,
			sendResponse,
		) => {
			if (
				message?.type !== "FILL_ITEM" ||
				!message.payload?.item ||
				sender.id !== chrome.runtime.id
			) {
				return undefined;
			}

			fillCredentialItem(message.payload.item)
				.then((filled) => sendResponse({ success: true, filled }))
				.catch((error) => {
					console.warn("Failed to fill item from popup:", error);
					sendResponse({ success: false, filled: false });
				});

			// Keep the message channel open for the async response.
			return true;
		},
	);
}

export function initContentScript() {
	setupOutsideClickHandler();
	setupPopupMessageHandler();
	setupAjaxDetection();

	const runInitialDetection = () => {
		detectPasswordFields();
		detectPasswordFieldsLegacy();
		restorePendingSavePrompt();
		setupShadowRootWatcher();
	};

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", runInitialDetection);
	} else {
		runInitialDetection();
	}

	setupDynamicDetectionObserver();

	window.addEventListener("beforeunload", () => {
		cleanupAutofillState();
	});
}
