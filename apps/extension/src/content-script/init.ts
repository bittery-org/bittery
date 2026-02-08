import { cleanupAutofillState, setupOutsideClickHandler } from "./autofill";
import { setupAjaxDetection } from "./capture";
import {
	detectPasswordFields,
	detectPasswordFieldsLegacy,
	setupDynamicDetectionObserver,
	setupShadowRootWatcher,
} from "./detection";
import { restorePendingSavePrompt } from "./save-prompt";

export function initContentScript() {
	console.log("Bittery content script loaded");

	setupOutsideClickHandler();
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
