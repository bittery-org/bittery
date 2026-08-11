import {
	detectFieldType,
	getAllInputs,
	isFieldVisible,
} from "../lib/field-detection";
import { showSavePrompt } from "./save-prompt";
import { contentState, FORM_SUBMISSION_DEBOUNCE_MS } from "./state";
import type {
	CapturedCredentials,
	CredentialField,
	PendingRequest,
} from "./types";

const recentFormSubmissions = new WeakMap<HTMLFormElement, number>();
const pendingAjaxRequests = new Map<string, PendingRequest>();

let lastInteractedForm: HTMLFormElement | null = null;
let lastInteractionTime = 0;
let ajaxDetectionPatched = false;

// Attach form submission listeners
export function attachFormSubmitListeners(form: HTMLFormElement) {
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
function captureCredentials(
	form?: HTMLFormElement,
): CapturedCredentials | null {
	// Determine the scope to search for fields
	const searchScope = form || document;

	// Find password field - prioritize detected fields, then search the form/document
	let passwordField: HTMLInputElement | undefined;
	let passwordValue = "";

	// First, check our detected fields for password fields in this form
	// Sort by confidence if available
	const passwordCandidates: Array<{
		input: HTMLInputElement;
		field: CredentialField;
	}> = [];

	for (const [input, field] of contentState.detectedFields) {
		if (field.type === "password" && input.value) {
			// If we have a form, ensure the field is within this form
			if (!form || input.closest("form") === form) {
				passwordCandidates.push({ input, field });
			}
		}
	}

	// Sort by confidence and visibility
	if (passwordCandidates.length > 0) {
		passwordCandidates.sort((a, b) => {
			// Prefer visible fields
			const aVisible = isFieldVisible(a.input);
			const bVisible = isFieldVisible(b.input);
			if (aVisible && !bVisible) return -1;
			if (!aVisible && bVisible) return 1;
			// Then by confidence
			return (b.field.confidence || 0) - (a.field.confidence || 0);
		});
		const firstCandidate = passwordCandidates[0];
		if (firstCandidate) {
			passwordField = firstCandidate.input;
			passwordValue = passwordField.value;
		}
	}

	// Fallback: search for password fields in the scope (including Shadow DOM)
	if (!passwordField) {
		const allInputs = getAllInputs(
			searchScope instanceof Document ? searchScope : document,
		);
		const passwordFields = allInputs
			.filter(({ input }) => input.type === "password" && input.value)
			.filter(
				({ input }) =>
					!form || input.closest("form") === form || !input.closest("form"),
			);

		if (passwordFields.length > 0) {
			// Prefer visible fields
			const visibleField = passwordFields.find(({ input }) =>
				isFieldVisible(input),
			);
			const firstPasswordField = passwordFields[0];
			passwordField = visibleField?.input || firstPasswordField?.input;
			passwordValue = passwordField?.value || "";
		}
	}

	// If no password found, we can't capture credentials
	if (!passwordValue || !passwordField) {
		return null;
	}

	// Find username/email field
	let usernameField: HTMLInputElement | undefined;
	let usernameValue = "";

	// First, check our detected fields for username/email fields in this form
	// Sort by confidence if available
	const usernameCandidates: Array<{
		input: HTMLInputElement;
		field: CredentialField;
	}> = [];

	for (const [input, field] of contentState.detectedFields) {
		if ((field.type === "username" || field.type === "email") && input.value) {
			// If we have a form, ensure the field is within this form
			if (!form || input.closest("form") === form) {
				usernameCandidates.push({ input, field });
			}
		}
	}

	// Sort by confidence and visibility
	if (usernameCandidates.length > 0) {
		usernameCandidates.sort((a, b) => {
			// Prefer visible fields
			const aVisible = isFieldVisible(a.input);
			const bVisible = isFieldVisible(b.input);
			if (aVisible && !bVisible) return -1;
			if (!aVisible && bVisible) return 1;
			// Then by confidence
			return (b.field.confidence || 0) - (a.field.confidence || 0);
		});
		const firstUsernameCandidate = usernameCandidates[0];
		if (firstUsernameCandidate) {
			usernameField = firstUsernameCandidate.input;
			usernameValue = usernameField.value;
		}
	}

	// Fallback: search for username/email fields in the scope (including Shadow DOM)
	if (!usernameField) {
		const allInputs = getAllInputs(
			searchScope instanceof Document ? searchScope : document,
		);

		const candidateFields = allInputs.filter(({ input }) => {
			// Exclude password fields and empty fields
			if (input.type === "password" || !input.value) return false;

			// If we have a form, ensure the field is within this form
			if (form && input.closest("form") !== form && input.closest("form")) {
				return false;
			}

			// Use enhanced field type detection
			const { type, confidence } = detectFieldType(input);

			// Check if it looks like a username/email field with sufficient confidence
			if ((type === "username" || type === "email") && confidence >= 0.2) {
				return true;
			}

			return false;
		});

		if (candidateFields.length > 0) {
			// Prefer visible fields
			const visibleField = candidateFields.find(({ input }) =>
				isFieldVisible(input),
			);
			const firstCandidateField = candidateFields[0];
			usernameField = visibleField?.input || firstCandidateField?.input;
			usernameValue = usernameField?.value || "";
		}
	}

	// If no username found, we might still want to capture just the password
	// but for login forms, username is typically required
	if (!usernameValue) {
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
	// Check if we recently processed this form (debounce to prevent duplicates)
	const now = Date.now();
	const lastSubmission = recentFormSubmissions.get(form);

	if (lastSubmission && now - lastSubmission < FORM_SUBMISSION_DEBOUNCE_MS) {
		return;
	}

	// Mark this form as recently submitted
	recentFormSubmissions.set(form, now);

	// Capture credentials from the form
	const credentials = captureCredentials(form);

	if (credentials) {
		// Check if credentials should be saved
		const { shouldSave } = await shouldSaveCredentials(credentials);

		if (shouldSave) {
			// Show save prompt to user
			showSavePrompt(credentials);
		}
	}
}

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
				for (const key of body.keys()) {
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
		// Treat this like a form submission
		if (form) {
			handleFormSubmit(null, form);
		} else {
			// If no form is associated, try to find password fields on the page
			// This will be useful for custom login implementations
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
	// Try to capture credentials from the page (without a specific form)
	const credentials = captureCredentials();

	if (credentials) {
		// Check if credentials should be saved
		const { shouldSave } = await shouldSaveCredentials(credentials);

		if (shouldSave) {
			// Show save prompt to user
			showSavePrompt(credentials);
		}
	}
}

export function setupAjaxDetection() {
	if (ajaxDetectionPatched) return;
	ajaxDetectionPatched = true;

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
}
