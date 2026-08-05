/**
 * Mobile Platform Provider
 *
 * Configures the PlatformProvider for the mobile app with:
 * - `AccountStore` + `ItemCache` over the two React Native ports
 * - Expo CryptoPort and VaultCrypto over the native FFI module
 * - Real-time sync using WebSocket connection to server
 */

import { PlatformProvider } from "@bittery/core/hooks";
import { createVaultCrypto } from "@bittery/core/services/vault-crypto";
import type { ISyncContext } from "@bittery/types";
import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { useMobileSync } from "../hooks/use-mobile-sync";
import { crypto } from "../lib/crypto";
import { itemCache, storage } from "../services/storage";

const vaultCrypto = createVaultCrypto({ crypto, storage });

/**
 * Props for MobilePlatformProvider
 */
interface MobilePlatformProviderProps {
	children: ReactNode;
}

/**
 * Mobile-specific PlatformProvider wrapper
 *
 * Provides storage, crypto, and sync services to the shared hooks.
 *
 * Note: Mobile doesn't use the autolock service from @bittery/core/hooks
 * as it has its own BiometricAuthContext-based implementation.
 */
export function MobilePlatformProvider({
	children,
}: MobilePlatformProviderProps) {
	const queryClient = useQueryClient();

	// Initialize real-time sync with WebSocket connection
	const syncState = useMobileSync(queryClient, true);

	// Create sync context with real-time sync state
	const sync: ISyncContext = useMemo(
		() => ({
			clientId: syncState.clientId,
			isConnected: syncState.isConnected,
			isOnline: syncState.isOnline,
			invalidator: syncState.invalidator,
			outboundQueue: syncState.outboundQueue,
		}),
		[
			syncState.clientId,
			syncState.isConnected,
			syncState.isOnline,
			syncState.invalidator,
			syncState.outboundQueue,
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
