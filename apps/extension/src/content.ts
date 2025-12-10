/**
 * Content Script
 * Detects password fields and injects autofill UI via shadow DOM
 */

console.log("Bittery content script loaded");

interface CredentialField {
	input: HTMLInputElement;
	type: "username" | "email" | "password";
	overlay?: HTMLElement;
	messageHandler?: (event: MessageEvent) => void;
	readyTimeout?: NodeJS.Timeout;
}

const detectedFields = new Map<HTMLInputElement, CredentialField>();
let currentFocusedField: CredentialField | null = null;

// Detect password fields
function detectPasswordFields() {
	const inputs = document.querySelectorAll<HTMLInputElement>(
		'input[type="password"], input[type="email"], input[type="text"][autocomplete*="username"], input[type="text"][autocomplete*="email"]'
	);

	inputs.forEach((input) => {
		if (detectedFields.has(input)) return;

		// Determine field type
		let type: "username" | "email" | "password" = "username";
		if (input.type === "password") {
			type = "password";
		} else if (
			input.type === "email" ||
			input.autocomplete?.includes("email")
		) {
			type = "email";
		}

		const field: CredentialField = { input, type };
		detectedFields.set(input, field);

		// Disable browser's native autofill
		input.setAttribute("autocomplete", "off");
		input.setAttribute("data-form-type", "other");
		
		// Also disable on the parent form if it exists
		const form = input.closest("form");
		if (form && !form.hasAttribute("data-bittery-processed")) {
			form.setAttribute("autocomplete", "off");
			form.setAttribute("data-bittery-processed", "true");
		}

		// Add focus listener
		input.addEventListener("focus", () => handleFieldFocus(field));
		input.addEventListener("blur", () => handleFieldBlur(field));
	});
}

// Handle field focus
async function handleFieldFocus(field: CredentialField) {
	// Hide any existing overlays from other fields
	if (currentFocusedField && currentFocusedField !== field) {
		hideAutofillOverlay(currentFocusedField);
	}
	
	currentFocusedField = field;

	// Check auth status before showing autofill
	const response = await chrome.runtime.sendMessage({
		type: "CHECK_AUTOFILL_AUTH",
	});

	if (!response.authenticated) {
		if (response.needsReauth) {
			showReauthPrompt(field);
		} else {
			// Extension is locked, needs quick unlock
			showUnlockPrompt(field);
		}
		return;
	}

	// Get available logins for current site
	const hostname = window.location.hostname;
	const itemsResponse = await chrome.runtime.sendMessage({
		type: "GET_AUTOFILL_ITEMS",
		payload: { hostname },
	});

	if (itemsResponse.items && itemsResponse.items.length > 0) {
		showAutofillOverlay(field, itemsResponse.items);
	}
}

// Handle field blur
function handleFieldBlur(field: CredentialField) {
	// Delay to allow clicking on overlay
	setTimeout(() => {
		if (currentFocusedField === field) {
			hideAutofillOverlay(field);
			currentFocusedField = null;
		}
	}, 200);
}

// Show autofill overlay
function showAutofillOverlay(field: CredentialField, items: any[]) {

	// Remove existing overlay
	if (field.overlay) {
		field.overlay.remove();
	}

	// Create shadow host
	const shadowHost = document.createElement("div");
	shadowHost.style.position = "fixed";
	shadowHost.style.zIndex = "2147483647"; // Max z-index
	shadowHost.style.opacity = "0";
	shadowHost.style.transform = "translateY(-8px)";
	shadowHost.style.transition = "opacity 0.15s ease-out, transform 0.15s ease-out";
	document.body.appendChild(shadowHost);

	// Attach shadow DOM
	const shadow = shadowHost.attachShadow({ mode: "open" });

	// Position overlay
	const rect = field.input.getBoundingClientRect();
	shadowHost.style.top = `${rect.bottom + window.scrollY}px`;
	shadowHost.style.left = `${rect.left}px`;
	shadowHost.style.width = `${Math.max(rect.width, 300)}px`;

	// Create iframe
	const iframe = document.createElement("iframe");
	iframe.style.border = "none";
	iframe.style.width = "100%";
	iframe.style.height = "auto";
	iframe.style.maxHeight = "300px";
	iframe.style.display = "block";
	iframe.src = chrome.runtime.getURL("autofill-iframe.html");

	shadow.appendChild(iframe);
	field.overlay = shadowHost;

	// Trigger animation after a brief delay
	setTimeout(() => {
		shadowHost.style.opacity = "1";
		shadowHost.style.transform = "translateY(0)";
	}, 10);

	// Wait for iframe to signal it's ready
	const messageHandler = (event: MessageEvent) => {		
		if (event.data.type === "IFRAME_READY") {
			if (field.readyTimeout) {
				clearTimeout(field.readyTimeout);
				field.readyTimeout = undefined;
			}
			
			// Send items to iframe
			iframe.contentWindow?.postMessage(
				{
					type: "AUTOFILL_ITEMS",
					items,
					fieldType: field.type,
				},
				"*",
			);
		} else if (event.data.type === "AUTOFILL_SELECT") {
			handleAutofillSelect(field, event.data.item);
		}
	};
	
	field.messageHandler = messageHandler;
	window.addEventListener("message", messageHandler);
	
	// Fallback: send items after a delay if ready signal not received
	field.readyTimeout = setTimeout(() => {
		console.log("Timeout waiting for iframe ready, sending items anyway");
		iframe.contentWindow?.postMessage(
			{
				type: "AUTOFILL_ITEMS",
				items,
				fieldType: field.type,
			},
			"*",
		);
	}, 100);

	// Add keyboard navigation
	document.addEventListener("keydown", handleKeyboardNavigation);
}

