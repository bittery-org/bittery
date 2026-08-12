import { describe, expect, test } from "bun:test";
import type { EncryptionContext, ItemData, KeyRef } from "@bittery/crypto-port";
import { createInMemoryCryptoPort } from "@bittery/crypto-port/testing";
import {
	createVaultKeyRotationCeremony,
	type RotationPlanClient,
} from "./vault-key-rotation";

const attachmentContext: EncryptionContext = {
	vaultId: "vault-1",
	entityId: "attachment-1",
	entityType: "attachment_key",
	version: 1,
	userId: "owner",
};

function itemContext(itemId: string): EncryptionContext {
	return { ...attachmentContext, entityId: itemId, entityType: "item" };
}

function item(
	id: string,
	encrypted: {
		ciphertext: string;
		iv: string;
		algorithm: string;
	},
): ItemData {
	return {
		id,
		encryptedData: encrypted.ciphertext,
		encryptionIv: encrypted.iv,
		encryptionAlgorithm: encrypted.algorithm,
		context: itemContext(id),
	};
}

describe("VaultKeyRotationCeremony", () => {
	test("uses one new vault key across preparation pages", async () => {
		const crypto = createInMemoryCryptoPort();
		const oldVaultKey = await crypto.generateEncryptionKey();
		const masterUnlockKey = await crypto.generateEncryptionKey();
		const firstMember = await crypto.generateRsaKeyPair();
		const secondMember = await crypto.generateRsaKeyPair();
		const attachmentKey = await crypto.generateEncryptionKey();
		const attachmentEnvelope = await crypto.encrypt(
			btoa(String.fromCharCode(...(await crypto.exportKey(attachmentKey)))),
			oldVaultKey,
			attachmentContext,
		);
		const first = item(
			"item-1",
			await crypto.encrypt("first", oldVaultKey, itemContext("item-1")),
		);
		const second = item(
			"item-2",
			await crypto.encrypt("second", oldVaultKey, itemContext("item-2")),
		);
		const staged: unknown[] = [];
		const client = {
			start: async () => [
				{ planId: "plan-1", vaultId: "vault-1", expectedKeyVersion: 1 },
			],
			getPreparationPage: async (
				_planId: string,
				kind: string,
				cursor: string | null,
			) => {
				if (kind === "member") {
					return cursor === null
						? {
								records: [
									{
										id: "member-1",
										expectedVersion: 1,
										payload: {
											userId: "member-1",
											publicKey: firstMember.publicKey,
										},
									},
								],
								nextCursor: "second",
							}
						: {
								records: [
									{
										id: "member-2",
										expectedVersion: 1,
										payload: {
											userId: "member-2",
											publicKey: secondMember.publicKey,
										},
									},
								],
								nextCursor: null,
							};
				}
				if (kind === "item") {
					return cursor === null
						? {
								records: [{ id: first.id, expectedVersion: 1, payload: first }],
								nextCursor: "second",
							}
						: {
								records: [
									{ id: second.id, expectedVersion: 1, payload: second },
								],
								nextCursor: null,
							};
				}
				return {
					records:
						cursor === null
							? [
									{
										id: "attachment-1",
										expectedVersion: 1,
										payload: {
											attachmentId: "attachment-1",
											encryptedAttachmentKey: attachmentEnvelope,
											context: attachmentContext,
										},
									},
								]
							: [],
					nextCursor: null,
				};
			},
			stage: async (_planId: string, output: unknown) => {
				staged.push(output);
			},
			finalize: async () => ({ rotationId: "rotation-1" }),
			refresh: async () => {},
			markUnavailable: async () => {},
		} as RotationPlanClient;
		const ceremony = createVaultKeyRotationCeremony({
			crypto,
			openVaultKey: async () => oldVaultKey,
			getMasterUnlockKey: async () => masterUnlockKey,
			client,
		});

		await ceremony.rotate({
			intent: { kind: "member-removal" },
			currentUserId: "owner",
		});

		expect(staged).toHaveLength(5);
		const outputs = staged as Array<{
			kind: string;
			records: Array<{
				payload: {
					encryptedVaultKey?: string;
					itemId?: string;
					id?: string;
					encryptionAlgorithm?: string;
					context?: EncryptionContext;
					attachmentId?: string;
				};
			}>;
		}>;
		const memberOutputs = outputs.filter(({ kind }) => kind === "member");
		const itemOutputs = outputs.filter(({ kind }) => kind === "item");
		const attachmentOutput = outputs.find(({ kind }) => kind === "attachment");
		const firstEncryptedKey =
			memberOutputs[0]?.records[0]?.payload.encryptedVaultKey;
		const secondEncryptedKey =
			memberOutputs[1]?.records[0]?.payload.encryptedVaultKey;
		if (!firstEncryptedKey || !secondEncryptedKey || !attachmentOutput) {
			throw new Error("Expected every Rotation output kind to be staged.");
		}
		const firstNewKey = await crypto.rsaDecrypt(
			firstEncryptedKey,
			firstMember.privateKey,
		);
		const secondNewKey = await crypto.rsaDecrypt(
			secondEncryptedKey,
			secondMember.privateKey,
		);
		expect(firstNewKey).toBe(secondNewKey);
		expect(
			itemOutputs.flatMap(({ records }) =>
				records.map(({ payload }) => ({
					id: payload.id,
					encryptionAlgorithm: payload.encryptionAlgorithm,
					context: payload.context,
				})),
			),
		).toEqual([
			{
				id: "item-1",
				encryptionAlgorithm: first.encryptionAlgorithm,
				context: first.context,
			},
			{
				id: "item-2",
				encryptionAlgorithm: second.encryptionAlgorithm,
				context: second.context,
			},
		]);
		expect(
			attachmentOutput.records.map(({ payload }) => payload.attachmentId),
		).toEqual(["attachment-1"]);
		expect(crypto.liveKeyCount).toBe(2);
	});

	test("a lock cancels preparation and retires its old and new vault refs", async () => {
		const crypto = createInMemoryCryptoPort();
		const masterUnlockKey = await crypto.generateEncryptionKey();
		let lock: (() => void) | undefined;
		let openedVaultKey: KeyRef | undefined;
		const ceremony = createVaultKeyRotationCeremony({
			crypto,
			openVaultKey: async () => {
				openedVaultKey = await crypto.generateEncryptionKey();
				return openedVaultKey;
			},
			getMasterUnlockKey: async () => masterUnlockKey,
			onLock: (listener) => {
				lock = listener;
				return () => {
					lock = undefined;
				};
			},
			client: {
				start: async () => [
					{ planId: "plan-1", vaultId: "vault-1", expectedKeyVersion: 1 },
				],
				getPreparationPage: async (_planId: string, kind: string) => {
					if (kind !== "item") {
						return { records: [], nextCursor: null };
					}
					if (!openedVaultKey) throw new Error("Vault key was not opened.");
					return {
						records: [
							{
								id: "item-1",
								expectedVersion: 1,
								payload: item(
									"item-1",
									await crypto.encrypt(
										"plain",
										openedVaultKey,
										itemContext("item-1"),
									),
								),
							},
						],
						nextCursor: null,
					};
				},
				stage: async () => lock?.(),
				finalize: async () => ({ rotationId: "never" }),
				refresh: async () => {},
				markUnavailable: async () => {},
			} as unknown as RotationPlanClient,
		});

		await expect(
			ceremony.rotate({
				intent: { kind: "member-removal" },
				currentUserId: "owner",
			}),
		).rejects.toMatchObject({
			name: "VaultKeyRotationCancelledError",
		});
		expect(openedVaultKey).toBeDefined();
		expect(crypto.liveKeyCount).toBe(1);
	});

	test("a lock aborts an in-flight preparation request and retires owned refs", async () => {
		const crypto = createInMemoryCryptoPort();
		const masterUnlockKey = await crypto.generateEncryptionKey();
		let lock: (() => void) | undefined;
		let requestSignal: AbortSignal | undefined;
		let requestStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			requestStarted = resolve;
		});
		const ceremony = createVaultKeyRotationCeremony({
			crypto,
			openVaultKey: async () => crypto.generateEncryptionKey(),
			getMasterUnlockKey: async () => masterUnlockKey,
			onLock: (listener) => {
				lock = listener;
				return () => {};
			},
			client: {
				start: async (_intent, signal) => {
					expect(signal.aborted).toBe(false);
					return [
						{ planId: "plan-1", vaultId: "vault-1", expectedKeyVersion: 1 },
					];
				},
				getPreparationPage: async (_planId, _kind, _cursor, signal) => {
					requestSignal = signal;
					requestStarted?.();
					return await new Promise((_, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason), {
							once: true,
						});
					});
				},
				stage: async () => {},
				finalize: async () => ({ rotationId: "never" }),
				refresh: async () => {},
				markUnavailable: async () => {},
			} as RotationPlanClient,
		});

		const rotation = ceremony.rotate({
			intent: { kind: "member-removal" },
			currentUserId: "owner",
		});
		await started;
		lock?.();

		await expect(rotation).rejects.toMatchObject({
			name: "VaultKeyRotationCancelledError",
		});
		expect(requestSignal?.aborted).toBe(true);
		expect(crypto.liveKeyCount).toBe(1);
	});

	test("attempts to retire both owned refs when either destruction fails", async () => {
		const crypto = createInMemoryCryptoPort();
		const masterUnlockKey = await crypto.generateEncryptionKey();
		const destroyed: KeyRef[] = [];
		let destroyCalls = 0;
		const ceremony = createVaultKeyRotationCeremony({
			crypto: {
				...crypto,
				destroyKey: async (key) => {
					destroyed.push(key);
					destroyCalls += 1;
					if (destroyCalls === 1) throw new Error("first destroy failed");
					await crypto.destroyKey(key);
				},
			},
			openVaultKey: async () => crypto.generateEncryptionKey(),
			getMasterUnlockKey: async () => masterUnlockKey,
			client: {
				start: async () => [
					{ planId: "plan-1", vaultId: "vault-1", expectedKeyVersion: 1 },
				],
				getPreparationPage: async () => ({ records: [], nextCursor: null }),
				stage: async () => {},
				finalize: async () => ({ rotationId: "rotation-1" }),
				refresh: async () => {},
				markUnavailable: async () => {},
			} as RotationPlanClient,
		});

		await ceremony.rotate({
			intent: { kind: "member-removal" },
			currentUserId: "owner",
		});

		expect(destroyed).toHaveLength(2);
		expect(new Set(destroyed).size).toBe(2);
		expect(crypto.liveKeyCount).toBe(2);
	});

	test("keeps the vault unavailable when authoritative refresh fails after finalization", async () => {
		const crypto = createInMemoryCryptoPort();
		const masterUnlockKey = await crypto.generateEncryptionKey();
		const unavailable: string[][] = [];
		const ceremony = createVaultKeyRotationCeremony({
			crypto,
			openVaultKey: async () => crypto.generateEncryptionKey(),
			getMasterUnlockKey: async () => masterUnlockKey,
			client: {
				start: async () => [
					{ planId: "plan-1", vaultId: "vault-1", expectedKeyVersion: 1 },
				],
				getPreparationPage: async () => ({ records: [], nextCursor: null }),
				stage: async () => {},
				finalize: async () => ({ rotationId: "rotation-1" }),
				refresh: async () => {
					throw new Error("offline");
				},
				markUnavailable: async (vaultIds) => {
					unavailable.push([...vaultIds]);
				},
			} as RotationPlanClient,
		});

		const outcome = await ceremony.rotate({
			intent: { kind: "member-removal" },
			currentUserId: "owner",
		});

		expect(outcome).toMatchObject({ kind: "refresh_required" });
		expect(unavailable).toEqual([["vault-1"]]);
	});

	test("keeps the vault unavailable when the account locks during post-commit refresh", async () => {
		const crypto = createInMemoryCryptoPort();
		const masterUnlockKey = await crypto.generateEncryptionKey();
		const unavailable: string[][] = [];
		let lock: (() => void) | undefined;
		const ceremony = createVaultKeyRotationCeremony({
			crypto,
			openVaultKey: async () => crypto.generateEncryptionKey(),
			getMasterUnlockKey: async () => masterUnlockKey,
			onLock: (listener) => {
				lock = listener;
				return () => {};
			},
			client: {
				start: async () => [
					{ planId: "plan-1", vaultId: "vault-1", expectedKeyVersion: 1 },
				],
				getPreparationPage: async () => ({ records: [], nextCursor: null }),
				stage: async () => {},
				finalize: async () => ({ rotationId: "rotation-1" }),
				refresh: async (_vaultIds, signal) => {
					lock?.();
					throw signal.reason;
				},
				markUnavailable: async (vaultIds) => {
					unavailable.push([...vaultIds]);
				},
			} as RotationPlanClient,
		});

		const outcome = await ceremony.rotate({
			intent: { kind: "member-removal" },
			currentUserId: "owner",
		});

		expect(outcome).toMatchObject({ kind: "refresh_required" });
		expect(unavailable).toEqual([["vault-1"]]);
	});
});
