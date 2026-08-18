import { createMobileAutolockService } from "@bittery/core/hooks/services/autolock-mobile";
import type { LifecycleOutcome } from "@bittery/core/services/account-lifecycle";
import type { AccountSessionManager } from "@bittery/core/services/account-session-manager";
import type { AccountVaultRuntime } from "@bittery/core/services/account-vault-runtime";
import type { IAutolockService } from "@bittery/core/services/autolock";
import { ClientRuntime } from "@bittery/core/services/client-runtime";
import type { QueryClient } from "@tanstack/react-query";
import type { Router } from "@tanstack/react-router";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useSyncExternalStore,
} from "react";
import { lifecycleDeps } from "@/lib/lifecycle";
import { type AccountMetadata, itemCache, storage } from "@/lib/storage";
import { vaultRepository } from "@/lib/vault-runtime";

interface AccountContextValue {
	activeAccount: AccountMetadata | null;
	allAccounts: AccountMetadata[];
	switchAccount: (accountId: string) => Promise<void>;
	addAccount: (account: AccountMetadata) => Promise<void>;
	removeAccount: (accountId: string) => Promise<LifecycleOutcome>;
	lockAccount: (accountId: string) => Promise<void>;
	lockAllAccounts: () => Promise<void>;
	refreshAccounts: () => Promise<void>;
	isLoading: boolean;
}

const AccountContext = createContext<AccountContextValue | null>(null);
const AccountRuntimeContext = createContext<{
	manager: AccountSessionManager;
	vaultRuntime: AccountVaultRuntime;
} | null>(null);

export function createMobileClientRuntime(
	queryClient: QueryClient,
): ClientRuntime {
	return new ClientRuntime({
		storage,
		// Sibling of `storage`: `removeAccount` has to wipe the account's cached ciphertext,
		// and `AccountStore` cannot reach it (packages/storage/CONTEXT.md §4.2).
		itemCache,
		vaultRepository,
		credentialMirror: lifecycleDeps.credentialMirror,
		// No `onActiveChanged` / `onLockBroadcast`: those exist on desktop so it can tell the
		// Chrome extension about active-account switches and lock events over native
		// messaging. Mobile has no extension and nothing listening for that broadcast, so
		// there is nothing to wire here — omitting the callbacks is the correct behaviour,
		// not a gap.
		invalidateQueries: async (keys) => {
			await Promise.all(
				keys.map((key) => queryClient.invalidateQueries({ queryKey: key })),
			);
		},
	});
}

export function AccountProvider({
	children,
	router,
	runtime,
}: {
	children: ReactNode;
	router: Router<any, any>;
	runtime: ClientRuntime;
}) {
	const manager = runtime.accounts;
	const vaultRuntime = runtime.vaultRuntime;

	const autolockService = useRef<IAutolockService | null>(null);

	useSyncExternalStore(manager.subscribe, manager.getSnapshot);

	useEffect(() => {
		runtime.start();
		return () => runtime.dispose();
	}, [runtime]);

	const allAccounts = manager.getAccounts();
	const activeAccount = manager.getActiveAccountMetadata();
	const isLoading = !manager.isInitialized();

	const refreshAccounts = useCallback(async () => {
		await manager.refresh();
	}, [manager]);

	const switchAccount = useCallback(
		async (accountId: string) => {
			await manager.switchAccount(accountId);
		},
		[manager],
	);

	const addAccount = useCallback(
		async (account: AccountMetadata) => {
			await manager.addAccount(account);
		},
		[manager],
	);

	const removeAccount = useCallback(
		// The outcome is the caller's only complete view of what happened, so it is
		// returned rather than dropped — nothing re-reads storage after a removal.
		async (accountId: string) => manager.removeAccount(accountId),
		[manager],
	);

	const lockAccount = useCallback(
		async (accountId: string) => {
			await manager.lockAccount(accountId);
		},
		[manager],
	);

	const lockAllAccounts = useCallback(async () => {
		await manager.lockAll();
		console.log("[AccountContext] All accounts locked");
	}, [manager]);

	useEffect(() => {
		const service = createMobileAutolockService({ storage });
		autolockService.current = service;
		service.initialize();

		// `createMobileAutolockService().initialize()` subscribes to React Native's
		// `AppState` through `globalThis.require("react-native")`. There is no such
		// `require` in a Tauri WebView, so the lookup throws into the service's own
		// `catch` and it ends up with no app-state source at all — idle auto-lock simply
		// never fires. The service's public surface is enough to drive it from outside:
		// `shouldLock()` and `lock()` are exported, and the background timestamp it reads
		// is plain `AccountStore` state, so this listener replays exactly what
		// `handleAppStateChange` does with `"background"`/`"active"`, reading
		// `document.visibilityState` instead. `packages/core` stays untouched.
		let visibilityInFlight: Promise<void> = Promise.resolve();
		const handleVisibilityChange = () => {
			// Serialised: a fast hide/show pair must not race the timestamp write against
			// the read that decides whether to lock.
			visibilityInFlight = visibilityInFlight.then(async () => {
				const accountId = (await storage.getActiveAccount()) ?? undefined;
				if (document.visibilityState === "hidden") {
					await storage.storeBackgroundTimestamp(accountId);
					return;
				}
				if (await service.shouldLock()) {
					await service.lock();
				}
				await storage.clearBackgroundTimestamp(accountId);
			});
			void visibilityInFlight.catch((error) => {
				console.warn(
					"[AccountContext] Autolock visibility handling failed",
					error,
				);
				visibilityInFlight = Promise.resolve();
			});
		};
		document.addEventListener("visibilitychange", handleVisibilityChange);

		const unsubscribe = service.onLock(() => {
			console.log("[AccountContext] Autolock triggered, navigating to unlock");
			// Unlike desktop's autolock service, which takes `lockAllAccounts` as a
			// constructor callback and runs it before notifying `onLock` subscribers,
			// `createMobileAutolockService` only clears the master unlock key directly
			// in storage — it has no such constructor hook. `manager`'s in-memory lock
			// state (read via `useSyncExternalStore` throughout the app) would go stale
			// unless this subscriber drives it through the same path a manual lock uses.
			void (async () => {
				await lockAllAccounts();
				router.navigate({ to: "/unlock" });
			})();
		});

		return () => {
			document.removeEventListener("visibilitychange", handleVisibilityChange);
			unsubscribe?.();
			service.dispose();
			autolockService.current = null;
		};
	}, [lockAllAccounts, router]);

	// No `trigger-biometric-unlock` event listener here: that event is raised by the
	// desktop native-messaging bridge when the Chrome extension asks the desktop app to
	// prompt biometric unlock. Mobile has no extension to raise it.

	return (
		<AccountRuntimeContext.Provider value={{ manager, vaultRuntime }}>
			<AccountContext.Provider
				value={{
					activeAccount,
					allAccounts,
					switchAccount,
					addAccount,
					removeAccount,
					lockAccount,
					lockAllAccounts,
					refreshAccounts,
					isLoading,
				}}
			>
				{children}
			</AccountContext.Provider>
		</AccountRuntimeContext.Provider>
	);
}

export function useMobileAccountRuntime() {
	const value = useContext(AccountRuntimeContext);
	if (!value) throw new Error("AccountProvider must own the mobile runtime");
	return value;
}

export function useAccount(): AccountContextValue {
	const context = useContext(AccountContext);
	if (!context) {
		throw new Error("useAccount must be used within an AccountProvider");
	}
	return context;
}

export function useOptionalAccount(): AccountContextValue | null {
	return useContext(AccountContext);
}
