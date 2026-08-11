// The worker owns durability and account-scoped transport; popup projections
// are leased so no command becomes drainable before its local view is ready.

import {
	ItemSyncEngine,
	type OutboundQueueApiClient,
	type SyncCommandSummary,
} from "@bittery/sync";
import type { ItemSyncCommand } from "@bittery/types";
import { ChromeSyncStorage } from "../lib/sync-storage";
import { core } from "./core-instance";
import { syncCacheService } from "./services/sync-cache-service";
import { getOrCreateSyncClientId } from "./sync-client-id";

const OUTBOUND_RETRY_ALARM_NAME = "bittery_outbound_retry";
const POPUP_PROJECTION_LEASE_MS = 30_000;

let queuePromise: Promise<ItemSyncEngine> | null = null;

function getQueue(): Promise<ItemSyncEngine> {
	queuePromise ??= (async () => {
		const queue = new ItemSyncEngine(
			new ChromeSyncStorage(),
			await getOrCreateSyncClientId(),
			{
				apply: (command) => core.vaultCoordinator.applyItemCommand(command),
				executeSemanticCommand: (command) =>
					core.vaultCoordinator.executeSemanticItemCommand(command),
				preserveConflict: (command) =>
					core.vaultCoordinator.preserveItemConflict(command),
				reconcileAuthoritative: (command, item) =>
					core.vaultCoordinator.upsertCachedItem(item, command.accountId),
				acknowledge: async (command, acknowledgement) => {
					await core.vaultCoordinator.acknowledgeItemCommand(
						command,
						acknowledgement,
					);
					await chrome.runtime
						.sendMessage({
							type: "SYNC_ITEM_COMMAND_ACKNOWLEDGED",
							command,
							acknowledgement,
						})
						.catch(() => undefined);
				},
			},
		);
		await queue.restore();
		queue.subscribe(() => {
			chrome.runtime
				.sendMessage({
					type: "SYNC_COMMAND_STATUS_CHANGED",
					summary: queue.getCommandSummary(),
				})
				.catch(() => undefined);
		});
		return queue;
	})();
	return queuePromise;
}

export async function getOutboundCommandSummary(): Promise<SyncCommandSummary> {
	return (await getQueue()).getCommandSummary();
}

export async function enqueueOutboundCommand(
	command: ItemSyncCommand,
): Promise<void> {
	const queue = await getQueue();
	await queue.enqueue(command);
	void drainOutboundQueue().catch((error) => {
		console.error("[OutboundQueue] Background drain failed:", error);
	});
}

export async function stageOutboundCommand(
	command: ItemSyncCommand,
	claimId: string,
): Promise<boolean> {
	return (await getQueue()).stage(command, {
		id: claimId,
		expiresAt: Date.now() + POPUP_PROJECTION_LEASE_MS,
	});
}

export async function claimStagedOutboundCommands(
	claimId: string,
): Promise<{ commands: ItemSyncCommand[]; nextClaimAt?: number }> {
	const queue = await getQueue();
	const commands = await queue.claimStaged(claimId, POPUP_PROJECTION_LEASE_MS);
	return { commands, nextClaimAt: queue.getNextStagedClaimAt() };
}

export async function cancelStagedOutboundCommand(
	accountId: string,
	operationId: string,
	claimId: string,
): Promise<boolean> {
	return (await getQueue()).cancel(accountId, operationId, claimId);
}

export async function activateAndDrainOutboundCommand(
	accountId: string,
	operationId: string,
	claimId: string,
): Promise<boolean> {
	const queue = await getQueue();
	if (!(await queue.activate(accountId, operationId, claimId))) {
		return false;
	}
	await drainOutboundQueue();
	return true;
}

let draining: Promise<void> | null = null;

async function runDrain(): Promise<void> {
	const queue = await getQueue();
	if (queue.getPendingCount() === 0) {
		return;
	}

	queue.compact();
	await queue.drain(async (accountId) => {
		const client = await syncCacheService.getClientForAccountId(accountId);
		if (!client) {
			throw new Error(
				`No authenticated API client for account queue drain (${accountId})`,
			);
		}
		return client as unknown as OutboundQueueApiClient;
	});
	const retryAt = queue.getNextRetryAt();
	if (retryAt === undefined) {
		await chrome.alarms.clear(OUTBOUND_RETRY_ALARM_NAME);
	} else {
		chrome.alarms.create(OUTBOUND_RETRY_ALARM_NAME, { when: retryAt });
	}

	for (const mapping of queue.consumeTempIdMappings()) {
		core.vaultCoordinator.replaceItemId(
			mapping.tempId,
			mapping.realId,
			mapping.accountId,
		);
	}

	// The popup holds its own repository copy, including the temp ids just
	// replaced above, so it has to re-read after a push.
	chrome.runtime
		.sendMessage({ type: "SYNC_FULL_REFRESH_REQUIRED" })
		.catch(() => {
			// Popup closed.
		});
}

/**
 * Serialized: two overlapping drains would each restore the queue from storage
 * and re-send everything the other had already sent.
 */
export function drainOutboundQueue(): Promise<void> {
	draining = (draining ?? Promise.resolve())
		.catch(() => undefined)
		.then(runDrain);
	return draining;
}

export async function handleOutboundRetryAlarm(
	alarm: chrome.alarms.Alarm,
): Promise<void> {
	if (alarm.name === OUTBOUND_RETRY_ALARM_NAME) {
		await drainOutboundQueue();
	}
}
