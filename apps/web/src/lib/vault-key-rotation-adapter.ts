import { type ApiClient, ApiError } from "@bittery/api-contract";
import type {
	RotationIntent,
	RotationPageOutput,
	RotationPayloadByKind,
	RotationPlanClient,
	RotationPreparationKind,
	RotationPreparationPage,
} from "@bittery/core/services/vault-key-rotation";
import type { VaultKeyData } from "@bittery/storage";

export interface WireRotationPreparationPage {
	records: readonly {
		id: string;
		expectedVersion: number;
		payload: string;
	}[];
	nextCursor?: string | null;
}

export interface RotationLocalStateDeps {
	getAccountId(): Promise<string | null>;
	getVaultKeys(accountId: string): Promise<VaultKeyData[] | null>;
	storeVaultKeys(
		keys: readonly VaultKeyData[],
		accountId: string,
	): Promise<void>;
	removeCachedVault(vaultId: string, accountId: string): Promise<void>;
	refreshFromServer(accountId: string): Promise<void>;
}

export type WebRotationIntent =
	| { kind: "vault-member-removal"; vaultId: string; userId: string }
	| { kind: "team-member-removal"; teamId: string; userId: string }
	| { kind: "team-leave"; teamId: string };

export async function executeWithIdempotentReplay<T>(
	request: (idempotencyKey: string) => Promise<T>,
	idempotencyKey: string = crypto.randomUUID(),
): Promise<T> {
	try {
		return await request(idempotencyKey);
	} catch (error) {
		if (error instanceof ApiError && !error.retryable) throw error;
		return request(idempotencyKey);
	}
}

function webIntent(intent: RotationIntent): WebRotationIntent {
	if (
		intent.kind === "vault-member-removal" ||
		intent.kind === "team-member-removal" ||
		intent.kind === "team-leave"
	) {
		return intent as WebRotationIntent;
	}
	throw new Error(`Unsupported Key rotation intent: ${intent.kind}`);
}

export function createWebRotationPlanClient(
	api: ApiClient,
	localState: ReturnType<typeof createRotationLocalState>,
): RotationPlanClient {
	return {
		async start(intent, signal) {
			const input = webIntent(intent);
			const result = await executeWithIdempotentReplay((idempotencyKey) => {
				const write = { idempotencyKey };
				return input.kind === "vault-member-removal"
					? api.vaults.members.startRemovalRotation(
							input.vaultId,
							input.userId,
							write,
							signal,
						)
					: input.kind === "team-member-removal"
						? api.teams.members.startRemovalRotation(
								input.teamId,
								input.userId,
								write,
								signal,
							)
						: api.teams.startLeaveRotation(input.teamId, write, signal);
			});
			return result.data.plans.map((plan) => ({
				planId: plan.id,
				vaultId: plan.vaultId,
				expectedKeyVersion: plan.expectedKeyVersion,
			}));
		},
		getPreparationPage: async (planId, kind, cursor, signal) =>
			decodeRotationPreparationPage(
				kind,
				(
					await api.vaultKeyRotation.preparationPage(
						planId,
						kind,
						cursor,
						signal,
					)
				).data,
			) as never,
		stage: async (planId, output, signal) => {
			await api.vaultKeyRotation.stage(
				planId,
				output.kind,
				{ outputs: encodeRotationStageOutput(output as never) },
				signal,
			);
		},
		async finalize({ intent, plans }, signal) {
			const input = webIntent(intent);
			const body = { planIds: plans.map(({ planId }) => planId) };
			const result = await executeWithIdempotentReplay((idempotencyKey) => {
				const write = { idempotencyKey };
				return input.kind === "vault-member-removal"
					? api.vaults.members.finalizeRemovalRotation(
							input.vaultId,
							input.userId,
							body,
							write,
							signal,
						)
					: input.kind === "team-member-removal"
						? api.teams.members.finalizeRemovalRotation(
								input.teamId,
								input.userId,
								body,
								write,
								signal,
							)
						: api.teams.finalizeLeaveRotation(
								input.teamId,
								body,
								write,
								signal,
							);
			});
			const rotationId =
				result.data.rotations[0]?.rotationId ??
				result.data.personalTeamId ??
				undefined;
			if (!rotationId)
				throw new Error("Key rotation finalized without a rotation outcome.");
			return { rotationId };
		},
		refresh: (vaultIds) => localState.refresh(vaultIds),
		markUnavailable: (vaultIds) => localState.markUnavailable(vaultIds),
	};
}

