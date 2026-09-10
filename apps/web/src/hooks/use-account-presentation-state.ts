import { useRuntimeClient } from "@bittery/client-runtime/react";
import { useCallback, useEffect, useRef, useState } from "react";

/** Transient UI selection: any observed Account departure retires it permanently. */
export function useAccountPresentationState<T>(accountId: string | null) {
	const runtime = useRuntimeClient();
	const current = useRef<{ accountId: string; value: T } | null>(null);
	const [selection, setSelection] = useState(current.current);
	const clear = useCallback(() => {
		current.current = null;
		setSelection(null);
	}, []);
	const read = useCallback(() => {
		const session = runtime.session().getSnapshot();
		const selected = current.current;
		return selected &&
			session.state === "unlocked" &&
			session.accountId === selected.accountId
			? selected.value
			: null;
	}, [runtime]);
	useEffect(() => {
		const inspect = () => {
			if (current.current && read() === null) clear();
		};
		const release = runtime.session().subscribe(inspect);
		inspect();
		return release;
	}, [runtime, read, clear]);
	const set = useCallback(
		(value: T | null) => {
			const session = runtime.session().getSnapshot();
			if (
				value === null ||
				!accountId ||
				session.state !== "unlocked" ||
				session.accountId !== accountId
			)
				return clear();
			current.current = { accountId, value };
			setSelection(current.current);
		},
		[runtime, accountId, clear],
	);
	return [
		selection?.accountId === accountId ? read() : null,
		set,
		read,
	] as const;
}
