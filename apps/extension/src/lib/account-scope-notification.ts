import { sendMessage } from "./messaging";

type ScopeNotifier = () => Promise<unknown>;

/** Notify the worker without making its availability part of a local account switch. */
export function notifyWorkerAccountScopeChanged(
	notify: ScopeNotifier = () =>
		sendMessage({ type: "RECONCILE_ACCOUNT_SCOPE" }),
	logger: Pick<Console, "warn"> = console,
): void {
	void notify().catch((error) => {
		logger.warn(
			"[Popup Vault runtime] Worker account-scope reconciliation deferred:",
			error,
		);
	});
}
