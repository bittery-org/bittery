import { type BackgroundEvent, isBackgroundEvent } from "../background/events";
import { popupAccountVaultRuntime } from "./popup-account-vault-runtime";

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

export const popupAccountRuntimeBridge = createPopupAccountRuntimeBridge(
	popupAccountVaultRuntime,
);

/**
 * Registered at module scope so an account event arriving while React mounts is
 * still reconciled before any popup read hook can depend on its scope.
 */
if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
	chrome.runtime.onMessage.addListener((message: unknown) => {
		if (!isBackgroundEvent(message)) return;
		const reconciliation =
			popupAccountRuntimeBridge.handleBackgroundEvent(message);
		if (reconciliation) {
			void reconciliation.catch((error) => {
				console.error(
					"[Popup Vault runtime] Failed to reconcile worker account state:",
					error,
				);
			});
		}
	});
}
