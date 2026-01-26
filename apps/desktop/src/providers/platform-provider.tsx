/**
 * Desktop Platform Provider
 *
 * Configures the PlatformProvider for the desktop app with:
 * - Tauri storage adapter (injected with Tauri crypto)
 * - Tauri crypto module (decrypt, encrypt, generateEncryptionKey)
 * - Sync context from DesktopSyncProvider
 */

import {
	type ICrypto,
	type ISyncContext,
	PlatformProvider,
} from "@bittery/hooks";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { storage } from "@/lib/storage";
import * as tauriCrypto from "@/lib/tauri-crypto";
import { useSyncContext } from "./sync-provider";

/**
 * Crypto adapter that satisfies ICrypto interface
 * Tauri crypto module already exports decrypt, encrypt, generateEncryptionKey
 */
const crypto: ICrypto = {
	decrypt: tauriCrypto.decrypt,
	encrypt: tauriCrypto.encrypt,
	generateEncryptionKey: tauriCrypto.generateEncryptionKey,
};

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
 * Note: Desktop doesn't use the autolock service from @bittery/hooks
 * as it has its own Tauri-based implementation.
 */
export function DesktopPlatformProvider({
	children,
}: DesktopPlatformProviderProps) {
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
		<PlatformProvider storage={storage} crypto={crypto} sync={sync}>
			{children}
		</PlatformProvider>
	);
}
