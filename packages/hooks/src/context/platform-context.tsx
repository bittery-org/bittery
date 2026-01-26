/**
 * Platform Context Provider
 *
 * Provides platform-specific dependencies (storage, itemDecrypt, autolock) to shared hooks.
 * Each app wraps its root with PlatformProvider, injecting platform-specific implementations.
 */

import {
	type ReactNode,
	createContext,
	useContext,
} from "react";
import type { IStorageAdapter } from "@bittery/storage/adapter";
import type { IAutolockService, IItemDecrypt } from "../types";

/**
 * Platform context value containing all platform-specific dependencies
 */
export interface PlatformContextValue {
	/** Storage adapter instance (already has CryptoProvider injected) */
	storage: IStorageAdapter;

	/** Item decryption service using platform crypto */
	itemDecrypt: IItemDecrypt;

	/** Autolock service (optional - may not be available on all platforms) */
	autolock?: IAutolockService;
}

const PlatformContext = createContext<PlatformContextValue | null>(null);

/**
 * Props for PlatformProvider
 */
export interface PlatformProviderProps {
	/** Storage adapter instance */
	storage: IStorageAdapter;

	/** Item decryption service */
	itemDecrypt: IItemDecrypt;

	/** Autolock service (optional) */
	autolock?: IAutolockService;

	/** Child components */
	children: ReactNode;
}

/**
 * Provider component that supplies platform-specific dependencies to shared hooks.
 *
 * Usage:
 * ```tsx
 * // In app's root component
 * import { storage } from "@/lib/storage";
 * import { itemDecrypt } from "@/lib/crypto";
 * import { autolockService } from "@/lib/autolock";
 *
 * <PlatformProvider
 *   storage={storage}
 *   itemDecrypt={itemDecrypt}
 *   autolock={autolockService}
 * >
 *   <App />
 * </PlatformProvider>
 * ```
 */
export function PlatformProvider({
	storage,
	itemDecrypt,
	autolock,
	children,
}: PlatformProviderProps) {
	return (
		<PlatformContext.Provider value={{ storage, itemDecrypt, autolock }}>
			{children}
		</PlatformContext.Provider>
	);
}

/**
 * Hook to access the platform context.
 * Must be used within a PlatformProvider.
 *
 * @returns Platform context value containing storage, itemDecrypt, and autolock
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
 * Hook to access just the item decrypt service from platform context.
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
