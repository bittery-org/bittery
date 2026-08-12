import type { ItemSyncAcknowledgement, ItemSyncCommand } from "@bittery/types";
import type { BackgroundEventOf } from "../background/events/contract";

/**
 * The acknowledgement push, named. The shape is the contract's, not a second
 * copy of it — only the runtime validation below is local, because this payload
 * is the one push whose fields are consumed rather than merely signalled.
 */
export type WorkerItemCommandAcknowledgedMessage =
	BackgroundEventOf<"SYNC_ITEM_COMMAND_ACKNOWLEDGED">;

export function isWorkerItemCommandAcknowledgedMessage(
	message: unknown,
): message is WorkerItemCommandAcknowledgedMessage {
	if (!message || typeof message !== "object") return false;
	const candidate = message as {
		type?: unknown;
		command?: Record<string, unknown>;
		acknowledgement?: Record<string, unknown>;
	};
	const command = candidate.command;
	const acknowledgement = candidate.acknowledgement;
	const commandTypes = new Set([
		"create",
		"update",
		"delete",
		"permanent_delete",
		"restore",
		"move",
		"cross_account_move",
		"toggle_favorite",
	]);
	return (
		candidate.type === "SYNC_ITEM_COMMAND_ACKNOWLEDGED" &&
		!!command &&
		!!acknowledgement &&
		typeof command.id === "string" &&
		command.id.trim().length > 0 &&
		typeof command.operationId === "string" &&
		command.operationId.trim().length > 0 &&
		typeof command.accountId === "string" &&
		command.accountId.trim().length > 0 &&
		typeof command.entityId === "string" &&
		command.entityId.trim().length > 0 &&
		typeof command.vaultId === "string" &&
		command.vaultId.trim().length > 0 &&
		typeof command.type === "string" &&
		commandTypes.has(command.type) &&
		typeof command.baseVersion === "number" &&
		Number.isInteger(command.baseVersion) &&
		command.baseVersion >= 0 &&
		typeof command.timestamp === "number" &&
		Number.isFinite(command.timestamp) &&
		typeof command.retryCount === "number" &&
		Number.isInteger(command.retryCount) &&
		command.retryCount >= 0 &&
		typeof acknowledgement.entityId === "string" &&
		acknowledgement.entityId.trim().length > 0 &&
		acknowledgement.entityId === command.entityId &&
		typeof acknowledgement.version === "number" &&
		Number.isInteger(acknowledgement.version) &&
		acknowledgement.version >= 1 &&
		(acknowledgement.etag === null || typeof acknowledgement.etag === "string")
	);
}

export async function reconcileWorkerItemCommandAcknowledgement(
	message: WorkerItemCommandAcknowledgedMessage,
	coordinator: {
		acknowledgeItemCommand(
			command: ItemSyncCommand,
			acknowledgement: ItemSyncAcknowledgement,
		): Promise<void>;
	},
): Promise<void> {
	await coordinator.acknowledgeItemCommand(
		message.command,
		message.acknowledgement,
	);
}
