import { type BackgroundEvent, isBackgroundEvent } from "../background/events";

export interface PopupAccountRuntimeReconciler {
	reconcileFromStorage(): Promise<void>;
}

const ACCOUNT_STATE_EVENTS: ReadonlySet<BackgroundEvent["type"]> = new Set([
	"ACTIVE_ACCOUNT_CHANGED",
	"DESKTOP_UNLOCKED",
	"DESKTOP_LOCKED",
	"VAULT_LOCKED",
	"SESSION_REVOKED",
]);

/** The popup's sole bridge from worker account events into its local Vault runtime. */
export function createPopupAccountRuntimeBridge(
	runtime: PopupAccountRuntimeReconciler,
) {
	let reconciliation: Promise<void> | null = null;
	let reconcileAgain = false;

	const reconcile = (): Promise<void> => {
		if (reconciliation) {
			reconcileAgain = true;
			return reconciliation;
		}
		const run = async (): Promise<void> => {
			do {
				reconcileAgain = false;
				await runtime.reconcileFromStorage();
			} while (reconcileAgain);
		};
		reconciliation = run().finally(() => {
			reconciliation = null;
		});
		return reconciliation;
	};

	return {
		reconcile,
		handleBackgroundEvent(event: BackgroundEvent): Promise<void> | undefined {
			return ACCOUNT_STATE_EVENTS.has(event.type) ? reconcile() : undefined;
		},
	};
}

export function subscribePopupAccountRuntime(
	runtime: PopupAccountRuntimeReconciler,
): void {
	const bridge = createPopupAccountRuntimeBridge(runtime);
	chrome.runtime.onMessage.addListener((message: unknown) => {
		if (!isBackgroundEvent(message)) return;
		void bridge.handleBackgroundEvent(message)?.catch((error) => {
			console.error(
				"[Popup Vault runtime] Failed to reconcile worker account state:",
				error,
			);
		});
	});
}
