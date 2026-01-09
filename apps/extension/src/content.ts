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

// Track forms to avoid duplicate listeners
const processedForms = new WeakSet<HTMLFormElement>();

// Track pending AJAX requests for form submission detection
interface PendingRequest {
	url: string;
	method: string;
	body: Document | XMLHttpRequestBodyInit | BodyInit | null | undefined;
	timestamp: number;
	form?: HTMLFormElement;
}
const pendingAjaxRequests = new Map<string, PendingRequest>();

// Detect password fields
function detectPasswordFields() {
	const inputs = document.querySelectorAll<HTMLInputElement>(
		'input[type="password"], input[type="email"], input[type="text"][autocomplete*="username"], input[type="text"][autocomplete*="email"]',
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

		// Add form submission listeners
		if (form && !processedForms.has(form)) {
			attachFormSubmitListeners(form);
			processedForms.add(form);
		}
	});
}

// Attach form submission listeners
function attachFormSubmitListeners(form: HTMLFormElement) {
	// Track form interactions for AJAX detection
	const trackInteraction = () => trackFormInteraction(form);

	// Listen for form submit event (traditional submission)
	form.addEventListener(
		"submit",
		(event) => {
			trackInteraction();
			handleFormSubmit(event, form);
		},
		true, // Use capture phase to ensure we catch it early
	);

	// Listen for submit button clicks (in case form.submit() is called via JS)
	const submitButtons = form.querySelectorAll<
		HTMLButtonElement | HTMLInputElement
	>('button[type="submit"], input[type="submit"], button:not([type])');

	submitButtons.forEach((button) => {
		button.addEventListener("click", () => {
			trackInteraction();
			// Wait a tiny bit for the form to process the click
			setTimeout(() => {
				// Check if form is still valid and might be submitting
				if (form.checkValidity()) {
					handleFormSubmit(null, form);
				}
			}, 50);
		});
	});

	// Listen for Enter key in input fields (common form submission trigger)
	const formInputs = form.querySelectorAll<HTMLInputElement>("input");
	formInputs.forEach((input) => {
		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && !event.shiftKey) {
				trackInteraction();
				// Wait for form to process the Enter key
				setTimeout(() => {
					if (form.checkValidity()) {
						handleFormSubmit(null, form);
					}
				}, 50);
			}
		});
	});
}

// Capture credentials from a form
interface CapturedCredentials {
	username: string;
	password: string;
	url: string;
	hostname: string;
	usernameField?: HTMLInputElement;
	passwordField?: HTMLInputElement;
}

