/**
 * Mobile Platform Provider
 *
 * Configures the PlatformProvider for the mobile app with:
 * - React Native storage adapter (injected with native crypto)
 * - Native FFI crypto module (decrypt, encrypt, generateEncryptionKey)
 * - Simple query invalidator (mobile doesn't have real-time sync yet)
 */

import {
	type ICrypto,
	type IQueryInvalidator,
	type ISyncContext,
	PlatformProvider,
} from "@bittery/hooks";
import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useMemo } from "react";
import {
	base64ToArrayBuffer,
	decrypt,
	encrypt,
	generateEncryptionKey as nativeGenerateEncryptionKey,
} from "../lib/crypto/native-crypto";
import { useTRPC } from "../lib/trpc";
import { storage } from "../services/storage";

/**
 * Crypto adapter that satisfies ICrypto interface
 * Native crypto module has slightly different signatures that we adapt here
 */
const crypto: ICrypto = {
	decrypt,
	encrypt,
	// Native generateEncryptionKey returns base64 string, so we need to convert
	generateEncryptionKey: async () => {
		const keyBase64 = nativeGenerateEncryptionKey();
		return base64ToArrayBuffer(keyBase64);
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
 * Provides storage, crypto, and sync services to the shared hooks.
 *
 * Note: Mobile doesn't use the autolock service from @bittery/hooks
 * as it has its own BiometricAuthContext-based implementation.
 *
 * Note: Mobile doesn't have real-time sync yet, so we create a simple
 * query invalidator using React Query's useQueryClient.
 */
export function MobilePlatformProvider({ children }: MobilePlatformProviderProps) {
	const queryClient = useQueryClient();
	const trpc = useTRPC();

	// Create a simple query invalidator for mobile
	// Mobile doesn't have real-time sync, so we invalidate queries directly
	const invalidator: IQueryInvalidator = useMemo(
		() => ({
			invalidateItem: async (itemId: string, vaultId: string) => {
				await queryClient.invalidateQueries({
					queryKey: trpc.vault.getItem.queryKey({ itemId }),
				});
				await queryClient.invalidateQueries({
					queryKey: trpc.vault.listItems.queryKey({ vaultId }),
				});
				await queryClient.invalidateQueries({
					queryKey: trpc.vault.listAllItems.queryKey(),
				});
			},
			invalidateVaultList: async (vaultId: string) => {
				await queryClient.invalidateQueries({
					queryKey: trpc.vault.listItems.queryKey({ vaultId }),
				});
				await queryClient.invalidateQueries({
					queryKey: trpc.vault.listAllItems.queryKey(),
				});
			},
			invalidateVaultKeys: async () => {
				await queryClient.invalidateQueries({ queryKey: ["vault-keys"] });
				await queryClient.invalidateQueries({
					queryKey: trpc.vault.list.queryKey(),
				});
			},
			invalidateDeletedItems: async (vaultId: string) => {
				await queryClient.invalidateQueries({
					queryKey: trpc.vault.listDeletedItems.queryKey({ vaultId }),
				});
				await queryClient.invalidateQueries({
					queryKey: trpc.vault.listAllDeletedItems.queryKey(),
				});
			},
			invalidateTeam: async () => {
				await queryClient.invalidateQueries({ queryKey: ["team"] });
			},
			invalidateTeamInvitations: async () => {
				await queryClient.invalidateQueries({ queryKey: ["team"] });
				await queryClient.invalidateQueries({
					queryKey: ["team", "invitations"],
				});
			},
			invalidateShare: async (itemId?: string) => {
				if (itemId) {
					await queryClient.invalidateQueries({
						queryKey: ["share", "listByItem"],
					});
				} else {
					await queryClient.invalidateQueries({ queryKey: ["share"] });
				}
			},
			invalidateVaultMembers: async (vaultId: string) => {
				await queryClient.invalidateQueries({
					queryKey: trpc.vault.members.list.queryKey({ vaultId }),
				});
			},
		}),
		[queryClient, trpc],
	);

	// Create sync context (simplified for mobile - no real-time sync)
	const sync: ISyncContext = useMemo(
		() => ({
			clientId: "mobile", // Could generate a device ID here
			isConnected: true, // Mobile doesn't track WebSocket connection
			isOnline: true, // Could use NetInfo to check connectivity
			invalidator,
		}),
		[invalidator],
	);

	return (
		<PlatformProvider storage={storage} crypto={crypto} sync={sync}>
			{children}
		</PlatformProvider>
	);
}
