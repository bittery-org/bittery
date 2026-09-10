import type { ShareLinkSummary } from "@bittery/client-runtime/protocol";
import { useRuntimeClient } from "@bittery/client-runtime/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { observeAccountDeparture } from "@/lib/runtime-account-presentation";

interface HistoryScope {
	accountId: string;
	itemId: string;
	controller: AbortController;
}

/** Foreground history belongs to the open Item; Runtime owns authenticated requests. */
export function useRuntimeShareHistory(
	accountId: string | null,
	itemId: string | null,
	open: boolean,
) {
	const runtime = useRuntimeClient();
	const current = useRef<HistoryScope | null>(null);
	const [view, setView] = useState<{
		scope: HistoryScope;
		links: readonly ShareLinkSummary[];
		loading: boolean;
		failed: boolean;
	} | null>(null);
	const refresh = useCallback(
		async (scope: HistoryScope) => {
			scope.controller.signal.throwIfAborted();
			setView({ scope, links: [], loading: true, failed: false });
			try {
				const result = await runtime.listItemShareLinks(
					{ accountId: scope.accountId, itemId: scope.itemId },
					{ signal: scope.controller.signal },
				);
				scope.controller.signal.throwIfAborted();
				setView({ scope, links: result.links, loading: false, failed: false });
			} catch (error) {
				if (!scope.controller.signal.aborted)
					setView({ scope, links: [], loading: false, failed: true });
				throw error;
			}
		},
		[runtime],
	);
	useEffect(() => {
		if (!open || !accountId || !itemId) {
			setView(null);
			return;
		}
		const scope: HistoryScope = {
			accountId,
			itemId,
			controller: new AbortController(),
		};
		current.current = scope;
		const release = observeAccountDeparture(runtime, accountId, () => {
			scope.controller.abort();
			if (current.current === scope) {
				current.current = null;
				setView(null);
			}
		});
		void refresh(scope).catch(() => {});
		return () => {
			scope.controller.abort();
			release();
			if (current.current === scope) current.current = null;
		};
	}, [runtime, accountId, itemId, open, refresh]);
	const requireScope = useCallback(() => {
		const scope = current.current;
		if (
			!scope ||
			scope.accountId !== accountId ||
			scope.itemId !== itemId ||
			!open
		)
			throw new DOMException(
				"Share history presentation detached",
				"AbortError",
			);
		scope.controller.signal.throwIfAborted();
		return scope;
	}, [accountId, itemId, open]);
	const revoke = useCallback(
		async (linkId: string) => {
			const scope = requireScope();
			await runtime.revokeShareLink(
				{ accountId: scope.accountId, linkId },
				{ signal: scope.controller.signal },
			);
			scope.controller.signal.throwIfAborted();
			await refresh(scope);
		},
		[runtime, requireScope, refresh],
	);
	const loadAccessLogs = useCallback(
		async (linkId: string) => {
			const scope = requireScope();
			const result = await runtime.listShareAccessLogs(
				{ accountId: scope.accountId, linkId },
				{ signal: scope.controller.signal },
			);
			scope.controller.signal.throwIfAborted();
			return result.logs;
		},
		[runtime, requireScope],
	);
	const visible =
		open &&
		view?.scope === current.current &&
		view.scope.accountId === accountId &&
		view.scope.itemId === itemId &&
		!view.scope.controller.signal.aborted
			? view
			: null;
	return {
		links: visible?.links ?? [],
		isLoading: visible?.loading ?? false,
		failed: visible?.failed ?? false,
		revoke,
		loadAccessLogs,
		retry: () => {
			void refresh(requireScope()).catch(() => {});
		},
	};
}