function captureCredentials(
	form?: HTMLFormElement,
): CapturedCredentials | null {
	// Determine the scope to search for fields
	const searchScope = form || document;

	// Find password field - prioritize detected fields, then search the form/document
	let passwordField: HTMLInputElement | undefined;
	let passwordValue = "";

	// First, check our detected fields for password fields in this form
	for (const [input, field] of detectedFields) {
		if (field.type === "password" && input.value) {
			// If we have a form, ensure the field is within this form
			if (!form || input.closest("form") === form) {
				passwordField = input;
				passwordValue = input.value;
				break;
			}
		}
	}

	// Fallback: search for password fields in the scope
	if (!passwordField) {
		const passwordFields = Array.from(
			searchScope.querySelectorAll<HTMLInputElement>('input[type="password"]'),
		).filter((input) => input.value); // Only consider fields with values

		if (passwordFields.length > 0) {
			// Prefer visible fields
			passwordField =
				passwordFields.find((field) => {
					const rect = field.getBoundingClientRect();
					return rect.width > 0 && rect.height > 0;
				}) || passwordFields[0];

			passwordValue = passwordField?.value || "";
		}
	}

	// If no password found, we can't capture credentials
	if (!passwordValue || !passwordField) {
		console.log("No password field found or password is empty");
		return null;
	}

	// Find username/email field
	let usernameField: HTMLInputElement | undefined;
	let usernameValue = "";

	// First, check our detected fields for username/email fields in this form
	for (const [input, field] of detectedFields) {
		if ((field.type === "username" || field.type === "email") && input.value) {
			// If we have a form, ensure the field is within this form
			if (!form || input.closest("form") === form) {
				usernameField = input;
				usernameValue = input.value;
				break;
			}
		}
	}

	// Fallback: search for username/email fields in the scope
	if (!usernameField) {
		const candidateFields = Array.from(
			searchScope.querySelectorAll<HTMLInputElement>(
				'input[type="text"], input[type="email"], input[type="tel"], input[name*="user"], input[name*="email"], input[name*="login"], input[id*="user"], input[id*="email"], input[id*="login"]',
			),
		).filter((input) => {
			// Exclude password fields and empty fields
			if (input.type === "password" || !input.value) return false;

			// If we have a form, ensure the field is within this form
			if (form && input.closest("form") !== form) return false;

			// Check if it looks like a username/email field
			const name = input.name?.toLowerCase() || "";
			const id = input.id?.toLowerCase() || "";
			const autocomplete = input.autocomplete?.toLowerCase() || "";
			const placeholder = input.placeholder?.toLowerCase() || "";

			return (
				input.type === "email" ||
				autocomplete.includes("username") ||
				autocomplete.includes("email") ||
				name.includes("user") ||
				name.includes("email") ||
				name.includes("login") ||
				id.includes("user") ||
				id.includes("email") ||
				id.includes("login") ||
				placeholder.includes("user") ||
				placeholder.includes("email") ||
				placeholder.includes("login")
			);
		});

		if (candidateFields.length > 0) {
			// Prefer visible fields
			usernameField =
				candidateFields.find((field) => {
					const rect = field.getBoundingClientRect();
					return rect.width > 0 && rect.height > 0;
				}) || candidateFields[0];

			usernameValue = usernameField?.value || "";
		}
	}

	// If no username found, we might still want to capture just the password
	// but for login forms, username is typically required
	if (!usernameValue) {
		console.log("No username field found or username is empty");
		// Still return null for now - we need both username and password
		// This could be adjusted in the future if needed
		return null;
	}

	// Capture URL information
	const url = window.location.href;
	const hostname = window.location.hostname;

	return {
		username: usernameValue,
		password: passwordValue,
		url,
		hostname,
		usernameField,
		passwordField,
	};
}

// Check if credentials should be saved
async function shouldSaveCredentials(
	credentials: CapturedCredentials,
): Promise<{ shouldSave: boolean; reason?: string }> {
	// Validate that credentials have required fields
	if (!credentials.username || !credentials.password) {
		return {
			shouldSave: false,
			reason: "Missing username or password",
		};
	}

	// Validate username is not too short (likely invalid)
	if (credentials.username.trim().length < 2) {
		return {
			shouldSave: false,
			reason: "Username too short (likely invalid)",
		};
	}

	// Validate password is not too short (likely invalid)
	if (credentials.password.length < 3) {
		return {
			shouldSave: false,
			reason: "Password too short (likely invalid)",
		};
	}

	// Check if extension is unlocked
	try {
		const authResponse = await chrome.runtime.sendMessage({
			type: "CHECK_AUTH",
		});

		if (!authResponse.unlocked) {
			console.log("Extension is locked - cannot save credentials");
			return {
				shouldSave: false,
				reason: "Extension is locked",
			};
		}

		// All checks passed
		return {
			shouldSave: true,
		};
	} catch (error) {
		console.error("Error checking auth status:", error);
		return {
			shouldSave: false,
			reason: "Failed to check extension lock state",
		};
	}
}

// Handle form submission
async function handleFormSubmit(_event: Event | null, form: HTMLFormElement) {
	console.log("Form submission detected:", form);

	// Capture credentials from the form
	const credentials = captureCredentials(form);

	if (credentials) {
		console.log("Captured credentials:", {
			username: credentials.username,
			url: credentials.url,
			hostname: credentials.hostname,
			// Don't log password for security
		});

		// Check if credentials should be saved
		const { shouldSave, reason } = await shouldSaveCredentials(credentials);

		if (shouldSave) {
			console.log(
				"Credentials are valid and extension is unlocked - ready to show save prompt",
			);
			// Show save prompt to user
			showSavePrompt(credentials);
		} else {
			console.log("Credentials will not be saved:", reason);
		}
	} else {
		console.log("Could not capture credentials from form");
	}
}

// ==================== AJAX Detection ====================

