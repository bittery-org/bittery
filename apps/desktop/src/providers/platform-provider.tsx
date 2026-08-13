/**
 * Desktop Platform Provider
 *
 * Configures the PlatformProvider for the desktop app with:
 * - Tauri storage adapter and the shared Tauri CryptoPort
 * - VaultCrypto over that same port and storage
 * - Sync context from DesktopSyncProvider
 */

import { PlatformProvider } from "@bittery/core/hooks";
import type { ISyncContext } from "@bittery/types";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { useDesktopAccountRuntime } from "@/contexts/account-context";
import { crypto } from "@/lib/crypto";
import { lifecycleDeps } from "@/lib/lifecycle";
import { itemCache, storage } from "@/lib/storage";
import { vaultCrypto } from "@/lib/vault-runtime";
import { useSyncContext } from "./sync-provider";

/**
 * Props for DesktopPlatformProvider
 */
interface DesktopPlatformProviderProps {
	children: ReactNode;
}

/**
 * Desktop-specific PlatformProvider wrapper
 *
 * Provides storage, crypto, and sync services to the shared hooks.
 * Must be rendered inside DesktopSyncProvider to access sync context.
 *
 * Note: Desktop doesn't use the autolock service from @bittery/core/hooks
 * as it has its own Tauri-based implementation.
 */
export function DesktopPlatformProvider({
	children,
}: DesktopPlatformProviderProps) {
	const syncContext = useSyncContext();
	const { vaultRuntime } = useDesktopAccountRuntime();

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
