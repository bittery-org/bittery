import type {
	Acknowledgement,
	PendingSavePrompt,
	PendingSavePromptResponse,
} from "./router/contract";

const PENDING_SAVE_PROMPT_KEY = "bittery_pending_save_prompt";

function getStorageArea(): chrome.storage.StorageArea {
	return chrome.storage.session ?? chrome.storage.local;
}

export async function handleSetPendingSavePrompt(
	payload: PendingSavePrompt,
): Promise<Acknowledgement> {
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

export async function handleGetPendingSavePrompt(): Promise<PendingSavePromptResponse> {
	const result = await getStorageArea().get(PENDING_SAVE_PROMPT_KEY);

	return {
		success: true,
		data:
			(result[PENDING_SAVE_PROMPT_KEY] as PendingSavePrompt | undefined) ??
			null,
	};
}

export async function handleClearPendingSavePrompt(): Promise<Acknowledgement> {
	await getStorageArea().remove(PENDING_SAVE_PROMPT_KEY);

	return { success: true };
}
