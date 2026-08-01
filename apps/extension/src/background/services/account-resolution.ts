import type { DecryptedItemWithContext } from "@bittery/shared/types";
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

export async function resolveAccountIdFromEmail(
	email: string,
): Promise<string | undefined> {
	const normalizedEmail = email.toLowerCase();
	const accounts = await storage.getAccountsList();
	return accounts.find(
		(account) => account.email.toLowerCase() === normalizedEmail,
	)?.accountId;
}

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
		return await resolveEmailFromAccountId(activeAccount.accountId);
	}

	const cached = core.vaultCoordinator.findAccountForVault(vaultId);
	if (cached) {
		return await resolveEmailFromAccountId(cached.accountId);
	}

	// `getUnlockedAccounts` reports which accounts hold a master unlock key in memory.
	// The service-worker startup routine (`restoreUnlockedSessions`) repopulates that set
	// before any message is routed, so this reader never has to restore anything itself.
	const localUnlockedAccountIds = await storage.getUnlockedAccounts();
	const desktopStatus = desktopSync.getLastStatus();
	const desktopUnlockedEmails =
		desktopStatus?.available && !desktopStatus.locked
			? (desktopStatus.unlockedAccounts ?? [])
			: [];
	const desktopUnlockedAccountIds = (
		await Promise.all(
			desktopUnlockedEmails.map((email) => resolveAccountIdFromEmail(email)),
		)
	).filter((accountId): accountId is string => Boolean(accountId));

	const candidateAccountIds = Array.from(
		new Set([...localUnlockedAccountIds, ...desktopUnlockedAccountIds]),
	);

	for (const accountId of candidateAccountIds) {
		const email = await resolveEmailFromAccountId(accountId);
		if (!email) {
			continue;
		}
		await hydrateDesktopAccountMaterial(email);
		let vaultKeys = await storage.getVaultKeys(accountId);
		if (!vaultKeys || vaultKeys.length === 0) {
			const hydrated = await ensureDesktopWriteCapability(email);
			if (hydrated) {
				vaultKeys = await storage.getVaultKeys(accountId);
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
		return await resolveEmailFromAccountId(activeAccount.accountId);
	}

	return undefined;
}
