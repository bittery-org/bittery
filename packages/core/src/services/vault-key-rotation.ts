/**
 * The shared Vault key rotation ceremony.
 *
 * This module owns no HTTP endpoint spelling and stores no resume state. Its `client` is the
 * narrow generated-client-shaped network port which policy callers adapt to their eventual
 * routes. Every old Vault key returned by `openVaultKey` and every newly generated Vault key is
 * caller-owned by this ceremony and retired on success, failure, cancellation and lock.
 */

import type {
	CryptoPort,
	EncryptedData,
	EncryptionContext,
	ItemData,
	KeyRef,
	MemberKeyData,
} from "@bittery/crypto-port";

export interface RotationPlan {
	planId: string;
	vaultId: string;
	/** The authoritative Vault-key version this plan snapshots. */
	expectedKeyVersion: number;
}

export interface RotationAttachmentEnvelope {
	attachmentId: string;
	encryptedAttachmentKey: EncryptedData;
	/** The current Attachment-key-envelope AAD, including its envelope version. */
	context: EncryptionContext;
}

export type RotationPreparationKind = "member" | "item" | "attachment";

export interface RotationPageRecord<Payload> {
	id: string;
	expectedVersion: number;
	payload: Payload;
}

export interface RotationPreparationPage<Payload> {
	records: readonly RotationPageRecord<Payload>[];
	nextCursor: string | null;
}

export interface RotationPayloadByKind {
	member: MemberKeyData;
	item: ItemData;
	attachment: RotationAttachmentEnvelope;
}

export interface RotationPageOutput<Payload> {
	kind: RotationPreparationKind;
	cursor: string;
	records: readonly RotationPageRecord<Payload>[];
}

/** Policy is opaque to the ceremony; server adapters carry it to start/finalize unchanged. */
export interface RotationIntent {
	kind: string;
	[key: string]: unknown;
}

export interface RotationPlanClient {
	start(
		intent: RotationIntent,
		signal: AbortSignal,
	): Promise<readonly RotationPlan[]>;
	getPreparationPage(
		planId: string,
		kind: "member",
		cursor: string | null,
		signal: AbortSignal,
	): Promise<RotationPreparationPage<MemberKeyData>>;
	getPreparationPage(
		planId: string,
		kind: "item",
		cursor: string | null,
		signal: AbortSignal,
	): Promise<RotationPreparationPage<ItemData>>;
	getPreparationPage(
		planId: string,
		kind: "attachment",
		cursor: string | null,
		signal: AbortSignal,
	): Promise<RotationPreparationPage<RotationAttachmentEnvelope>>;
	stage<Payload>(
		planId: string,
		output: RotationPageOutput<Payload>,
		signal: AbortSignal,
	): Promise<void>;
	finalize(
		input: {
			intent: RotationIntent;
			plans: readonly RotationPlan[];
		},
		signal: AbortSignal,
	): Promise<{ rotationId: string }>;
	/** Reload authoritative keys, Items and Attachment envelopes after the server commits. */
	refresh(vaultIds: readonly string[], signal: AbortSignal): Promise<void>;
	/** Fail closed when that authoritative reload did not succeed. */
	markUnavailable(vaultIds: readonly string[]): Promise<void>;
}

export interface VaultKeyRotationDeps {
	crypto: Pick<
		CryptoPort,
		| "destroyKey"
		| "encryptVaultKeyForMember"
		| "encryptVaultKeyWithMuk"
		| "generateEncryptionKey"
		| "reEncryptItem"
		| "rewrapAttachmentKey"
	>;
	/** Returns a fresh, ceremony-owned ref; it is always destroyed by this module. */
	openVaultKey(vaultId: string): Promise<KeyRef>;
	/** Returns a store-owned ref. The ceremony borrows it and never destroys it. */
	getMasterUnlockKey(): Promise<KeyRef | null>;
	client: RotationPlanClient;
	/** Subscribe to account lock. The returned function must unsubscribe. */
	onLock?(listener: () => void): () => void;
}

export interface RotateVaultKeysInput {
	intent: RotationIntent;
	/** The user whose own Vault-key copy must be wrapped under the borrowed MUK. */
	currentUserId: string;
}

export type VaultKeyRotationOutcome =
	| { kind: "completed"; rotationId: string }
	| { kind: "refresh_required"; rotationId: string; cause: unknown };

export class VaultKeyRotationCancelledError extends Error {
	constructor() {
		super("Vault key rotation was cancelled because the account locked.");
		this.name = "VaultKeyRotationCancelledError";
	}
}

function nextAttachmentEnvelopeContext(
	context: EncryptionContext,
): EncryptionContext {
	if (context.entityType !== "attachment_key") {
		throw new Error(
			"Rotation Attachment envelope has an invalid encryption context.",
		);
	}
	if (!Number.isSafeInteger(context.version) || context.version < 1) {
		throw new Error("Rotation Attachment envelope has an invalid version.");
	}
	return { ...context, version: context.version + 1 };
}

export interface VaultKeyRotationCeremony {
	rotate(input: RotateVaultKeysInput): Promise<VaultKeyRotationOutcome>;
}

