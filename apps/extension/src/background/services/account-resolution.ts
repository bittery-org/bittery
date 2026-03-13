import type { DecryptedItemWithContext } from "@bittery/shared/types";
import { storage } from "../../lib/storage";
import { core } from "../core-instance";
import {
	ensureDesktopWriteCapability,
	hydrateDesktopAccountMaterial,
} from "../desktop-key-material";
import { desktopSync } from "../desktop-sync";

export function getItemAccountEmail(
	item: Pick<DecryptedItemWithContext, "accountEmail" | "account">,
): string | undefined {
	return item.accountEmail ?? item.account?.email;
}

export async function resolveAccountEmailForVault(
	vaultId: string,
): Promise<string | undefined> {
	const activeAccount = await storage.getActiveAccount();
	if (activeAccount?.type === "single") {
		return activeAccount.email;
	}

	const cached = core.vaultCoordinator.findAccountForVault(vaultId);
	if (cached?.email) {
		return cached.email;
	}

	const localUnlockedEmails = (await storage.getUnlockedAccounts?.()) ?? [];
	const desktopStatus = desktopSync.getLastStatus();
	const desktopUnlockedEmails =
		desktopStatus?.available && !desktopStatus.locked
			? (desktopStatus.unlockedAccounts ?? [])
			: [];

	const candidateEmails = Array.from(
		new Set([...localUnlockedEmails, ...desktopUnlockedEmails]),
	);

	for (const email of candidateEmails) {
		await hydrateDesktopAccountMaterial(email);
		let vaultKeys = await storage.getVaultKeys(email);
		if (!vaultKeys || vaultKeys.length === 0) {
			const hydrated = await ensureDesktopWriteCapability(email);
			if (hydrated) {
				vaultKeys = await storage.getVaultKeys(email);
			}
		}
		if (vaultKeys?.some((vaultKey) => vaultKey.vaultId === vaultId)) {
			return email;
		}
	}

	return undefined;
}

export async function resolveAccountEmailForItemId(
	itemId: string,
	loadItems: () => Promise<Array<DecryptedItemWithContext | null>>,
): Promise<string | undefined> {
	const coordinatedItem = core.vaultCoordinator.getById(itemId);
	if (coordinatedItem?.accountEmail) {
		return coordinatedItem.accountEmail;
	}
	if (coordinatedItem?.account?.email) {
		return coordinatedItem.account.email;
	}

	const activeAccount = await storage.getActiveAccount();
	if (activeAccount?.type === "single") {
		return activeAccount.email;
	}
	if (activeAccount?.type !== "all") {
		return undefined;
	}

	const items = await loadItems();
	const item = items.find(
		(candidate): candidate is DecryptedItemWithContext =>
			candidate !== null && candidate.id === itemId,
	);

	return item ? getItemAccountEmail(item) : undefined;
}
