import { describe, expect, test } from "bun:test";
import { ApiError, ApiTransportError } from "@bittery/api-contract";
import type { VaultKeyData } from "@bittery/storage";
import {
	createRotationLocalState,
	decodeRotationPreparationPage,
	encodeRotationStageOutput,
	executeWithIdempotentReplay,
} from "./vault-key-rotation-adapter";

describe("Vault key rotation API adapter", () => {
	test("maps opaque preparation JSON into crypto-port records", () => {
		const member = decodeRotationPreparationPage("member", {
			records: [
				{
					id: "user-2",
					expectedVersion: 4,
					payload: JSON.stringify({
						userId: "user-2",
						publicKey: "public-key",
						role: "member",
					}),
				},
			],
			nextCursor: null,
		});
		const item = decodeRotationPreparationPage("item", {
			records: [
				{
					id: "item-1",
					expectedVersion: 7,
					payload: JSON.stringify({
						id: "item-1",
						vaultId: "vault-1",
						encryptedData: "ciphertext",
						encryptionIv: "iv",
						encryptionAlgorithm: "AES-GCM",
						encryptionVersion: 3,
						encryptedByUserId: "user-1",
					}),
				},
			],
			nextCursor: "next",
		});
		const attachment = decodeRotationPreparationPage("attachment", {
			records: [
				{
					id: "attachment-1",
					expectedVersion: 2,
					payload: JSON.stringify({
						attachmentId: "attachment-1",
						vaultId: "vault-1",
						uploadedBy: "user-1",
						encryptedAttachmentKey: "wrapped-key",
						attachmentKeyIv: "key-iv",
						attachmentKeyAlgorithm: "AES-GCM",
						envelopeVersion: 2,
					}),
				},
			],
			nextCursor: null,
		});

		expect(member.records[0]?.payload).toEqual({
			userId: "user-2",
			publicKey: "public-key",
		});
		expect(item).toEqual({
			records: [
				{
					id: "item-1",
					expectedVersion: 7,
					payload: {
						id: "item-1",
						encryptedData: "ciphertext",
						encryptionIv: "iv",
						encryptionAlgorithm: "AES-GCM",
						context: {
							vaultId: "vault-1",
							entityId: "item-1",
							entityType: "item",
							version: 3,
							userId: "user-1",
						},
					},
				},
			],
			nextCursor: "next",
		});
		expect(attachment.records[0]?.payload).toEqual({
			attachmentId: "attachment-1",
			encryptedAttachmentKey: {
				ciphertext: "wrapped-key",
				iv: "key-iv",
				algorithm: "AES-GCM",
			},
			context: {
				vaultId: "vault-1",
				entityId: "attachment-1",
				entityType: "attachment_key",
				version: 2,
				userId: "user-1",
			},
		});
	});

	test("serializes staged crypto outputs into server payload JSON", () => {
		const outputs = encodeRotationStageOutput({
			kind: "attachment",
			cursor: "initial",
			records: [
				{
					id: "attachment-1",
					expectedVersion: 2,
					payload: {
						attachmentId: "attachment-1",
						encryptedAttachmentKey: {
							ciphertext: "new-wrapped-key",
							iv: "new-iv",
							algorithm: "AES-GCM",
						},
						context: {
							vaultId: "vault-1",
							entityId: "attachment-1",
							entityType: "attachment_key",
							version: 3,
							userId: "user-1",
						},
					},
				},
			],
		});

		expect(outputs).toEqual([
			{
				id: "attachment-1",
				payload: JSON.stringify({
					attachmentId: "attachment-1",
					encryptedAttachmentKey: "new-wrapped-key",
					attachmentKeyIv: "new-iv",
					attachmentKeyAlgorithm: "AES-GCM",
					vaultId: "vault-1",
					uploadedBy: "user-1",
					envelopeVersion: 3,
				}),
			},
		]);
	});

	test("removes stale keys and cached vault contents before authoritative refresh", async () => {
		const calls: string[] = [];
		let keys: VaultKeyData[] = [
			{
				vaultId: "vault-1",
				vaultName: "Rotated",
				vaultType: "team" as const,
				vaultIcon: null,
				vaultImageUrl: null,
				encryptedVaultKey: "stale",
				role: "owner" as const,
			},
			{
				vaultId: "vault-2",
				vaultName: "Unchanged",
				vaultType: "team" as const,
				vaultIcon: null,
				vaultImageUrl: null,
				encryptedVaultKey: "unchanged",
				role: "owner" as const,
			},
		];
		const localState = createRotationLocalState({
			getAccountId: async () => "account-1",
			getVaultKeys: async () => keys,
			storeVaultKeys: async (next) => {
				calls.push("keys-unavailable");
				keys = [...next];
			},
			removeCachedVault: async (vaultId, accountId) => {
				calls.push(`cache-unavailable:${accountId}:${vaultId}`);
			},
			refreshFromServer: async () => {
				calls.push("refresh");
			},
		});

		await localState.refresh(["vault-1"]);

		expect(keys).toEqual([
			{
				vaultId: "vault-2",
				vaultName: "Unchanged",
				vaultType: "team",
				vaultIcon: null,
				vaultImageUrl: null,
				encryptedVaultKey: "unchanged",
				role: "owner",
			},
		]);
		expect(calls).toEqual([
			"keys-unavailable",
			"cache-unavailable:account-1:vault-1",
			"refresh",
		]);
	});

	test("retries an authoritative refresh after a transient failure", async () => {
		let attempts = 0;
		const localState = createRotationLocalState({
			getAccountId: async () => "account-1",
			getVaultKeys: async () => [],
			storeVaultKeys: async () => {},
			removeCachedVault: async () => {},
			refreshFromServer: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("transient");
			},
		});

		await localState.refresh(["vault-1"]);
		expect(attempts).toBe(2);
	});

	test("replays a lost finalize response with the same idempotency key", async () => {
		const keys: string[] = [];
		const result = await executeWithIdempotentReplay(async (key) => {
			keys.push(key);
			if (keys.length === 1) throw new ApiTransportError(new TypeError("lost"));
			return { rotationId: "rotation-1" };
		}, "stable-key");
		expect(keys).toEqual(["stable-key", "stable-key"]);
		expect(result).toEqual({ rotationId: "rotation-1" });
	});

	test("does not replay cancellation or programming failures", async () => {
		for (const error of [
			new Error("cancelled"),
			new TypeError("bad mapping"),
		]) {
			let attempts = 0;
			await expect(
				executeWithIdempotentReplay(async () => {
					attempts += 1;
					throw error;
				}, "stable-key"),
			).rejects.toBe(error);
			expect(attempts).toBe(1);
		}
	});

	test("replays a retryable server response with the same idempotency key", async () => {
		const keys: string[] = [];
		const result = await executeWithIdempotentReplay(async (key) => {
			keys.push(key);
			if (keys.length === 1) {
				throw new ApiError(
					{
						type: "about:blank",
						title: "Service unavailable",
						status: 503,
						code: "SERVICE_UNAVAILABLE",
						retryable: true,
					},
					null,
				);
			}
			return { rotationId: "rotation-1" };
		}, "stable-key");
		expect(keys).toEqual(["stable-key", "stable-key"]);
		expect(result).toEqual({ rotationId: "rotation-1" });
	});
});
