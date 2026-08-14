import { ApiError, isApiErrorStatus } from "@bittery/api-contract";
import type { CryptoPort, KeyRef } from "@bittery/crypto-port";
import type { ItemSyncAcknowledgement, ItemSyncCommand } from "@bittery/types";
import type { DefaultApiClient } from "./account-resolver";
import type { DecryptedAttachmentParts } from "./attachment-crypto";
import {
	createAttachmentKeyEnvelope,
	decryptAttachmentParts,
	encodeAttachmentBlobEnvelope,
	encryptAttachmentParts,
	parseAttachmentBlobEnvelope,
	unwrapAttachmentKey,
} from "./attachment-crypto";
import type { VaultCrypto } from "./vault-crypto";

type SourceAttachment = Awaited<
	ReturnType<DefaultApiClient["attachments"]["list"]>
>["data"][number];

interface AttachmentMigrationPlan {
	attachments: readonly SourceAttachment[];
	sourceVaultKey: KeyRef;
	targetVaultKey: KeyRef;
	targetUserId: string;
}

function strongItemEtag(version: number): string {
	return `"${version}"`;
}

export interface CrossAccountItemCommandExecutorOptions {
	crypto: CryptoPort;
	vaultCrypto: VaultCrypto;
	getClientForAccount(accountId: string): Promise<DefaultApiClient>;
}

/**
 * Executes the one Item command that cannot be expressed as a single-account
 * HTTP mutation. Queue replay owns retries; this module owns only the durable,
 * idempotent source/target choreography and attachment re-encryption.
 */
export class CrossAccountItemCommandExecutor {
	constructor(
		private readonly options: CrossAccountItemCommandExecutorOptions,
	) {}

	private async getVaultKey(
		vaultId: string,
		accountId: string,
	): Promise<KeyRef | null> {
		return this.options.vaultCrypto.getVaultKey({ vaultId, accountId });
	}

	private async prepareAttachmentMigration(input: {
		sourceClient: DefaultApiClient;
		sourceItemId: string;
		sourceVaultId: string;
		sourceAccountId: string;
		targetVaultId: string;
		targetAccountId: string;
		targetUserId: string;
	}): Promise<AttachmentMigrationPlan | null> {
		const { data: attachments } = await input.sourceClient.attachments.list(
			input.sourceItemId,
		);
		if (attachments.length === 0) return null;
		const sourceVaultKey = await this.getVaultKey(
			input.sourceVaultId,
			input.sourceAccountId,
		);
		if (!sourceVaultKey) {
			throw new Error(
				"Cannot access the source vault key to migrate attachments. Please unlock the source account.",
			);
		}

		try {
			const targetVaultKey = await this.getVaultKey(
				input.targetVaultId,
				input.targetAccountId,
			);
			if (!targetVaultKey) {
				throw new Error(
					"Cannot access target vault key for cross-account move",
				);
			}

			return {
				attachments,
				sourceVaultKey,
				targetVaultKey,
				targetUserId: input.targetUserId,
			};
		} catch (error) {
			await this.options.crypto.destroyKey(sourceVaultKey);
			throw error;
		}
	}

	private async probeItem(client: DefaultApiClient, itemId: string) {
		try {
			return await client.items.get(itemId);
		} catch (error) {
			if (isApiErrorStatus(error, 404)) return null;
			throw error;
		}
	}

	private sourceConflict(itemId: string): ApiError {
		return new ApiError(
			{
				type: "https://bittery.com/problems/precondition-failed",
				title: "Precondition Failed",
				status: 412,
				code: "PRECONDITION_FAILED",
				detail: `Item ${itemId} changed before its cross-account move completed`,
			},
			null,
		);
	}

	private async clearTargetAttachments(
		client: DefaultApiClient,
		itemId: string,
		operationId: string,
	): Promise<void> {
		const { data: attachments } = await client.attachments.list(itemId);
		for (const attachment of attachments ?? []) {
			try {
				await client.attachments.remove(attachment.id, {
					idempotencyKey: `${operationId}:clear-attachment:${attachment.id}`,
				});
			} catch (error) {
				if (!isApiErrorStatus(error, 404)) throw error;
			}
		}
	}

