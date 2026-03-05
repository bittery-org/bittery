import { db } from "@bittery/db";
import { TRPCError } from "@trpc/server";

export interface PendingVaultKeyEntry {
	vaultId: string;
	encryptedVaultKey: string;
}

function normalizeEntry(
	entry: PendingVaultKeyEntry,
	index: number,
): PendingVaultKeyEntry {
	const vaultId = entry.vaultId?.trim();
	const encryptedVaultKey = entry.encryptedVaultKey?.trim();

	if (!vaultId || !encryptedVaultKey) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `Invalid pendingVaultKeys entry at index ${index}`,
		});
	}

	return {
		vaultId,
		encryptedVaultKey,
	};
}

export function normalizePendingVaultKeys(
	pendingVaultKeys: PendingVaultKeyEntry[] | null | undefined,
): PendingVaultKeyEntry[] {
	if (!pendingVaultKeys || pendingVaultKeys.length === 0) {
		return [];
	}

	const normalized = pendingVaultKeys.map((entry, index) =>
		normalizeEntry(entry, index),
	);
	const vaultIds = normalized.map((entry) => entry.vaultId);
	const uniqueVaultIds = new Set(vaultIds);

	if (uniqueVaultIds.size !== vaultIds.length) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Duplicate vault IDs are not allowed in pendingVaultKeys",
		});
	}

	return normalized;
}

export function parsePendingVaultKeys(
	rawPendingVaultKeys: string | null,
): PendingVaultKeyEntry[] {
	if (!rawPendingVaultKeys) {
		return [];
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(rawPendingVaultKeys);
	} catch {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Invalid pendingVaultKeys payload",
		});
	}

	if (!Array.isArray(parsed)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Invalid pendingVaultKeys payload",
		});
	}

	return normalizePendingVaultKeys(
		parsed as Array<{ vaultId: string; encryptedVaultKey: string }>,
	);
}

export async function assertInvitationPendingVaultKeysAreAuthorized(input: {
	teamId: string;
	inviterId: string;
	pendingVaultKeys: PendingVaultKeyEntry[] | null | undefined;
}): Promise<void> {
	const normalized = normalizePendingVaultKeys(input.pendingVaultKeys);
	if (normalized.length === 0) {
		return;
	}

	const vaultIds = normalized.map((entry) => entry.vaultId);

	const teamVaults = await db.query.vault.findMany({
		where: (teamVault, { and, eq, inArray }) =>
			and(eq(teamVault.teamId, input.teamId), inArray(teamVault.id, vaultIds)),
		columns: { id: true },
	});
	if (teamVaults.length !== vaultIds.length) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "pendingVaultKeys contains vaults outside the invited team",
		});
	}

	const inviterVaultKeys = await db.query.vaultKey.findMany({
		where: (keyRecord, { and, eq, inArray }) =>
			and(
				eq(keyRecord.userId, input.inviterId),
				inArray(keyRecord.vaultId, vaultIds),
			),
		columns: { vaultId: true, role: true },
	});
	const authorizedVaultIds = new Set(
		inviterVaultKeys
			.filter(
				(keyRecord) => keyRecord.role === "owner" || keyRecord.role === "admin",
			)
			.map((keyRecord) => keyRecord.vaultId),
	);

	if (authorizedVaultIds.size !== vaultIds.length) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message:
				"You do not have permission to grant access for one or more vaults",
		});
	}
}
