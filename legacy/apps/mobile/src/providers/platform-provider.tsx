/**
 * Mobile Platform Provider
 *
 * Configures the PlatformProvider for the mobile app with:
 * - Tauri storage adapter and the shared Tauri CryptoPort
 * - VaultCrypto over that same port and storage
 * - Sync context from MobileSyncProvider
 */

import { PlatformProvider } from "@bittery/core/hooks";
import { useSyncCapability } from "@bittery/sync";
import type { ReactNode } from "react";
import { useMobileAccountRuntime } from "@/contexts/account-context";
import { crypto } from "@/lib/crypto";
import { lifecycleDeps } from "@/lib/lifecycle";
import { itemCache, storage } from "@/lib/storage";
import { vaultCrypto } from "@/lib/vault-runtime";
import { useSyncContext } from "./sync-provider";

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
 * Must be rendered inside MobileSyncProvider to access sync context.
 *
 * Note: Mobile doesn't use the autolock service from @bittery/core/hooks
 * as it wires `@bittery/core/hooks/services/autolock-mobile` directly in
 * `AccountProvider` instead.
 */
export function MobilePlatformProvider({
	children,
}: MobilePlatformProviderProps) {
	const syncContext = useSyncContext();
	const { manager, vaultRuntime } = useMobileAccountRuntime();

	const sync = useSyncCapability(syncContext);

	return (
		<PlatformProvider
			storage={storage}
			itemCache={itemCache}
			crypto={crypto}
			credentialMirror={lifecycleDeps.credentialMirror}
			vaultCrypto={vaultCrypto}
			vaultRuntime={vaultRuntime}
			accountManager={manager}
			sync={sync}
		>
			{children}
		</PlatformProvider>
	);
}
