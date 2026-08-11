import type { ItemSyncCommand } from "@bittery/types";

export interface NativeEncryptedItemHandoff {
	id: string;
	vaultId: string;
	itemId: string;
	operation: "create_item" | "update_item";
	encryptedData: string;
	encryptionIv: string;
	encryptionAlgorithm: string;
	baseVersion?: number;
	encryptionVersion?: number;
	encryptedByUserId?: string;
	createdAt: number;
}

export function isLegacyNativeItemConflict(
	handoff: NativeEncryptedItemHandoff,
): boolean {
	return (
		handoff.baseVersion === -1 &&
		handoff.encryptionVersion === -1 &&
		handoff.encryptedByUserId === ""
	);
}

export function createNativeItemSyncCommand(
	handoff: NativeEncryptedItemHandoff,
	account: { accountId: string; accountEmail: string },
): ItemSyncCommand {
	if (isLegacyNativeItemConflict(handoff)) {
		return {
			id: handoff.id,
			operationId: handoff.id,
			accountId: account.accountId,
			accountEmail: account.accountEmail,
			type: handoff.operation === "create_item" ? "create" : "update",
			entityId: handoff.itemId,
			vaultId: handoff.vaultId,
			category: handoff.operation === "create_item" ? "login" : undefined,
			encryptedPayload: {
				encryptedData: handoff.encryptedData,
				encryptionIv: handoff.encryptionIv,
				encryptionAlgorithm: handoff.encryptionAlgorithm,
			},
			baseVersion: 0,
			timestamp: handoff.createdAt,
			retryCount: 0,
			status: "conflicted",
			lastError: `Native Item operation ${handoff.id} predates exact encryption context`,
		};
	}
	if (
		typeof handoff.baseVersion !== "number" ||
		!Number.isInteger(handoff.baseVersion) ||
		handoff.baseVersion < 0 ||
		typeof handoff.encryptionVersion !== "number" ||
		!Number.isInteger(handoff.encryptionVersion) ||
		handoff.encryptionVersion < 1 ||
		!handoff.encryptedByUserId?.trim()
	) {
		throw new Error(
			`Native Item operation ${handoff.id} has no exact encryption context`,
		);
	}
	return {
		id: handoff.id,
		operationId: handoff.id,
		accountId: account.accountId,
		accountEmail: account.accountEmail,
		type: handoff.operation === "create_item" ? "create" : "update",
		entityId: handoff.itemId,
		vaultId: handoff.vaultId,
		category: handoff.operation === "create_item" ? "login" : undefined,
		encryptedPayload: {
			encryptedData: handoff.encryptedData,
			encryptionIv: handoff.encryptionIv,
			encryptionAlgorithm: handoff.encryptionAlgorithm,
			encryptionVersion: handoff.encryptionVersion,
			encryptedByUserId: handoff.encryptedByUserId,
		},
		baseVersion: handoff.baseVersion,
		timestamp: handoff.createdAt,
		retryCount: 0,
	};
}
