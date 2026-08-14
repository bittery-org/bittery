import { storage } from "../../lib/storage";
import { core } from "../core-instance";
import {
	ensureDesktopWriteCapability,
	hydrateDesktopAccountMaterial,
} from "../desktop-key-material";
import { desktopSync } from "../desktop-sync";

export async function resolveEmailFromAccountId(
	accountId: string,
): Promise<string | undefined> {
	const metadata = await storage.getAccountMetadata(accountId);
	return metadata?.email;
}

export async function resolveAccountIdForVault(
	vaultId: string,
): Promise<string | undefined> {
	const cached = core.vaultRepository.findAccountForVault(vaultId);
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
	const coordinatedItem = core.vaultRepository.getById(itemId);
	return (
		coordinatedItem?.accountId ??
		core.vaultRepository.findAccountForItem(itemId)?.accountId
	);
}
