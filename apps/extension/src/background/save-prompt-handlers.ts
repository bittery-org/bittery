import type { MessageResponse } from "./types";

const PENDING_SAVE_PROMPT_KEY = "bittery_pending_save_prompt";

type PendingSavePrompt = {
	username: string;
	password: string;
	url: string;
	hostname: string;
};

function getStorageArea(): chrome.storage.StorageArea {
	return chrome.storage.session ?? chrome.storage.local;
}

export async function handleSetPendingSavePrompt(
	payload: PendingSavePrompt,
): Promise<MessageResponse> {
	const { username, password, url, hostname } = payload;

	if (!username || !password || !url || !hostname) {
		return {
			success: false,
			error: "Missing required fields",
		};
	}

	await getStorageArea().set({
		[PENDING_SAVE_PROMPT_KEY]: {
			username,
			password,
			url,
			hostname,
		},
	});

	return { success: true };
}

export async function handleGetPendingSavePrompt(): Promise<MessageResponse> {
	const result = await getStorageArea().get(PENDING_SAVE_PROMPT_KEY);

	return {
		success: true,
		data:
			(result[PENDING_SAVE_PROMPT_KEY] as PendingSavePrompt | undefined) ??
			null,
	};
}

export async function handleClearPendingSavePrompt(): Promise<MessageResponse> {
	await getStorageArea().remove(PENDING_SAVE_PROMPT_KEY);

	return { success: true };
}
