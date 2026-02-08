/**
 * Mobile Platform Provider
 *
 * Configures the PlatformProvider for the mobile app with:
 * - React Native storage adapter (injected with native crypto)
 * - Native FFI crypto module (decrypt, encrypt, generateEncryptionKey)
 * - Real-time sync using WebSocket connection to server
 */

import {
	type ICrypto,
	type ISyncContext,
	PlatformProvider,
} from "@bittery/core/hooks";
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
	generateEncryptionKey as nativeGenerateEncryptionKey,
	validateSecretKey,
	verifyServerSession,
} from "../lib/crypto/native-crypto";
import { storage } from "../services/storage";

/**
 * Crypto adapter that satisfies ICrypto interface
 * Native crypto module has slightly different signatures that we adapt here
 */
const crypto: ICrypto = {
	// Core encryption methods
	decrypt,
	encrypt,
	// Native generateEncryptionKey returns base64 string, so we need to convert
	generateEncryptionKey: async () => {
		const keyBase64 = nativeGenerateEncryptionKey();
		return base64ToArrayBuffer(keyBase64);
	},
	// SRP authentication methods
	deriveKeys,
	generateClientEphemeral,
	deriveClientSession,
	verifyServerSession,
	validateSecretKey,
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
		}),
		[
			syncState.clientId,
			syncState.isConnected,
			syncState.isOnline,
			syncState.invalidator,
		],
	);

	return (
		<PlatformProvider storage={storage} crypto={crypto} sync={sync}>
			{children}
		</PlatformProvider>
	);
}
