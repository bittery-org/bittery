/**
 * Extension Platform Provider
 *
 * Configures the PlatformProvider for the browser extension with:
 * - Chrome storage adapter (injected with WASM crypto)
 * - WASM crypto module (decrypt, encrypt, generateEncryptionKey)
 * - Sync context from ExtensionSyncProvider
 */

import type { ISyncContext } from "@bittery/hooks";
import { PlatformProvider } from "@bittery/hooks";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { cryptoAdapter } from "@/lib/crypto-adapter";
import { storage } from "@/lib/storage";
import { useSyncContext } from "./sync-provider";

/**
 * Props for ExtensionPlatformProvider
 */
interface ExtensionPlatformProviderProps {
	children: ReactNode;
}

/**
 * Extension-specific PlatformProvider wrapper
 *
 * Provides storage, crypto, and sync services to the shared hooks.
 * Must be rendered inside ExtensionSyncProvider to access sync context.
 *
 * Note: Extension doesn't use the autolock service from @bittery/hooks
 * as it has its own background worker-based implementation.
 */
export function ExtensionPlatformProvider({
	children,
}: ExtensionPlatformProviderProps) {
	const syncContext = useSyncContext();

	// Map sync context to ISyncContext interface
	const sync: ISyncContext = useMemo(
		() => ({
			clientId: syncContext.clientId,
			isConnected: syncContext.isConnected,
			isOnline: syncContext.isOnline,
			invalidator: syncContext.invalidator,
		}),
		[
			syncContext.clientId,
			syncContext.isConnected,
			syncContext.isOnline,
			syncContext.invalidator,
		],
	);

	return (
		<PlatformProvider storage={storage} crypto={cryptoAdapter} sync={sync}>
			{children}
		</PlatformProvider>
	);
}
