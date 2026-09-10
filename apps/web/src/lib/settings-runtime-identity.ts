import type { RuntimeSessionSnapshot } from "@bittery/client-runtime/client";
import type { AccountDisplayIdentity } from "@bittery/client-runtime/protocol";

export interface SettingsDeletionTarget {
	readonly runtimeAccountId: string;
	readonly email: string;
}

export interface SettingsDeletionGesture {
	readonly target: SettingsDeletionTarget;
}

export type SettingsDeletionGestureEvent =
	| { readonly type: "started"; readonly target: SettingsDeletionTarget }
	| { readonly type: "incompleteDismissed" }
	| { readonly type: "canceled" }
	| { readonly type: "terminal" };

/** The validated Runtime identity for the active Account, when one is publishable. */
export function activeRuntimeAccountDisplayIdentity(
	session: RuntimeSessionSnapshot,
): AccountDisplayIdentity | null {
	if (session.accountId === null) return null;
	return (
		session.accounts.find((account) => account.accountId === session.accountId)
			?.displayIdentity ?? null
	);
}

/** Bind one destructive gesture to the Account that began it until it settles. */
export function advanceSettingsDeletionGesture(
	gesture: SettingsDeletionGesture | null,
	event: SettingsDeletionGestureEvent,
): SettingsDeletionGesture | null {
	switch (event.type) {
		case "started":
			return gesture ?? { target: event.target };
		case "incompleteDismissed":
			return gesture;
		case "canceled":
		case "terminal":
			return null;
	}
}

/** The active Runtime Account id and the display identity validated for that id. */
export function activeRuntimeAccountDeletionTarget(
	session: RuntimeSessionSnapshot,
): SettingsDeletionTarget | null {
	if (session.accountId === null) return null;
	const identity = activeRuntimeAccountDisplayIdentity(session);
	return identity === null
		? null
		: { runtimeAccountId: session.accountId, email: identity.email };
}