export function createVaultKeyRotationCeremony(
	deps: VaultKeyRotationDeps,
): VaultKeyRotationCeremony {
	return {
		async rotate({ intent, currentUserId }) {
			const controller = new AbortController();
			let ownedOldVaultKey: KeyRef | null = null;
			let ownedNewVaultKey: KeyRef | null = null;
			let cleanup = Promise.resolve();
			const activeCryptoCalls = new Set<Promise<unknown>>();
			const runCrypto = async <Result>(operation: () => Promise<Result>) => {
				const call = operation();
				activeCryptoCalls.add(call);
				try {
					return await call;
				} finally {
					activeCryptoCalls.delete(call);
				}
			};
			const retireOwnedRefs = () => {
				const refs = [ownedNewVaultKey, ownedOldVaultKey].filter(
					(ref): ref is KeyRef => ref !== null,
				);
				ownedNewVaultKey = null;
				ownedOldVaultKey = null;
				if (refs.length > 0) {
					const callsUsingRefs = [...activeCryptoCalls];
					cleanup = cleanup.then(async () => {
						await Promise.allSettled(callsUsingRefs);
						await Promise.allSettled(
							refs.map((ref) => deps.crypto.destroyKey(ref)),
						);
					});
				}
				return cleanup;
			};
			const stopListening = deps.onLock?.(() => {
				controller.abort(new VaultKeyRotationCancelledError());
				void retireOwnedRefs();
			});
			const assertActive = () => {
				if (controller.signal.aborted) {
					throw controller.signal.reason;
				}
			};

			try {
				assertActive();
				const plans = await deps.client.start(intent, controller.signal);
				assertActive();
				const masterUnlockKey = await deps.getMasterUnlockKey();
				assertActive();

				for (const plan of plans) {
					try {
						ownedOldVaultKey = await deps.openVaultKey(plan.vaultId);
						assertActive();
						ownedNewVaultKey = await deps.crypto.generateEncryptionKey();
						assertActive();

						const oldKey = ownedOldVaultKey;
						const newKey = ownedNewVaultKey;
						let cursor: string | null = null;
						do {
							const page: RotationPreparationPage<MemberKeyData> =
								await deps.client.getPreparationPage(
									plan.planId,
									"member",
									cursor,
									controller.signal,
								);
							assertActive();
							if (
								masterUnlockKey === null &&
								page.records.some(
									(record) => record.payload.userId === currentUserId,
								)
							) {
								throw new Error("The account is locked.");
							}
							const records = await Promise.all(
								page.records.map(async (record) => ({
									...record,
									payload: {
										userId: record.payload.userId,
										encryptedVaultKey:
											record.payload.userId === currentUserId
												? await runCrypto(() =>
														deps.crypto.encryptVaultKeyWithMuk(
															newKey,
															masterUnlockKey as KeyRef,
															plan.vaultId,
															currentUserId,
															plan.expectedKeyVersion + 1,
														),
													)
												: await runCrypto(() =>
														deps.crypto.encryptVaultKeyForMember(
															newKey,
															record.payload.publicKey,
														),
													),
									},
								})),
							);
							if (records.length > 0) {
								await deps.client.stage(
									plan.planId,
									{
										kind: "member",
										cursor: cursor ?? "initial",
										records,
									},
									controller.signal,
								);
							}
							assertActive();
							cursor = page.nextCursor;
						} while (cursor !== null);

						cursor = null;
						do {
							const page: RotationPreparationPage<ItemData> =
								await deps.client.getPreparationPage(
									plan.planId,
									"item",
									cursor,
									controller.signal,
								);
							assertActive();
							const records = await Promise.all(
								page.records.map(async (record) => {
									const reEncrypted = await runCrypto(() =>
										deps.crypto.reEncryptItem(record.payload, oldKey, newKey),
									);
									return {
										...record,
										payload: {
											...record.payload,
											encryptedData: reEncrypted.encryptedData,
											encryptionIv: reEncrypted.encryptionIv,
										},
									};
								}),
							);
							if (records.length > 0) {
								await deps.client.stage(
									plan.planId,
									{
										kind: "item",
										records,
										cursor: cursor ?? "initial",
									},
									controller.signal,
								);
							}
							assertActive();
							cursor = page.nextCursor;
						} while (cursor !== null);

						cursor = null;
						do {
							const page: RotationPreparationPage<RotationAttachmentEnvelope> =
								await deps.client.getPreparationPage(
									plan.planId,
									"attachment",
									cursor,
									controller.signal,
								);
							assertActive();
							const records = await Promise.all(
								page.records.map(async (record) => {
									const context = nextAttachmentEnvelopeContext(
										record.payload.context,
									);
									return {
										...record,
										payload: {
											attachmentId: record.payload.attachmentId,
											encryptedAttachmentKey: await runCrypto(() =>
												deps.crypto.rewrapAttachmentKey(
													record.payload.encryptedAttachmentKey,
													oldKey,
													newKey,
													record.payload.context,
													context,
												),
											),
											context,
										},
									};
								}),
							);
							if (records.length > 0) {
								await deps.client.stage(
									plan.planId,
									{
										kind: "attachment",
										cursor: cursor ?? "initial",
										records,
									},
									controller.signal,
								);
							}
							assertActive();
							cursor = page.nextCursor;
						} while (cursor !== null);
					} finally {
						await retireOwnedRefs();
					}
				}

				assertActive();
				const finalized = await deps.client.finalize(
					{ intent, plans },
					controller.signal,
				);
				const vaultIds = plans.map((plan) => plan.vaultId);
				try {
					await deps.client.refresh(vaultIds, controller.signal);
					return { kind: "completed", rotationId: finalized.rotationId };
				} catch (cause) {
					// Finalization is already authoritative. A lock/abort at this point may
					// cancel the refresh, but it cannot cancel the committed rotation.
					await deps.client.markUnavailable(vaultIds);
					return {
						kind: "refresh_required",
						rotationId: finalized.rotationId,
						cause,
					};
				}
			} finally {
				stopListening?.();
				await retireOwnedRefs();
			}
		},
	};
}
