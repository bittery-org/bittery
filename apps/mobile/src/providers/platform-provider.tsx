/**
 * Mobile Platform Provider
 *
 * Configures the PlatformProvider for the mobile app with:
 * - React Native storage adapter (injected with native crypto)
 * - Native FFI-based item decryption
 */

import {
	type IItemDecrypt,
	PlatformProvider,
} from "@bittery/hooks";
import type { EncryptedData } from "@bittery/types";
import type { ReactNode } from "react";
import { decrypt } from "../lib/crypto/native-crypto";
import { storage } from "../services/storage";

/**
 * Item decrypt implementation using native crypto FFI
 */
const itemDecrypt: IItemDecrypt = {
	async decrypt(encryptedData: EncryptedData, vaultKey: Uint8Array): Promise<string> {
		return decrypt(encryptedData, vaultKey);
	},
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
 * Provides storage and itemDecrypt services to the shared hooks.
 * Note: Mobile doesn't use the autolock service from @bittery/hooks
 * as it has its own BiometricAuthContext-based implementation.
 */
export function MobilePlatformProvider({ children }: MobilePlatformProviderProps) {
	return (
		<PlatformProvider
			storage={storage}
			itemDecrypt={itemDecrypt}
		>
			{children}
		</PlatformProvider>
	);
}
