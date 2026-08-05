/**
 * Web Platform Provider
 *
 * Configures the PlatformProvider for the web app with:
 * - Web storage adapter and encrypted item cache
 * - The WASM-worker `CryptoPort` and the `VaultCrypto` built over it
 * - Sync context from SyncProvider
 * - Web autolock service
 */

import { PlatformProvider } from "@bittery/core/hooks";
import { createWebAutolockService } from "@bittery/core/hooks/services/autolock-web";
import { createVaultCrypto } from "@bittery/core/services/vault-crypto";
import type { IAutolockService, ISyncContext } from "@bittery/types";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { crypto } from "@/lib/crypto";
import { lifecycleDeps } from "@/lib/lifecycle";
import { itemCache, storage } from "@/lib/storage";
import { useSyncContext } from "./sync-provider";

const vaultCrypto = createVaultCrypto({ crypto, storage });

/**
 * Web autolock service instance (singleton)
 */
let autolockService: IAutolockService | null = null;

function getAutolockService(): IAutolockService {
	if (!autolockService) {
		autolockService = createWebAutolockService(storage);
	}
	return autolockService;
}

/**
 * Props for WebPlatformProvider
 */
interface WebPlatformProviderProps {
	children: ReactNode;
}

/**
 * Web-specific PlatformProvider wrapper
 *
 * Provides storage, crypto, sync, and autolock services to the shared hooks.
 * Must be rendered inside SyncProvider to access sync context.
 */
export function WebPlatformProvider({ children }: WebPlatformProviderProps) {
	const autolock = getAutolockService();
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
			sync={sync}
			autolock={autolock}
		>
			{children}
		</PlatformProvider>
	);
}
