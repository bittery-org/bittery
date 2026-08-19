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
import {
	broadcastActiveAccountChanged,
	broadcastLockEvent,
} from "@/lib/tauri-commands";
import { vaultRepository } from "@/lib/vault-runtime";
import { createDesktopAutolockService } from "@/services/autolock-service";

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

export function createDesktopClientRuntime(
	queryClient: QueryClient,
): ClientRuntime {
	return new ClientRuntime({
		storage,
		// Sibling of `storage`: `removeAccount` has to wipe the account's cached ciphertext,
		// and `AccountStore` cannot reach it (packages/storage/CONTEXT.md §4.2).
		itemCache,
		vaultRepository,
		credentialMirror: lifecycleDeps.credentialMirror,
		onActiveChanged: async (active) => {
			if (!active) {
				return;
			}
			try {
				await broadcastActiveAccountChanged({ accountId: active });
			} catch (error) {
				console.error(
					"[AccountContext] Failed to broadcast active account change:",
					error,
				);
			}
		},
		onLockBroadcast: async (reason) => {
			try {
				await broadcastLockEvent({ reason });
			} catch (error) {
				console.error(
					"[AccountContext] Failed to broadcast lock event:",
					error,
				);
			}
		},
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
		autolockService.current = createDesktopAutolockService(
			storage,
			lockAllAccounts,
		);
		autolockService.current.initialize();

		const unsubscribe = autolockService.current.onLock(() => {
			console.log("[AccountContext] Autolock triggered, navigating to unlock");
			router.navigate({ to: "/unlock" });
		});

		return () => {
			unsubscribe?.();
			autolockService.current?.dispose();
		};
	}, [lockAllAccounts, router]);

	useEffect(() => {
		let unlisten: (() => void) | undefined;

		const setupListener = async () => {
			try {
				const { listen } = await import("@tauri-apps/api/event");
				unlisten = await listen("trigger-biometric-unlock", () => {
					console.log(
						"[AccountContext] Received trigger-biometric-unlock event from extension",
					);
					router.navigate({
						to: "/unlock",
						search: {
							autoTrigger: true,
							autoTriggerId: Date.now().toString(),
						},
					});
				});
			} catch (error) {
				console.error(
					"[AccountContext] Failed to setup trigger-biometric-unlock listener:",
					error,
				);
			}
		};

		void setupListener();

		return () => {
			unlisten?.();
		};
	}, [router]);

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

export function useDesktopAccountRuntime() {
	const value = useContext(AccountRuntimeContext);
	if (!value) throw new Error("AccountProvider must own the desktop runtime");
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
