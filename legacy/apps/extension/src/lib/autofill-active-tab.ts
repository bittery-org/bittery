import type { DecryptedItem } from "@bittery/shared/types";

/**
 * Ask the content script on the active tab to fill the given credential item.
 *
 * The popup already holds the decrypted item (same as the autofill overlay
 * flow), so it is forwarded directly to the tab. Resolves `true` when the
 * content script reports that at least one field was populated.
 */
export async function fillItemIntoActiveTab(
	item: DecryptedItem,
): Promise<boolean> {
	const tabId = await new Promise<number | null>((resolve) => {
		chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
			resolve(tabs[0]?.id ?? null);
		});
	});

	if (tabId == null) return false;

	return await new Promise<boolean>((resolve) => {
		try {
			chrome.tabs.sendMessage(
				tabId,
				{ type: "FILL_ITEM", payload: { item } },
				(response: { success?: boolean; filled?: boolean } | undefined) => {
					// A missing content script surfaces as chrome.runtime.lastError.
					if (chrome.runtime.lastError) {
						resolve(false);
						return;
					}
					resolve(Boolean(response?.success && response?.filled));
				},
			);
		} catch {
			resolve(false);
		}
	});
}
