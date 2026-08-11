import type { IPendingMutationQueue, ItemSyncCommand } from "@bittery/types";

export interface WorkerQueueResponse {
	success?: boolean;
	error?: string;
	code?: "CLAIM_LOST" | "ALREADY_EXISTS";
	commands?: ItemSyncCommand[];
	nextClaimAt?: number;
}

export type WorkerQueueMessage =
	| {
			type: "ENQUEUE_ITEM_COMMAND";
			payload: { command: ItemSyncCommand; claimId: string };
	  }
	| {
			type: "DRAIN_OUTBOUND_QUEUE";
			payload: { accountId: string; operationId: string; claimId: string };
	  }
	| {
			type: "CANCEL_STAGED_ITEM_COMMAND";
			payload: { accountId: string; operationId: string; claimId: string };
	  }
	| {
			type: "CLAIM_STAGED_ITEM_COMMANDS";
			payload: { claimId: string };
	  };

interface WorkerOwnedOutboundQueueOptions {
	sendMessage: (
		message: WorkerQueueMessage,
	) => Promise<WorkerQueueResponse | undefined>;
	applyProjection: (command: ItemSyncCommand) => Promise<void>;
	discardProjection?: (command: ItemSyncCommand) => Promise<void>;
}

export interface WorkerOwnedOutboundQueue extends IPendingMutationQueue {
	recoverStaged(): Promise<void>;
}

function newClaimId(): string {
	return (
		globalThis.crypto?.randomUUID?.() ??
		`popup-claim-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
}

export function createWorkerOwnedOutboundQueue({
	sendMessage,
	applyProjection,
	discardProjection = async () => undefined,
}: WorkerOwnedOutboundQueueOptions): WorkerOwnedOutboundQueue {
	const finishProjection = async (
		command: ItemSyncCommand,
		claimId: string,
	): Promise<void> => {
		try {
			await applyProjection(command);
		} catch (error) {
			const cancelResponse = await sendMessage({
				type: "CANCEL_STAGED_ITEM_COMMAND",
				payload: {
					accountId: command.accountId,
					operationId: command.operationId ?? command.id,
					claimId,
				},
			});
			if (!cancelResponse?.success) {
				if (cancelResponse?.code === "CLAIM_LOST") {
					await discardProjection(command);
				}
				throw new Error(
					cancelResponse?.error ?? "Failed to cancel staged Item command",
				);
			}
			throw error;
		}
		const drainResponse = await sendMessage({
			type: "DRAIN_OUTBOUND_QUEUE",
			payload: {
				accountId: command.accountId,
				operationId: command.operationId ?? command.id,
				claimId,
			},
		});
		if (!drainResponse?.success) {
			if (drainResponse?.code === "CLAIM_LOST") {
				await discardProjection(command);
			}
			throw new Error(drainResponse?.error ?? "Failed to drain Item command");
		}
	};
	let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
	const recoverStaged = async (): Promise<void> => {
		if (recoveryTimer) {
			clearTimeout(recoveryTimer);
			recoveryTimer = undefined;
		}
		const claimId = newClaimId();
		const response = await sendMessage({
			type: "CLAIM_STAGED_ITEM_COMMANDS",
			payload: { claimId },
		});
		if (!response?.success) {
			throw new Error(
				response?.error ?? "Failed to claim staged Item commands",
			);
		}
		for (const command of response.commands ?? []) {
			await finishProjection(command, claimId);
		}
		if (
			(response.commands?.length ?? 0) === 0 &&
			response.nextClaimAt !== undefined
		) {
			recoveryTimer = setTimeout(
				() => {
					void recoverStaged().catch(() => undefined);
				},
				Math.max(0, response.nextClaimAt - Date.now()),
			);
		}
	};

	return {
		enqueue: async (command) => {
			const claimId = newClaimId();
			const response = await sendMessage({
				type: "ENQUEUE_ITEM_COMMAND",
				payload: { command, claimId },
			});
			if (!response?.success) {
				throw new Error(response?.error ?? "Failed to queue Item command");
			}
			await finishProjection(command, claimId);
		},
		recoverStaged,
	};
}