// Intercept XMLHttpRequest
const originalXHROpen = XMLHttpRequest.prototype.open;
const originalXHRSend = XMLHttpRequest.prototype.send;

XMLHttpRequest.prototype.open = function (
	method: string,
	url: string | URL,
	async?: boolean,
	username?: string | null,
	password?: string | null,
) {
	// Store request info on the XHR instance
	interface XHRWithRequestInfo extends XMLHttpRequest {
		_bitteryRequestInfo?: { method: string; url: string };
	}
	(this as XHRWithRequestInfo)._bitteryRequestInfo = {
		method: method.toUpperCase(),
		url: url.toString(),
	};
	return originalXHROpen.call(
		this,
		method,
		url,
		async ?? true,
		username ?? null,
		password ?? null,
	);
};

XMLHttpRequest.prototype.send = function (
	body?: Document | XMLHttpRequestBodyInit | null,
) {
	interface XHRWithRequestInfo extends XMLHttpRequest {
		_bitteryRequestInfo?: { method: string; url: string };
	}
	const requestInfo = (this as XHRWithRequestInfo)._bitteryRequestInfo;

	if (
		requestInfo &&
		(requestInfo.method === "POST" || requestInfo.method === "PUT")
	) {
		// Check if this looks like a login request
		if (isLikelyLoginRequest(requestInfo.url, body)) {
			const requestId = `xhr_${Date.now()}_${Math.random()}`;

			// Find associated form if any
			const form = findRecentlyInteractedForm();

			pendingAjaxRequests.set(requestId, {
				url: requestInfo.url,
				method: requestInfo.method,
				body: body,
				timestamp: Date.now(),
				form: form || undefined,
			});

			// Listen for response
			this.addEventListener("readystatechange", function () {
				if (this.readyState === 4) {
					handleAjaxResponse(requestId, this.status, form);
				}
			});
		}
	}

	return originalXHRSend.apply(this, [body]);
};

