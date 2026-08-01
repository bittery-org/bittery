/**
 * Web Platform Provider
 *
 * Configures the PlatformProvider for the web app with:
 * - Web storage adapter (injected with WASM crypto)
 * - WASM crypto module (decrypt, encrypt, generateEncryptionKey)
 * - Sync context from SyncProvider
 * - Web autolock service
 */

import {
	createWebAutolockService,
	PlatformProvider,
} from "@bittery/core/hooks";
import type { IAutolockService, ICrypto, ISyncContext } from "@bittery/types";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { itemCache, storage } from "@/lib/storage";
import * as wasmCrypto from "@/lib/wasm-crypto";
import { useSyncContext } from "./sync-provider";

/**
 * Crypto adapter that satisfies ICrypto interface
 * WASM crypto module exports all required methods for encryption and SRP authentication
 */
const crypto: ICrypto = {
	// Core encryption methods
	decrypt: wasmCrypto.decrypt,
	encrypt: wasmCrypto.encrypt,
	rsaDecrypt: wasmCrypto.rsaDecrypt,
	generateEncryptionKey: wasmCrypto.generateEncryptionKey,
	generateUuid: wasmCrypto.generateUuid,
	// SRP authentication methods
	deriveKeys: wasmCrypto.deriveKeys,
	generateClientEphemeral: wasmCrypto.generateClientEphemeralAsync,
	deriveClientSession: wasmCrypto.deriveClientSession,
	verifyServerSession: wasmCrypto.verifyServerSession,
	validateSecretKey: wasmCrypto.validateSecretKeyAsync,
};

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
			sync={sync}
			autolock={autolock}
		>
			{children}
		</PlatformProvider>
	);
}
