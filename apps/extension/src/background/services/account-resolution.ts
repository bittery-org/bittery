import { storage } from "../../lib/storage";
import { vaultRepository } from "../../lib/vault-runtime";
import {
	ensureDesktopWriteCapability,
	hydrateDesktopAccountMaterial,
} from "../desktop-key-material";
import type { DesktopSyncService } from "../desktop-sync";

export async function resolveEmailFromAccountId(
	accountId: string,
): Promise<string | undefined> {
	const metadata = await storage.getAccountMetadata(accountId);
	return metadata?.email;
}

export async function resolveAccountIdForVault(
	vaultId: string,
	desktopSync: Pick<DesktopSyncService, "getLastStatus">,
): Promise<string | undefined> {
	const cached = vaultRepository.findAccountForVault(vaultId);
	if (cached) {
		return cached.accountId;
	}

	// The desktop protocol and local storage both publish stable account IDs.
	// Hydrate every candidate by that ID and inspect its scoped vault keys.
	const activeAccountId = await storage.getActiveAccount();
	const localUnlockedAccountIds = await storage.getUnlockedAccounts();
	const desktopStatus = desktopSync.getLastStatus();
	const desktopUnlockedAccountIds =
		desktopStatus?.available && !desktopStatus.locked
			? (desktopStatus.unlockedAccounts ?? [])
			: [];
	const candidateAccountIds = Array.from(
		new Set(
			[
				activeAccountId,
				...localUnlockedAccountIds,
				...desktopUnlockedAccountIds,
			].filter((accountId): accountId is string => Boolean(accountId)),
		),
	);

	for (const accountId of candidateAccountIds) {
		await hydrateDesktopAccountMaterial(accountId);
		let vaultKeys = await storage.getVaultKeys(accountId);
		if (!vaultKeys || vaultKeys.length === 0) {
			const hydrated = await ensureDesktopWriteCapability(accountId);
			if (hydrated) {
				vaultKeys = await storage.getVaultKeys(accountId);
			}
		}
		if (vaultKeys?.some((vaultKey) => vaultKey.vaultId === vaultId)) {
			return accountId;
		}
	}

	return undefined;
}

export async function resolveAccountIdForItem(
	itemId: string,
): Promise<string | undefined> {
	const coordinatedItem = vaultRepository.getById(itemId);
	return (
		coordinatedItem?.accountId ??
		vaultRepository.findAccountForItem(itemId)?.accountId
	);
}