// Intercept fetch API
const originalFetch = window.fetch;
window.fetch = function (
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> {
	const url =
		typeof input === "string"
			? input
			: input instanceof URL
				? input.toString()
				: input.url;
	const method = init?.method?.toUpperCase() || "GET";

	if (method === "POST" || method === "PUT") {
		// Check if this looks like a login request
		if (isLikelyLoginRequest(url, init?.body)) {
			const requestId = `fetch_${Date.now()}_${Math.random()}`;

			// Find associated form if any
			const form = findRecentlyInteractedForm();

			pendingAjaxRequests.set(requestId, {
				url: url,
				method: method,
				body: init?.body,
				timestamp: Date.now(),
				form: form || undefined,
			});

			// Call original fetch and handle response
			return originalFetch
				.apply(this, [input, init])
				.then((response) => {
					handleAjaxResponse(requestId, response.status, form);
					return response;
				})
				.catch((error) => {
					// Clean up on error
					pendingAjaxRequests.delete(requestId);
					throw error;
				});
		}
	}

	return originalFetch.apply(this, [input, init]);
};

// Check if a request looks like a login/authentication request
function isLikelyLoginRequest(
	url: string,
	body: Document | XMLHttpRequestBodyInit | BodyInit | null | undefined,
): boolean {
	const urlLower = url.toLowerCase();

	// Check URL for common login/auth patterns
	const loginUrlPatterns = [
		"login",
		"signin",
		"sign-in",
		"authenticate",
		"auth",
		"session",
		"account",
		"user",
	];

	const hasLoginUrl = loginUrlPatterns.some((pattern) =>
		urlLower.includes(pattern),
	);

	// Check if body contains password-like fields
	let hasPasswordField = false;
	if (body) {
		try {
			let bodyStr = "";
			if (typeof body === "string") {
				bodyStr = body.toLowerCase();
			} else if (body instanceof FormData) {
				// Check FormData keys
				for (const key of (body as FormData).keys()) {
					if (
						key.toLowerCase().includes("password") ||
						key.toLowerCase().includes("pass")
					) {
						hasPasswordField = true;
						break;
					}
				}
			} else if (body instanceof URLSearchParams) {
				bodyStr = body.toString().toLowerCase();
			} else {
				bodyStr = JSON.stringify(body).toLowerCase();
			}

			if (!hasPasswordField && bodyStr) {
				hasPasswordField =
					bodyStr.includes("password") || bodyStr.includes("passwd");
			}
		} catch {
			// Ignore errors parsing body
		}
	}

	// Consider it a login request if URL suggests login OR body has password
	return hasLoginUrl || hasPasswordField;
}

// Find the most recently interacted form
let lastInteractedForm: HTMLFormElement | null = null;
let lastInteractionTime = 0;

function findRecentlyInteractedForm(): HTMLFormElement | null {
	// Return form if interaction was recent (within 5 seconds)
	if (lastInteractedForm && Date.now() - lastInteractionTime < 5000) {
		return lastInteractedForm;
	}
	return null;
}

// Track form interactions to associate AJAX requests with forms
function trackFormInteraction(form: HTMLFormElement) {
	lastInteractedForm = form;
	lastInteractionTime = Date.now();
}

// Handle AJAX response
function handleAjaxResponse(
	requestId: string,
	statusCode: number,
	form?: HTMLFormElement | null,
) {
	const request = pendingAjaxRequests.get(requestId);
	if (!request) return;

	// Consider successful responses (2xx) as potential successful logins
	if (statusCode >= 200 && statusCode < 300) {
		console.log("AJAX login request detected:", request.url, statusCode);

		// Treat this like a form submission
		if (form) {
			handleFormSubmit(null, form);
		} else {
			// If no form is associated, try to find password fields on the page
			// This will be useful for custom login implementations
			console.log(
				"AJAX login detected but no form associated - credentials may have been submitted",
			);
			handleAjaxLoginWithoutForm(request);
		}
	}

	// Clean up old requests (older than 30 seconds)
	const now = Date.now();
	for (const [id, req] of pendingAjaxRequests.entries()) {
		if (now - req.timestamp > 30000) {
			pendingAjaxRequests.delete(id);
		}
	}

	pendingAjaxRequests.delete(requestId);
}

// Handle AJAX login when no form is associated
async function handleAjaxLoginWithoutForm(_request: PendingRequest) {
	console.log("Detected AJAX login without associated form");

	// Try to capture credentials from the page (without a specific form)
	const credentials = captureCredentials();

	if (credentials) {
		console.log("Captured credentials from AJAX request:", {
			username: credentials.username,
			url: credentials.url,
			hostname: credentials.hostname,
			// Don't log password for security
		});

		// Check if credentials should be saved
		const { shouldSave, reason } = await shouldSaveCredentials(credentials);

		if (shouldSave) {
			console.log(
				"Credentials are valid and extension is unlocked - ready to show save prompt",
			);
			// Show save prompt to user
			showSavePrompt(credentials);
		} else {
			console.log("Credentials will not be saved:", reason);
		}
	} else {
		console.log("Could not capture credentials from AJAX login");
	}
}

// ==================== End AJAX Detection ====================

// ==================== Save Prompt ====================

// Track active save prompt
let activeSavePrompt: {
	shadowHost: HTMLElement;
	messageHandler: (event: MessageEvent) => void;
} | null = null;

type SavePromptOptions = {
	persist?: boolean;
};

function persistPendingSavePrompt(credentials: CapturedCredentials) {
	chrome.runtime
		.sendMessage({
			type: "SET_PENDING_SAVE_PROMPT",
			payload: {
				username: credentials.username,
				password: credentials.password,
				url: credentials.url,
				hostname: credentials.hostname,
			},
		})
		.catch((error) => {
			console.warn("Failed to persist save prompt:", error);
		});
}

function clearPendingSavePrompt() {
	chrome.runtime
		.sendMessage({ type: "CLEAR_PENDING_SAVE_PROMPT" })
		.catch((error) => {
			console.warn("Failed to clear save prompt:", error);
		});
}

async function restorePendingSavePrompt() {
	try {
		const response = await chrome.runtime.sendMessage({
			type: "GET_PENDING_SAVE_PROMPT",
		});

		if (response?.data) {
			await showSavePrompt(response.data, { persist: false });
		}
	} catch (error) {
		console.warn("Failed to restore save prompt:", error);
	}
}

// Show save prompt overlay
async function showSavePrompt(
	credentials: CapturedCredentials,
	options?: SavePromptOptions,
) {
	// Remove any existing save prompt
	if (activeSavePrompt) {
		hideSavePrompt();
	}

	if (options?.persist !== false) {
		persistPendingSavePrompt(credentials);
	}

	// Check for existing credentials before showing the prompt
	interface ExistingCredential {
		id: string;
		vaultId: string;
		username: string;
		url: string;
	}
	let existingCredentials: ExistingCredential[] = [];
	let hasDuplicates = false;
	try {
		const duplicateCheckResponse = await chrome.runtime.sendMessage({
			type: "CHECK_EXISTING_CREDENTIALS",
			payload: {
				url: credentials.url,
				username: credentials.username,
			},
		});

		if (duplicateCheckResponse.success) {
			existingCredentials = duplicateCheckResponse.existingCredentials || [];
			hasDuplicates = duplicateCheckResponse.hasDuplicates || false;
		}
	} catch (error) {
		console.error("Error checking for existing credentials:", error);
		// Continue with empty array - if check fails, we'll treat as no duplicates
	}

	// Get writable vaults from background script
	interface VaultOption {
		id: string;
		name: string;
		type: "personal" | "team";
		role: "owner" | "admin" | "member" | "read-only";
	}
	let vaults: VaultOption[] = [];
	try {
		const vaultsResponse = await chrome.runtime.sendMessage({
			type: "GET_WRITABLE_VAULTS",
		});

		if (vaultsResponse.vaults) {
			vaults = vaultsResponse.vaults;
		}
	} catch (error) {
		console.error("Error fetching writable vaults:", error);
		// Continue with empty vaults array - UI will handle the error state
	}

	// Create shadow host
	const shadowHost = document.createElement("div");
	shadowHost.style.position = "fixed";
	shadowHost.style.top = "20px";
	shadowHost.style.right = "20px";
	shadowHost.style.zIndex = "2147483647"; // Max z-index
	shadowHost.style.width = "360px";
	shadowHost.style.opacity = "0";
	shadowHost.style.transform = "translateY(-8px)";
	shadowHost.style.transition =
		"opacity 0.2s ease-out, transform 0.2s ease-out";
	document.body.appendChild(shadowHost);

	// Attach shadow DOM
	const shadow = shadowHost.attachShadow({ mode: "open" });

	// Create iframe
	const iframe = document.createElement("iframe");
	iframe.style.border = "none";
	iframe.style.width = "100%";
	iframe.style.height = "0px"; // Start with 0 height, allow content to dictate
	iframe.style.minHeight = "50px";
	iframe.style.display = "block";
	iframe.style.borderRadius = "8px"; // Match popup radius
	iframe.style.boxShadow = "0 4px 12px rgba(0, 0, 0, 0.15)"; // Softer shadow
	iframe.style.overflow = "hidden"; // Prevent scrollbars
	iframe.src = chrome.runtime.getURL("save-prompt-iframe.html");

	shadow.appendChild(iframe);

	// Trigger animation after a brief delay
	setTimeout(() => {
		shadowHost.style.opacity = "1";
		shadowHost.style.transform = "translateY(0)";
	}, 10);

	// Set up message handler
	const messageHandler = (event: MessageEvent) => {
		if (event.data.type === "SAVE_IFRAME_READY") {
			// Send credentials, vaults, and duplicate info to iframe
			iframe.contentWindow?.postMessage(
				{
					type: "SAVE_PROMPT_DATA",
					data: {
						username: credentials.username,
						password: credentials.password,
						url: credentials.url,
						vaults: vaults,
						hasDuplicates: hasDuplicates,
						existingCredentials: existingCredentials,
					},
				},
				"*",
			);
		} else if (event.data.type === "RESIZE_IFRAME") {
			if (event.data.height > 0) {
				iframe.style.height = `${event.data.height}px`;
			}
		} else if (event.data.type === "SAVE_CREDENTIAL") {
			handleSaveCredential(event.data, iframe);
		} else if (event.data.type === "UPDATE_EXISTING_CREDENTIAL") {
			handleUpdateCredential(event.data, iframe);
		} else if (event.data.type === "CANCEL_SAVE") {
			hideSavePrompt();
		}
	};

	window.addEventListener("message", messageHandler);

	// Store reference
	activeSavePrompt = {
		shadowHost,
		messageHandler,
	};

	// Auto-hide after 30 seconds if user doesn't interact
	setTimeout(() => {
		if (activeSavePrompt && activeSavePrompt.shadowHost === shadowHost) {
			hideSavePrompt();
		}
	}, 30000);
}

// Hide save prompt
function hideSavePrompt() {
	if (activeSavePrompt) {
		clearPendingSavePrompt();

		// Fade out
		activeSavePrompt.shadowHost.style.opacity = "0";
		activeSavePrompt.shadowHost.style.transform = "translateY(-8px)";

		// Remove after animation
		setTimeout(() => {
			if (activeSavePrompt) {
				activeSavePrompt.shadowHost.remove();
				window.removeEventListener("message", activeSavePrompt.messageHandler);
				activeSavePrompt = null;
			}
		}, 200);
	}
}

// Handle save credential request
async function handleSaveCredential(
	data: { vaultId: string; username: string; password: string; url: string },
	iframe: HTMLIFrameElement,
) {
	try {
		// Send save request to background script
		const response = await chrome.runtime.sendMessage({
			type: "SAVE_NEW_CREDENTIAL",
			payload: {
				vaultId: data.vaultId,
				username: data.username,
				password: data.password,
				url: data.url,
			},
		});

		// Send result back to iframe
		iframe.contentWindow?.postMessage(
			{
				type: "SAVE_RESULT",
				success: response.success,
				error: response.error,
				errorType: response.errorType,
			},
			"*",
		);

		// If successful, hide prompt after brief delay (handled by iframe)
		if (response.success) {
			console.log("Credentials saved successfully");
		} else {
			console.error("Failed to save credentials:", response.error);
		}
	} catch (error) {
		console.error("Error saving credentials:", error);
		// Send error to iframe
		iframe.contentWindow?.postMessage(
			{
				type: "SAVE_RESULT",
				success: false,
				error:
					error instanceof Error
						? error.message
						: "An unexpected error occurred. Please try again.",
				errorType: "exception",
			},
			"*",
		);
	}
}

// Handle update credential request
async function handleUpdateCredential(
	data: {
		itemId: string;
		vaultId: string;
		username: string;
		password: string;
		url: string;
	},
	iframe: HTMLIFrameElement,
) {
	try {
		// Send update request to background script
		const response = await chrome.runtime.sendMessage({
			type: "UPDATE_EXISTING_CREDENTIAL",
			payload: {
				itemId: data.itemId,
				vaultId: data.vaultId,
				username: data.username,
				password: data.password,
				url: data.url,
			},
		});

		// Send result back to iframe
		iframe.contentWindow?.postMessage(
			{
				type: "SAVE_RESULT",
				success: response.success,
				error: response.error,
				errorType: response.errorType,
			},
			"*",
		);

		// If successful, hide prompt after brief delay (handled by iframe)
		if (response.success) {
			console.log("Credentials updated successfully");
		} else {
			console.error("Failed to update credentials:", response.error);
		}
	} catch (error) {
		console.error("Error updating credentials:", error);
		// Send error to iframe
		iframe.contentWindow?.postMessage(
			{
				type: "SAVE_RESULT",
				success: false,
				error:
					error instanceof Error
						? error.message
						: "An unexpected error occurred. Please try again.",
				errorType: "exception",
			},
			"*",
		);
	}
}

// ==================== End Save Prompt ====================

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
interface AutofillItem {
	id: string;
	name: string;
	title: string;
	username?: string;
	password?: string;
	websiteUrl?: string;
}

function showAutofillOverlay(field: CredentialField, items: AutofillItem[]) {
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
	shadowHost.style.transition =
		"opacity 0.15s ease-out, transform 0.15s ease-out";
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
async function handleAutofillSelect(
	field: CredentialField,
	item: AutofillItem,
) {
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
				}
				if (!usernameField) {
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
	shadowHost.style.transition =
		"opacity 0.15s ease-out, transform 0.15s ease-out";
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
	document.addEventListener("DOMContentLoaded", () => {
		detectPasswordFields();
		restorePendingSavePrompt();
	});
} else {
	detectPasswordFields();
	restorePendingSavePrompt();
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
