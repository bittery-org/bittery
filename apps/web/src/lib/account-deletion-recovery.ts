import {
	type AccountDeletionMarker,
	type DeleteAccountEverywhereDeps,
	deleteAccountEverywhere,
} from "./account-deletion";
import {
	type AccountRemovalDeps,
	removeAccountFromDevice,
} from "./account-removal";
import { normalizeAccountEmail, runtimeClient } from "./crypto";
import {
	clearActiveAccountData,
	forgetWebAccountId,
	readAccountDeletionMarker,
	writeAccountDeletionMarker,
} from "./storage";

let recovery: Promise<void> | null = null;

/** Resolves definitive retained outcomes without making the router wait for another reload. */
export async function recoverRetainedAccountDeletionAtStartup(
	marker: AccountDeletionMarker,
	deps: DeleteAccountEverywhereDeps,
): Promise<void> {
	const result = await deleteAccountEverywhere(marker.confirmEmail, deps);
	if (result.status === "deleted") return;
	try {
		if (deps.readMarker() === null) return;
	} catch {
		// An unreadable marker cannot prove that exact retry authority was consumed.
	}
	throw new Error("Account deletion recovery remains incomplete.");
}

/** Runs durable post-dispatch recovery before any route can refresh Runtime authentication. */
export function recoverAccountDeletionAtStartup(): Promise<void> {
	if (typeof window === "undefined") return Promise.resolve();
	const marker = readAccountDeletionMarker();
	if (marker === null || marker.phase === "prepared") return Promise.resolve();
	recovery ??= (async () => {
		const removal: AccountRemovalDeps = {
			resolveRuntimeAccountId: () => marker.runtimeAccountId,
			resolveTransitionalAccountId: async () => marker.transitionalAccountId,
			removeAccount: (accountId) => runtimeClient.removeAccount(accountId),
			selectAccount: (accountId) => runtimeClient.selectAccount(accountId),
			clearTransitionalAccountData: (accountId) =>
				clearActiveAccountData(accountId),
			forgetTransitionalAccountId: forgetWebAccountId,
			clearAccountDeletionMarker: () => writeAccountDeletionMarker(null),
		};
		const deps: DeleteAccountEverywhereDeps = {
			resolveTarget: async () => marker,
			readMarker: readAccountDeletionMarker,
			writeMarker: writeAccountDeletionMarker,
			createRequestId: () => marker.requestId,
			normalizeAccountEmail,
			deleteServerAccount: (input) => runtimeClient.deleteServerAccount(input),
			removeLocalAccount: () => removeAccountFromDevice(null, removal),
		};
		await recoverRetainedAccountDeletionAtStartup(marker, deps);
	})().finally(() => {
		recovery = null;
	});
	return recovery;
}
