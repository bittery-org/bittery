/**
 * Extension Platform Provider
 *
 * Configures the PlatformProvider for the browser extension with:
 * - Chrome storage adapter and the WASM `CryptoPort`
 * - VaultCrypto over that port
 * - Sync context from ExtensionSyncProvider
 */

import { PlatformProvider } from "@bittery/core/hooks";
import type { ISyncContext } from "@bittery/sync";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { lifecycleDeps } from "@/background/lifecycle";
import { crypto } from "@/lib/crypto";
import { vaultRuntime } from "@/lib/popup-account-vault-runtime";
import { itemCache, storage } from "@/lib/storage";
import { vaultCrypto } from "@/lib/vault-runtime";
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
			credentialMirror={lifecycleDeps.credentialMirror}
			vaultCrypto={vaultCrypto}
			vaultRuntime={vaultRuntime}
			sync={sync}
		>
			{children}
		</PlatformProvider>
	);
}
