import type { ActiveSavePrompt, CapturedCredentials } from "./types";

let activeSavePrompt: ActiveSavePrompt | null = null;

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

export async function restorePendingSavePrompt() {
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
export async function showSavePrompt(
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
	let hasChanges = true; // Default to true (show prompt if check fails)
	try {
		const duplicateCheckResponse = await chrome.runtime.sendMessage({
			type: "CHECK_EXISTING_CREDENTIALS",
			payload: {
				url: credentials.url,
				username: credentials.username,
				password: credentials.password, // Pass password to check for changes
			},
		});

		if (duplicateCheckResponse.success) {
			existingCredentials = duplicateCheckResponse.existingCredentials || [];
			hasDuplicates = duplicateCheckResponse.hasDuplicates || false;
			hasChanges = duplicateCheckResponse.hasChanges ?? true; // Use ?? to handle undefined
		}
	} catch (error) {
		console.error("Error checking for existing credentials:", error);
		// Continue with empty array - if check fails, we'll treat as no duplicates
	}

	// Only show the prompt if credentials are new or have changed (like 1Password)
	if (!hasChanges) {
		return;
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
		// Ignore messages not from our iframe
		if (!event.data?.type) return;

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
export function hideSavePrompt() {
	if (!activeSavePrompt) {
		return;
	}

	clearPendingSavePrompt();

	// Store reference to current prompt before clearing
	const promptToRemove = activeSavePrompt;

	// Clear the active prompt reference immediately to prevent duplicate closes
	activeSavePrompt = null;

	// Fade out
	promptToRemove.shadowHost.style.opacity = "0";
	promptToRemove.shadowHost.style.transform = "translateY(-8px)";

	// Remove after animation
	setTimeout(() => {
		try {
			promptToRemove.shadowHost.remove();
			window.removeEventListener("message", promptToRemove.messageHandler);
		} catch (error) {
			console.error("Error removing save prompt:", error);
		}
	}, 200);
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
		if (!response.success) {
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
		if (!response.success) {
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