	private async migrateAttachments(input: {
		sourceClient: DefaultApiClient;
		targetClient: DefaultApiClient;
		targetItemId: string;
		sourceVaultId: string;
		targetVaultId: string;
		attachments: readonly SourceAttachment[];
		sourceVaultKey: KeyRef;
		targetVaultKey: KeyRef;
		targetUserId: string;
		attachmentAttemptId: string;
	}): Promise<void> {
		for (const attachment of input.attachments) {
			const { data: download } =
				await input.sourceClient.attachments.createDownloadUrl(attachment.id);
			const response = await fetch(download.downloadUrl);
			if (!response.ok)
				throw new Error(
					`Failed to download attachment ${attachment.id} during cross-account move.`,
				);
			const blobEnvelope = parseAttachmentBlobEnvelope(await response.text());
			const sourceScope = {
				vaultId: input.sourceVaultId,
				attachmentId: attachment.id,
				userId: attachment.uploadedBy,
				envelopeVersion: attachment.envelopeVersion,
			};
			const sourceAttachmentKey = await unwrapAttachmentKey(
				this.options.vaultCrypto,
				input.sourceVaultKey,
				sourceScope,
				attachment,
			);
			let decrypted: DecryptedAttachmentParts;
			try {
				decrypted = await decryptAttachmentParts(
					this.options.vaultCrypto,
					sourceAttachmentKey,
					sourceScope,
					{
						blobEnvelope,
						encryptedName: attachment.encryptedName,
						encryptedContentType: attachment.encryptedContentType,
						encryptionIv: attachment.encryptionIv,
						encryptedContentTypeIv: attachment.encryptedContentTypeIv,
						encryptionAlgorithm: attachment.encryptionAlgorithm,
					},
				);
			} finally {
				await this.options.crypto.destroyKey(sourceAttachmentKey);
			}

			const { data: upload } =
				await input.targetClient.attachments.createUpload(input.targetItemId, {
					fileName: `${globalThis.crypto?.randomUUID?.() ?? Date.now()}.enc`,
					contentType: "application/octet-stream",
					fileSize: attachment.fileSize,
				});
			const targetScope = {
				vaultId: input.targetVaultId,
				attachmentId: upload.attachmentId,
				userId: input.targetUserId,
				envelopeVersion: 1,
			};
			const targetAttachment = await createAttachmentKeyEnvelope(
				this.options.vaultCrypto,
				input.targetVaultKey,
				targetScope,
			);
			try {
				const encrypted = await encryptAttachmentParts(
					this.options.vaultCrypto,
					targetAttachment.key,
					targetScope,
					decrypted,
				);
				const put = await fetch(upload.uploadUrl, {
					method: "PUT",
					headers: { "Content-Type": "application/octet-stream" },
					body: encodeAttachmentBlobEnvelope(encrypted.blobEnvelope),
				});
				if (!put.ok)
					throw new Error(
						`Failed to upload migrated attachment for item ${input.targetItemId}.`,
					);
				await input.targetClient.attachments.create(
					input.targetItemId,
					{
						attachmentId: upload.attachmentId,
						storageKey: upload.key,
						...targetAttachment.encryptedAttachmentKey,
						encryptedName: encrypted.encryptedName,
						encryptedContentType: encrypted.encryptedContentType,
						encryptionIv: encrypted.encryptionIv,
						encryptedContentTypeIv: encrypted.encryptedContentTypeIv,
						encryptionAlgorithm: encrypted.encryptionAlgorithm,
						fileSize: attachment.fileSize,
					},
					{
						idempotencyKey: `${input.attachmentAttemptId}:attachment:${attachment.id}`,
					},
				);
			} finally {
				await this.options.crypto.destroyKey(targetAttachment.key);
			}
		}
	}

