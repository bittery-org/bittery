import type { RuntimeClient } from "@bittery/client-runtime/client";

/** Subscribe directly so React batching cannot hide a transient Lock or Account switch. */
export function observeAccountDeparture(
	runtime: RuntimeClient,
	accountId: string | null,
	retire: () => void,
): () => void {
	const store = runtime.session();
	const check = () => {
		const current = store.getSnapshot();
		if (current.state !== "unlocked" || current.accountId !== accountId)
			retire();
	};
	const release = store.subscribe(check);
	check();
	return release;
}
