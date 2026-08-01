/**
 * Mobile Platform Provider
 *
 * Configures the PlatformProvider for the mobile app with:
 * - `AccountStore` + `ItemCache` over the two React Native ports
 * - Native FFI crypto module (decrypt, encrypt, generateEncryptionKey)
 * - Real-time sync using WebSocket connection to server
 */

import { PlatformProvider } from "@bittery/core/hooks";
import type { ICrypto, ISyncContext } from "@bittery/types";
import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { useMobileSync } from "../hooks/use-mobile-sync";
import {
	base64ToArrayBuffer,
	decrypt,
	deriveClientSession,
	deriveKeys,
	encrypt,
	generateClientEphemeral,
	generateUuid,
	generateEncryptionKey as nativeGenerateEncryptionKey,
	rsaDecrypt,
	validateKdfProfile,
	validateSecretKey,
	verifyServerSession,
} from "../lib/crypto/native-crypto";
import { itemCache, storage } from "../services/storage";

/**
 * Crypto adapter that satisfies ICrypto interface
 * Native crypto module has slightly different signatures that we adapt here
 */
const crypto: ICrypto = {
	// Core encryption methods
	decrypt,
	encrypt,
	rsaDecrypt,
	// Native generateEncryptionKey returns base64 string, so we need to convert
	generateEncryptionKey: async () => {
		const keyBase64 = nativeGenerateEncryptionKey();
		return base64ToArrayBuffer(keyBase64);
	},
	generateUuid,
	// SRP authentication methods
	deriveKeys,
	generateClientEphemeral,
	deriveClientSession,
	verifyServerSession,
	validateSecretKey,
	validateKdfProfile,
};

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
			sync={sync}
		>
			{children}
		</PlatformProvider>
	);
}