	async executeSemanticItemCommand(
		command: ItemSyncCommand,
	): Promise<ItemSyncAcknowledgement | undefined> {
		if (command.type !== "cross_account_move") return undefined;
		const payload = command.encryptedPayload;
		const targetAccountId = command.targetAccountId;
		const targetVaultId = command.targetVaultId;
		const targetItemId = command.targetItemId;
		const operationId = command.operationId ?? command.id;
		if (
			!payload ||
			!command.category ||
			!targetAccountId ||
			!targetVaultId ||
			!targetItemId
		) {
			throw new Error(`Invalid cross-account move command ${operationId}`);
		}

		const [sourceClient, targetClient] = await Promise.all([
			this.options.getClientForAccount(command.accountId),
			this.options.getClientForAccount(targetAccountId),
		]);
		const [source, target] = await Promise.all([
			this.probeItem(sourceClient, command.entityId),
			this.probeItem(targetClient, targetItemId),
		]);
		if (
			target &&
			(target.data.vaultId !== targetVaultId ||
				target.data.category !== command.category ||
				target.data.encryptedData !== payload.encryptedData ||
				target.data.encryptionIv !== payload.encryptionIv ||
				target.data.encryptionAlgorithm !== payload.encryptionAlgorithm)
		)
			throw new Error(
				`Deterministic target ${targetItemId} does not match move`,
			);

		if (!source) {
			if (!target)
				throw new Error(
					`Cross-account move ${operationId} lost both source and target Items`,
				);
			return {
				entityId: command.entityId,
				etag: `"${command.baseVersion + 2}"`,
				version: command.baseVersion + 2,
			};
		}
		const sourceVersion = source.data.version;
		if (source.data.deletedAt) {
			if (sourceVersion !== command.baseVersion + 1 || !target)
				throw this.sourceConflict(command.entityId);
			await sourceClient.items.deletePermanently(command.entityId, {
				etag: strongItemEtag(sourceVersion),
				idempotencyKey: `${operationId}:delete-source`,
			});
			return {
				entityId: command.entityId,
				etag: `"${sourceVersion + 1}"`,
				version: sourceVersion + 1,
			};
		}
		if (sourceVersion !== command.baseVersion)
			throw this.sourceConflict(command.entityId);

		const migration = await this.prepareAttachmentMigration({
			sourceClient,
			sourceItemId: command.entityId,
			sourceVaultId: command.vaultId,
			sourceAccountId: command.accountId,
			targetVaultId,
			targetAccountId,
			targetUserId: payload.encryptedByUserId,
		});
		try {
			if (target)
				await this.clearTargetAttachments(
					targetClient,
					targetItemId,
					operationId,
				);
			else {
				await targetClient.items.create(
					targetVaultId,
					targetItemId,
					{
						category: command.category,
						encryptedData: payload.encryptedData,
						encryptionIv: payload.encryptionIv,
						encryptionAlgorithm: payload.encryptionAlgorithm,
					},
					{ idempotencyKey: `${operationId}:create-target` },
				);
			}

			if (migration) {
				await this.migrateAttachments({
					sourceClient,
					targetClient,
					targetItemId,
					sourceVaultId: command.vaultId,
					targetVaultId,
					...migration,
					attachmentAttemptId: command.attemptId ?? command.id,
				});
			}
		} finally {
			if (migration) {
				try {
					await this.options.crypto.destroyKey(migration.targetVaultKey);
				} finally {
					await this.options.crypto.destroyKey(migration.sourceVaultKey);
				}
			}
		}
		await sourceClient.items.trash(command.entityId, {
			etag: strongItemEtag(command.baseVersion),
			idempotencyKey: `${operationId}:trash-source`,
		});
		await sourceClient.items.deletePermanently(command.entityId, {
			etag: strongItemEtag(command.baseVersion + 1),
			idempotencyKey: `${operationId}:delete-source`,
		});
		return {
			entityId: command.entityId,
			etag: `"${command.baseVersion + 2}"`,
			version: command.baseVersion + 2,
		};
	}
}
