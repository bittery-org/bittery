/**
 * Desktop Platform Provider
 *
 * Configures the PlatformProvider for the desktop app with:
 * - Tauri storage adapter (injected with Tauri crypto)
 * - Tauri crypto module (decrypt, encrypt, generateEncryptionKey)
 * - Sync context from DesktopSyncProvider
 */

import { PlatformProvider } from "@bittery/core/hooks";
import type { ICrypto, ISyncContext } from "@bittery/types";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { storage } from "@/lib/storage";
import * as tauriCrypto from "@/lib/tauri-crypto";
import { useSyncContext } from "./sync-provider";

/**
 * Crypto adapter that satisfies ICrypto interface
 * Tauri crypto module exports all required methods for encryption and SRP authentication
 */
const crypto: ICrypto = {
	// Core encryption methods
	decrypt: tauriCrypto.decrypt,
	encrypt: tauriCrypto.encrypt,
	rsaDecrypt: tauriCrypto.rsaDecrypt,
	generateEncryptionKey: tauriCrypto.generateEncryptionKey,
	generateUuid: tauriCrypto.generateUuid,
	// SRP authentication methods
	deriveKeys: tauriCrypto.deriveKeys,
	generateClientEphemeral: tauriCrypto.generateClientEphemeral,
	deriveClientSession: tauriCrypto.deriveClientSession,
	verifyServerSession: tauriCrypto.verifyServerSession,
	validateSecretKey: tauriCrypto.validateSecretKey,
	validateServerKdfParams: tauriCrypto.validateServerKdfParams,
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
 * Note: Desktop doesn't use the autolock service from @bittery/core/hooks
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
		<PlatformProvider storage={storage} crypto={crypto} sync={sync}>
			{children}
		</PlatformProvider>
	);
}
