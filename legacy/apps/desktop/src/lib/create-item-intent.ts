import { listen } from "@tauri-apps/api/event";

/**
 * Bridge for "open-create-item" / "open-item" intents coming from the browser
 * extension via native messaging. Intents are held in a module store (instead
 * of being handled directly by the vault route) so they survive arriving while
 * the app is locked — the vault route reads them once it mounts after unlock.
 */

export interface CreateItemIntent {
	url?: string;
}

export interface ViewItemIntent {
	vaultId: string;
	itemId: string;
}

let current: CreateItemIntent | null = null;
const listeners = new Set<() => void>();

function notify() {
	for (const listener of listeners) {
		listener();
	}
}

export function subscribeCreateItemIntent(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function getCreateItemIntent(): CreateItemIntent | null {
	return current;
}

export function clearCreateItemIntent() {
	if (current === null) {
		return;
	}
	current = null;
	notify();
}

let pendingViewItem: ViewItemIntent | null = null;

/** One-shot: the vault route's beforeLoad consumes this and redirects to the item. */
export function consumeViewItemIntent(): ViewItemIntent | null {
	const intent = pendingViewItem;
	pendingViewItem = null;
	return intent;
}

/** Non-consuming read, for picking the navigation target when an intent fires. */
export function peekViewItemIntent(): ViewItemIntent | null {
	return pendingViewItem;
}

/**
 * Registered once at app startup (main.tsx). `onIntent` should bring the
 * vault route on screen; if the app is locked its beforeLoad redirects to
 * unlock and the stashed intent is picked up once the vault mounts.
 */
export async function initCreateItemIntentBridge(onIntent: () => void) {
	await listen<{ url?: string | null }>("open-create-item", (event) => {
		current = { url: event.payload?.url ?? undefined };
		notify();
		onIntent();
	});
	await listen<{ itemId?: string | null; vaultId?: string | null }>(
		"open-item",
		(event) => {
			const itemId = event.payload?.itemId;
			const vaultId = event.payload?.vaultId;
			if (!itemId || !vaultId) {
				return;
			}
			pendingViewItem = { itemId, vaultId };
			onIntent();
		},
	);
}
