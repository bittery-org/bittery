/**
 * Platform Context Provider
 *
 * Provides platform-specific dependencies (storage, crypto, sync, autolock) to shared hooks.
 * Each app wraps its root with PlatformProvider, injecting platform-specific implementations.
 */

import {
	type ReactNode,
	createContext,
	useContext,
	useMemo,
} from "react";
import type { IStorageAdapter } from "@bittery/storage/adapter";
import type {
	IAutolockService,
	ICrypto,
	IItemDecrypt,
	IQueryInvalidator,
	ISyncContext,
} from "../types";

/**
 * Platform context value containing all platform-specific dependencies
 */
export interface PlatformContextValue {
	/** Storage adapter instance (already has CryptoProvider injected) */
	storage: IStorageAdapter;

	/** Platform crypto module - all platforms have identical API */
	crypto: ICrypto;

	/**
	 * Item decryption service using platform crypto
	 * @deprecated Use crypto.decrypt instead
	 */
	itemDecrypt: IItemDecrypt;

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
	storage: IStorageAdapter;

	/**
	 * Platform crypto module - pass your crypto module directly (e.g., import * as crypto from "@/lib/wasm-crypto")
	 * Must implement ICrypto interface (decrypt, encrypt, generateEncryptionKey)
	 */
	crypto: ICrypto;

	/**
	 * Item decryption service
	 * @deprecated Use crypto prop instead. This prop will be removed in a future version.
	 */
	itemDecrypt?: IItemDecrypt;

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
 * import * as crypto from "@/lib/wasm-crypto";
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
	crypto,
	itemDecrypt,
	autolock,
	sync,
	children,
}: PlatformProviderProps) {
	// Create itemDecrypt from crypto if not provided (backward compatibility)
	const effectiveItemDecrypt: IItemDecrypt = useMemo(
		() =>
			itemDecrypt ?? {
				decrypt: (encryptedData, vaultKey) =>
					crypto.decrypt(encryptedData, vaultKey),
			},
		[itemDecrypt, crypto],
	);

	const value = useMemo(
		() => ({
			storage,
			crypto,
			itemDecrypt: effectiveItemDecrypt,
			autolock,
			sync,
		}),
		[storage, crypto, effectiveItemDecrypt, autolock, sync],
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
 * @returns Platform context value containing storage, crypto, itemDecrypt, autolock, and sync
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
export function usePlatformStorage(): IStorageAdapter {
	return usePlatform().storage;
}

/**
 * Hook to access the crypto module from platform context.
 * Convenience wrapper around usePlatform().
 */
export function usePlatformCrypto(): ICrypto {
	return usePlatform().crypto;
}

/**
 * Hook to access just the item decrypt service from platform context.
 * @deprecated Use usePlatformCrypto().decrypt instead
 * Convenience wrapper around usePlatform().
 */
export function usePlatformItemDecrypt(): IItemDecrypt {
	return usePlatform().itemDecrypt;
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
