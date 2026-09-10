/**
 * Web Platform Provider
 *
 * Configures the PlatformProvider for the web app with:
 * - Web storage adapter and encrypted item cache
 * - The WASM-worker `CryptoPort` and the `VaultCrypto` built over it
 * - The inert Sync capability: Web runs no Sync loop, the Runtime owns Sync ownership
 * - Web autolock service
 */

import { PlatformProvider } from "@bittery/core/hooks";
import { createWebAutolockService } from "@bittery/core/hooks/services/autolock-web";
import type { IAutolockService } from "@bittery/core/services/autolock";
import type { ReactNode } from "react";
import { crypto } from "@/lib/crypto";
import { itemCache, storage } from "@/lib/storage";
import { vaultCrypto } from "@/lib/vault-runtime";
import { useAccountRuntime } from "./account-runtime-provider";
import { useTransitionalSync } from "./transitional-sync-provider";

/**
 * Web autolock service instance (singleton)
 */
let autolockService: IAutolockService | null = null;

// Web mirrors no credentials outside AccountStore. The remaining transitional hooks still
// require an explicit adapter so another host cannot silently omit one.
const webCredentialMirror = {
	async purge(): Promise<void> {},
	async forgetQuickUnlock(): Promise<void> {},
};

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
 * Provides storage, crypto, the inert Sync capability, and autolock to the shared hooks
 * the transitional flows still use. Must be rendered inside TransitionalSyncProvider.
 */
export function WebPlatformProvider({ children }: WebPlatformProviderProps) {
	const autolock = getAutolockService();
	const sync = useTransitionalSync();
	const { manager, vaultRuntime } = useAccountRuntime();

	return (
		<PlatformProvider
			storage={storage}
			itemCache={itemCache}
			crypto={crypto}
			credentialMirror={webCredentialMirror}
			vaultCrypto={vaultCrypto}
			vaultRuntime={vaultRuntime}
			accountManager={manager}
			sync={sync}
			autolock={autolock}
		>
			{children}
		</PlatformProvider>
	);
}
