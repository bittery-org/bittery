/**
 * The React entrypoint. It holds one subscription primitive and no lifecycle of its own:
 * no `useEffect`, no timers, no ownership of durable work. Component lifetime decides what
 * is rendered, never what the Runtime is doing.
 */

export {
	RuntimeProvider,
	type RuntimeProviderProps,
	useRuntimeClient,
} from "./context";
export {
	useCreateItem,
	useRuntimeItems,
	useRuntimeLock,
	useRuntimePendingShareResults,
	useRuntimeQuickUnlock,
	useRuntimeSession,
	useRuntimeSignIn,
	useRuntimeSignOut,
	useRuntimeStatus,
} from "./hooks";
export { useRuntimeStore } from "./use-runtime-store";
