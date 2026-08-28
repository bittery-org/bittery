import type { RuntimeSessionSnapshot } from "@bittery/client-runtime/client";
import type { AccountDisplayIdentity } from "@bittery/client-runtime/protocol";

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
