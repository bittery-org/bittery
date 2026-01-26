/**
 * Web Platform Provider
 *
 * Configures the PlatformProvider for the web app with:
 * - Web storage adapter (injected with WASM crypto)
 * - WASM-based item decryption
 * - Web autolock service
 */

import {
	createWebAutolockService,
	type IAutolockService,
	type IItemDecrypt,
	PlatformProvider,
} from "@bittery/hooks";
import type { EncryptedData } from "@bittery/types";
import type { ReactNode } from "react";
import { storage } from "@/lib/storage";
import { decrypt } from "@/lib/wasm-crypto";

/**
 * Item decrypt implementation using WASM crypto
 */
const itemDecrypt: IItemDecrypt = {
	async decrypt(encryptedData: EncryptedData, vaultKey: Uint8Array): Promise<string> {
		return decrypt(encryptedData, vaultKey);
	},
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
 * Provides storage, itemDecrypt, and autolock services to the shared hooks.
 */
export function WebPlatformProvider({ children }: WebPlatformProviderProps) {
	const autolock = getAutolockService();

	return (
		<PlatformProvider
			storage={storage}
			itemDecrypt={itemDecrypt}
			autolock={autolock}
		>
			{children}
		</PlatformProvider>
	);
}
