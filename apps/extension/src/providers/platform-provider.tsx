/**
 * Extension Platform Provider
 *
 * Configures the PlatformProvider for the browser extension with:
 * - Chrome storage adapter and the WASM `CryptoPort`
 * - VaultCrypto over that port
 * - Sync context from ExtensionSyncProvider
 */

import { PlatformProvider } from "@bittery/core/hooks";
import { createVaultCrypto } from "@bittery/core/services/vault-crypto";
import type { ISyncContext } from "@bittery/types";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { crypto } from "@/lib/crypto";
import { itemCache, storage } from "@/lib/storage";
import { useSyncContext } from "./sync-provider";

const vaultCrypto = createVaultCrypto({ crypto, storage });

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
 * Note: Extension doesn't use the autolock service from @bittery/core/hooks
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
			outboundQueue: syncContext.outboundQueue,
		}),
		[
			syncContext.clientId,
			syncContext.isConnected,
			syncContext.isOnline,
			syncContext.invalidator,
			syncContext.outboundQueue,
		],
	);

	return (
		<PlatformProvider
			storage={storage}
			itemCache={itemCache}
			crypto={crypto}
			vaultCrypto={vaultCrypto}
			sync={sync}
		>
			{children}
		</PlatformProvider>
	);
}
