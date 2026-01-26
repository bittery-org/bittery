/**
 * Desktop Platform Provider
 *
 * Configures the PlatformProvider for the desktop app with:
 * - Tauri storage adapter (injected with Tauri crypto)
 * - Tauri-based item decryption
 */

import {
	type IItemDecrypt,
	PlatformProvider,
} from "@bittery/hooks";
import type { EncryptedData } from "@bittery/types";
import type { ReactNode } from "react";
import { storage } from "@/lib/storage";
import { decrypt } from "@/lib/tauri-crypto";

/**
 * Item decrypt implementation using Tauri crypto commands
 */
const itemDecrypt: IItemDecrypt = {
	async decrypt(encryptedData: EncryptedData, vaultKey: Uint8Array): Promise<string> {
		return decrypt(encryptedData, vaultKey);
	},
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
 * Provides storage and itemDecrypt services to the shared hooks.
 * Note: Desktop doesn't use the autolock service from @bittery/hooks
 * as it has its own Tauri-based implementation.
 */
export function DesktopPlatformProvider({ children }: DesktopPlatformProviderProps) {
	return (
		<PlatformProvider
			storage={storage}
			itemDecrypt={itemDecrypt}
		>
			{children}
		</PlatformProvider>
	);
}
