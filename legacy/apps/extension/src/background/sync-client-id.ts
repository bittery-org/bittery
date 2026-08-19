/**
 * Sync client id, shared by the SSE stream and the outbound queue so both
 * halves of sync speak as the same client. Kept out of `sync-manager` so the
 * queue drain can read it without importing the connection machinery back.
 */

const CLIENT_ID_KEY = "bittery_sync_client_id";

function generateId(length = 8): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	let result = "";
	const randomValues = new Uint8Array(length);
	crypto.getRandomValues(randomValues);
	for (let i = 0; i < length; i++) {
		const randomVal = randomValues[i] ?? 0;
		result += chars[randomVal % chars.length];
	}
	return result;
}

export async function getOrCreateSyncClientId(): Promise<string> {
	const result = await chrome.storage.local.get(CLIENT_ID_KEY);
	const existing = result[CLIENT_ID_KEY];
	if (typeof existing === "string" && existing.length > 0) {
		return existing;
	}

	const clientId = `ext_${Date.now()}_${generateId(8)}`;
	await chrome.storage.local.set({ [CLIENT_ID_KEY]: clientId });
	return clientId;
}