// Hide autofill overlay
function hideAutofillOverlay(field: CredentialField) {
	if (field.overlay) {
		field.overlay.remove();
		field.overlay = undefined;
	}
	if (field.messageHandler) {
		window.removeEventListener("message", field.messageHandler);
		field.messageHandler = undefined;
	}
	if (field.readyTimeout) {
		clearTimeout(field.readyTimeout);
		field.readyTimeout = undefined;
	}
	document.removeEventListener("keydown", handleKeyboardNavigation);
}

// Handle keyboard navigation
function handleKeyboardNavigation(event: KeyboardEvent) {
	if (event.key === "Escape") {
		if (currentFocusedField) {
			hideAutofillOverlay(currentFocusedField);
			currentFocusedField = null;
		}
	}
	// Arrow keys and Enter are handled by iframe
}

// Handle autofill selection
async function handleAutofillSelect(field: CredentialField, item: any) {
	// Update autofill timestamp
	await chrome.runtime.sendMessage({
		type: "UPDATE_AUTOFILL_TIMESTAMP",
	});

	// Fill the field
	if (field.type === "password" && item.password) {
		field.input.value = item.password;
	} else if (
		(field.type === "username" || field.type === "email") &&
		item.username
	) {
		field.input.value = item.username;
	}

	// Trigger input event for frameworks
	field.input.dispatchEvent(new Event("input", { bubbles: true }));
	field.input.dispatchEvent(new Event("change", { bubbles: true }));

	// Try to find and fill related fields
	const form = field.input.closest("form") || document;
	
	if (field.type === "password") {
		// Find username field when password is filled
		// First, check our detected fields
		let usernameField: HTMLInputElement | undefined;
		
		for (const [input, detectedField] of detectedFields) {
			if (
				input !== field.input &&
				(detectedField.type === "username" || detectedField.type === "email")
			) {
				// Prefer fields in the same form
				const fieldForm = input.closest("form");
				if (fieldForm === (field.input.closest("form") || null)) {
					usernameField = input;
					break;
				} else if (!usernameField) {
					usernameField = input;
				}
			}
		}
		
		// Fallback: search for username fields in the form
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
			usernameField.value = item.username;
			usernameField.dispatchEvent(new Event("input", { bubbles: true }));
			usernameField.dispatchEvent(new Event("change", { bubbles: true }));
		}
	} else if (field.type === "username" || field.type === "email") {
		// Find password field when username/email is filled
		const passwordField = Array.from(
			form.querySelectorAll<HTMLInputElement>('input[type="password"]'),
		).find((input) => input !== field.input);

		if (passwordField && item.password) {
			passwordField.value = item.password;
			passwordField.dispatchEvent(new Event("input", { bubbles: true }));
			passwordField.dispatchEvent(new Event("change", { bubbles: true }));
		}
	}

	// Hide overlay
	hideAutofillOverlay(field);
	currentFocusedField = null;
}

