/**
 * Notify the background worker that an autofill just happened so it can keep
 * the vault unlocked.
 *
 * Best-effort: the service worker may be restarting or the message may fail to
 * route. That must never abort the autofill itself, so failures are swallowed.
 */
export async function updateAutofillTimestamp(): Promise<void> {
	try {
		await chrome.runtime.sendMessage({ type: "UPDATE_AUTOFILL_TIMESTAMP" });
	} catch (error) {
		console.warn("Failed to update autofill timestamp:", error);
	}
}
