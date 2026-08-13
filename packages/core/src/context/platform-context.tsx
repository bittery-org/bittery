/**
 * Platform Context Provider
 *
 * Provides platform-specific dependencies (storage, crypto, sync, autolock) to shared hooks.
 * Each app wraps its root with PlatformProvider, injecting platform-specific implementations.
 */

import type { CryptoPort } from "@bittery/crypto-port";
import type { AccountStore, ItemCache } from "@bittery/storage";
import type {
	IAutolockService,
	IQueryInvalidator,
	ISyncContext,
} from "@bittery/types";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { type CoreContext, createCoreContext } from "../core-context";
import type { CredentialMirror } from "../services/account-lifecycle";
import type { AccountVaultRuntime } from "../services/account-vault-runtime";
import type { VaultCrypto } from "../services/vault-crypto";

/**
 * Platform context value containing all platform-specific dependencies
 */
export interface PlatformContextValue {
	/** Storage adapter instance (already has CryptoProvider injected) */
	storage: AccountStore;

	/**
	 * The encrypted item/vault cache.
	 *
	 * A **sibling** of `storage`, never reachable through it: `AccountStore` sits on a
	 * `PlatformPort` and `ItemCache` on a `RecordPort`, and neither knows about the
	 * other. That layering is deliberate, and it is why every flow that has to drop
	 * both — sign-out, account removal, a fresh login onto a reused accountId — has to
	 * sequence them from up here. Not optional: an app that forgot to supply one would
	 * leave encrypted vault contents on disk after logout.
	 */
	itemCache: ItemCache;

	/** The platform's crypto backend. Every key it hands out is an opaque `KeyRef`. */
	crypto: CryptoPort;

	/** Copies of session credentials held outside AccountStore, if any. */
	credentialMirror: CredentialMirror;

	/** Shared framework-agnostic business logic services */
	core: CoreContext;

	/** Autolock service (optional - may not be available on all platforms) */
	autolock?: IAutolockService;

	/** Sync context with query invalidator (optional - may not be available on all platforms) */
	sync?: ISyncContext;
}

const PlatformContext = createContext<PlatformContextValue | null>(null);

/**
 * Props for PlatformProvider
 */
export interface PlatformProviderProps {
	/** Storage adapter instance */
	storage: AccountStore;

	/** Encrypted item/vault cache — a sibling of `storage`, supplied alongside it. */
	itemCache: ItemCache;

	/**
	 * The platform's crypto backend — one `createXCryptoPort()` per app, built once so
	 * every `KeyRef` in the process comes from the same key table.
	 */
	crypto: CryptoPort;

	/** Platform-owned credential copies that must be purged before a failed unlock locks. */
	credentialMirror: CredentialMirror;

	/** The ceremonies over {@link crypto}, built against the same `storage`. */
	vaultCrypto: VaultCrypto;

	/** The process-local Vault lifetime and projection shared by reads and Sync. */
	vaultRuntime: AccountVaultRuntime;

	/** Autolock service (optional) */
	autolock?: IAutolockService;

	/** Sync context with query invalidator (optional) */
	sync?: ISyncContext;

	/** Child components */
	children: ReactNode;
}

/**
 * Provider component that supplies platform-specific dependencies to shared hooks.
 *
 * Usage:
 * ```tsx
 * // In app's root component
 * import { crypto } from "@/lib/crypto";
 * import { storage } from "@/lib/storage";
 * import { useSyncContext } from "@/providers/sync-provider";
 *
 * function AppPlatformProvider({ children }) {
 *   const syncContext = useSyncContext();
 *
 *   const sync = {
 *     clientId: syncContext.clientId,
 *     isConnected: syncContext.isConnected,
 *     isOnline: syncContext.isOnline,
 *     invalidator: syncContext.invalidator,
 *   };
 *
 *   return (
 *     <PlatformProvider
 *       storage={storage}
 *       crypto={crypto}
 *       sync={sync}
 *     >
 *       {children}
 *     </PlatformProvider>
 *   );
 * }
 * ```
 */
export function PlatformProvider({
	storage,
	itemCache,
	crypto,
	credentialMirror,
	vaultCrypto,
	vaultRuntime,
	autolock,
	sync,
	children,
}: PlatformProviderProps) {
	const core = useMemo(
		() =>
			createCoreContext({
				storage,
				itemCache,
				crypto,
				vaultCrypto,
				vaultRuntime,
				commandQueue: sync?.outboundQueue ?? {
					enqueue: async () => {
						throw new Error("Item mutations require an outbound Sync queue");
					},
				},
			}),
		[
			storage,
			itemCache,
			crypto,
			vaultCrypto,
			vaultRuntime,
			sync?.outboundQueue,
		],
	);

	const value = useMemo(
		() => ({
			storage,
			itemCache,
			crypto,
			credentialMirror,
			core,
			autolock,
			sync,
		}),
		[storage, itemCache, crypto, credentialMirror, core, autolock, sync],
	);

	return (
		<PlatformContext.Provider value={value}>
			{children}
		</PlatformContext.Provider>
	);
}

/**
 * Hook to access the platform context.
 * Must be used within a PlatformProvider.
 *
 * @returns Platform context value containing storage, crypto, core, autolock, and sync
 * @throws Error if used outside PlatformProvider
 */
export function usePlatform(): PlatformContextValue {
	const context = useContext(PlatformContext);
	if (!context) {
		throw new Error("usePlatform must be used within a PlatformProvider");
	}
	return context;
}

/**
 * Hook to access just the storage adapter from platform context.
 * Convenience wrapper around usePlatform().
 */
export function usePlatformStorage(): AccountStore {
	return usePlatform().storage;
}

/**
 * Hook to access just the item cache from platform context.
 *
 * Deliberately a separate hook from {@link usePlatformStorage}: a caller that needs
 * both takes both, so the two seams stay visible at every call site.
 */
export function usePlatformItemCache(): ItemCache {
	return usePlatform().itemCache;
}

/**
 * Hook to access framework-agnostic core services.
 */
export function useCoreContext(): CoreContext {
	return usePlatform().core;
}

/**
 * Hook to access the crypto module from platform context.
 * Convenience wrapper around usePlatform().
 */
export function usePlatformCrypto(): CryptoPort {
	return usePlatform().crypto;
}

/** Credential copies that must be purged before AccountStore is locked. */
export function usePlatformCredentialMirror(): CredentialMirror {
	return usePlatform().credentialMirror;
}

/**
 * Hook to access just the autolock service from platform context.
 * Returns undefined if autolock is not configured.
 * Convenience wrapper around usePlatform().
 */
export function usePlatformAutolock(): IAutolockService | undefined {
	return usePlatform().autolock;
}

/**
 * Hook to access the sync context from platform context.
 * Returns undefined if sync is not configured.
 * Convenience wrapper around usePlatform().
 */
export function usePlatformSync(): ISyncContext | undefined {
	return usePlatform().sync;
}

/**
 * Hook to access the query invalidator from sync context.
 * Throws if sync is not configured.
 *
 * @throws Error if sync context is not available
 */
export function useQueryInvalidator(): IQueryInvalidator {
	const sync = usePlatform().sync;
	if (!sync) {
		throw new Error(
			"useQueryInvalidator requires sync context to be provided to PlatformProvider",
		);
	}
	return sync.invalidator;
}