// Show unlock prompt (when extension is locked)
function showUnlockPrompt(field: CredentialField) {
	// Remove existing overlay
	if (field.overlay) {
		field.overlay.remove();
	}

	// Create shadow host
	const shadowHost = document.createElement("div");
	shadowHost.style.position = "fixed";
	shadowHost.style.zIndex = "2147483647"; // Max z-index
	shadowHost.style.opacity = "0";
	shadowHost.style.transform = "translateY(-8px)";
	shadowHost.style.transition = "opacity 0.15s ease-out, transform 0.15s ease-out";
	document.body.appendChild(shadowHost);

	// Attach shadow DOM
	const shadow = shadowHost.attachShadow({ mode: "open" });

	// Position overlay
	const rect = field.input.getBoundingClientRect();
	shadowHost.style.top = `${rect.bottom + window.scrollY}px`;
	shadowHost.style.left = `${rect.left}px`;
	shadowHost.style.width = `${Math.max(rect.width, 300)}px`;

	// Create iframe
	const iframe = document.createElement("iframe");
	iframe.style.border = "none";
	iframe.style.width = "100%";
	iframe.style.height = "auto";
	iframe.style.maxHeight = "300px";
	iframe.style.display = "block";
	iframe.src = chrome.runtime.getURL("autofill-iframe.html");

	shadow.appendChild(iframe);
	field.overlay = shadowHost;

	// Trigger animation after a brief delay
	setTimeout(() => {
		shadowHost.style.opacity = "1";
		shadowHost.style.transform = "translateY(0)";
	}, 10);

	// Wait for iframe to signal it's ready
	const messageHandler = (event: MessageEvent) => {
		if (event.data.type === "IFRAME_READY") {
			if (field.readyTimeout) {
				clearTimeout(field.readyTimeout);
				field.readyTimeout = undefined;
			}
			
			// Send unlock needed message to iframe
			iframe.contentWindow?.postMessage(
				{
					type: "NEEDS_UNLOCK",
				},
				"*",
			);
		}
	};
	
	field.messageHandler = messageHandler;
	window.addEventListener("message", messageHandler);
	
	// Fallback: send message after a delay if ready signal not received
	field.readyTimeout = setTimeout(() => {
		iframe.contentWindow?.postMessage(
			{
				type: "NEEDS_UNLOCK",
			},
			"*",
		);
	}, 100);
}

// Show re-authentication prompt
function showReauthPrompt(field: CredentialField) {
	// Create shadow host for prompt
	const shadowHost = document.createElement("div");
	shadowHost.style.position = "fixed";
	shadowHost.style.zIndex = "2147483647";
	document.body.appendChild(shadowHost);

	const shadow = shadowHost.attachShadow({ mode: "open" });

	// Position prompt
	const rect = field.input.getBoundingClientRect();
	shadowHost.style.top = `${rect.bottom + window.scrollY}px`;
	shadowHost.style.left = `${rect.left + window.scrollX}px`;
	shadowHost.style.width = `${Math.max(rect.width, 250)}px`;

	// Create prompt UI
	const container = document.createElement("div");
	container.style.cssText = `
		background: white;
		border: 1px solid #e2e8f0;
		border-radius: 8px;
		box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
		padding: 12px;
		font-family: system-ui, -apple-system, sans-serif;
		font-size: 13px;
	`;

	container.innerHTML = `
		<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
			<span style="font-size: 16px;">🔒</span>
			<span style="font-weight: 500;">Authentication Required</span>
		</div>
		<p style="margin: 0 0 8px 0; color: #64748b; font-size: 12px;">
			Please re-authenticate to use autofill
		</p>
		<button style="
			width: 100%;
			padding: 6px 12px;
			background: #3b82f6;
			color: white;
			border: none;
			border-radius: 6px;
			font-size: 12px;
			font-weight: 500;
			cursor: pointer;
		">
			Open Bittery
		</button>
	`;

	const button = container.querySelector("button");
	button?.addEventListener("click", () => {
		chrome.runtime.sendMessage({ type: "OPEN_POPUP" });
		shadowHost.remove();
	});

	shadow.appendChild(container);
	field.overlay = shadowHost;

	// Auto-hide after 5 seconds
	setTimeout(() => {
		shadowHost.remove();
	}, 5000);
}

// Run detection on load and on DOM changes
if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", detectPasswordFields);
} else {
	detectPasswordFields();
}

// Watch for dynamic content
const observer = new MutationObserver(() => {
	detectPasswordFields();
});

observer.observe(document.body, {
	childList: true,
	subtree: true,
});

// Clean up on unload
window.addEventListener("beforeunload", () => {
	detectedFields.forEach((field) => {
		if (field.overlay) {
			field.overlay.remove();
		}
	});
	detectedFields.clear();
});