export function createRotationLocalState(deps: RotationLocalStateDeps) {
	const markUnavailable = async (vaultIds: readonly string[]) => {
		const accountId = await deps.getAccountId();
		if (!accountId) {
			throw new Error("No active account is available for Key rotation.");
		}
		const unavailable = new Set(vaultIds);
		const keys = await deps.getVaultKeys(accountId);
		if (keys) {
			await deps.storeVaultKeys(
				keys.filter(({ vaultId }) => !unavailable.has(vaultId)),
				accountId,
			);
		}
		await Promise.all(
			vaultIds.map((vaultId) => deps.removeCachedVault(vaultId, accountId)),
		);
		return accountId;
	};

	return {
		markUnavailable: async (vaultIds: readonly string[]) => {
			await markUnavailable(vaultIds);
		},
		refresh: async (vaultIds: readonly string[]) => {
			// Server commit is authoritative. Stale keys, Items and Attachment envelopes must
			// become unreadable before the network refresh begins, including while it retries.
			const accountId = await markUnavailable(vaultIds);
			try {
				await deps.refreshFromServer(accountId);
			} catch {
				await deps.refreshFromServer(accountId);
			}
		},
	};
}

type WireMember = {
	userId: string;
	publicKey: string;
};

type WireItem = {
	id: string;
	vaultId: string;
	encryptedData: string;
	encryptionIv: string;
	encryptionAlgorithm: string;
	encryptionVersion: number;
	encryptedByUserId: string;
};

type WireAttachment = {
	attachmentId: string;
	vaultId: string;
	uploadedBy: string;
	encryptedAttachmentKey: string;
	attachmentKeyIv: string;
	attachmentKeyAlgorithm: string;
	envelopeVersion: number;
};

function parsePayload<T>(payload: string): T {
	return JSON.parse(payload) as T;
}

export function decodeRotationPreparationPage(
	kind: "member",
	page: WireRotationPreparationPage,
): RotationPreparationPage<RotationPayloadByKind["member"]>;
export function decodeRotationPreparationPage(
	kind: "item",
	page: WireRotationPreparationPage,
): RotationPreparationPage<RotationPayloadByKind["item"]>;
export function decodeRotationPreparationPage(
	kind: "attachment",
	page: WireRotationPreparationPage,
): RotationPreparationPage<RotationPayloadByKind["attachment"]>;
export function decodeRotationPreparationPage(
	kind: RotationPreparationKind,
	page: WireRotationPreparationPage,
): RotationPreparationPage<RotationPayloadByKind[RotationPreparationKind]>;
export function decodeRotationPreparationPage(
	kind: RotationPreparationKind,
	page: WireRotationPreparationPage,
): RotationPreparationPage<RotationPayloadByKind[RotationPreparationKind]> {
	return {
		records: page.records.map((record) => {
			const base = { id: record.id, expectedVersion: record.expectedVersion };
			if (kind === "member") {
				const payload = parsePayload<WireMember>(record.payload);
				return {
					...base,
					payload: { userId: payload.userId, publicKey: payload.publicKey },
				};
			}
			if (kind === "item") {
				const payload = parsePayload<WireItem>(record.payload);
				return {
					...base,
					payload: {
						id: payload.id,
						encryptedData: payload.encryptedData,
						encryptionIv: payload.encryptionIv,
						encryptionAlgorithm: payload.encryptionAlgorithm,
						context: {
							vaultId: payload.vaultId,
							entityId: payload.id,
							entityType: "item" as const,
							version: payload.encryptionVersion,
							userId: payload.encryptedByUserId,
						},
					},
				};
			}
			const payload = parsePayload<WireAttachment>(record.payload);
			return {
				...base,
				payload: {
					attachmentId: payload.attachmentId,
					encryptedAttachmentKey: {
						ciphertext: payload.encryptedAttachmentKey,
						iv: payload.attachmentKeyIv,
						algorithm: payload.attachmentKeyAlgorithm,
					},
					context: {
						vaultId: payload.vaultId,
						entityId: payload.attachmentId,
						entityType: "attachment_key" as const,
						version: payload.envelopeVersion,
						userId: payload.uploadedBy,
					},
				},
			};
		}),
		nextCursor: page.nextCursor ?? null,
	};
}

export function encodeRotationStageOutput<K extends RotationPreparationKind>(
	output: RotationPageOutput<RotationPayloadByKind[K]>,
): Array<{ id: string; payload: string }> {
	return output.records.map((record) => {
		if (output.kind === "member") {
			const payload = record.payload as RotationPayloadByKind["member"];
			return { id: record.id, payload: JSON.stringify(payload) };
		}
		if (output.kind === "item") {
			const payload = record.payload as RotationPayloadByKind["item"];
			return {
				id: record.id,
				payload: JSON.stringify({
					itemId: payload.id,
					encryptedData: payload.encryptedData,
					encryptionIv: payload.encryptionIv,
					encryptionAlgorithm: payload.encryptionAlgorithm,
				}),
			};
		}
		const payload = record.payload as RotationPayloadByKind["attachment"];
		return {
			id: record.id,
			payload: JSON.stringify({
				attachmentId: payload.attachmentId,
				encryptedAttachmentKey: payload.encryptedAttachmentKey.ciphertext,
				attachmentKeyIv: payload.encryptedAttachmentKey.iv,
				attachmentKeyAlgorithm: payload.encryptedAttachmentKey.algorithm,
				vaultId: payload.context.vaultId,
				uploadedBy: payload.context.userId,
				envelopeVersion: payload.context.version,
			}),
		};
	});
}
