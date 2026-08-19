import { describe, expect, test } from "bun:test";
import type { KeyRef } from "@bittery/crypto-port";
import { createInMemoryCryptoPort } from "@bittery/crypto-port/testing";
import {
	ATTACHMENT_ENVELOPE_VERSION,
	createAttachmentKeyEnvelope,
	decryptAttachmentParts,
	encryptAttachmentParts,
	unwrapAttachmentKey,
} from "./attachment-crypto";
import { createVaultCrypto } from "./vault-crypto";

const scope = (attachmentId: string) => ({
	vaultId: "vault_1",
	attachmentId,
	userId: "user_1",
	envelopeVersion: ATTACHMENT_ENVELOPE_VERSION,
});

function vaultCryptoFor(crypto: ReturnType<typeof createInMemoryCryptoPort>) {
	return createVaultCrypto({
		crypto,
		storage: {
			getVaultKeys: async () => null,
			getMasterUnlockKey: async () => null,
			getEncryptedPrivateKey: async () => null,
			getStoredSessionData: async () => null,
			getPinnedKdfProfile: async () => null,
		},
	});
}

describe("attachment-key envelopes", () => {
	test("opens a rotated envelope version when the authenticated scope matches", async () => {
		const crypto = createInMemoryCryptoPort();
		const vaultCrypto = vaultCryptoFor(crypto);
		const vaultKey = await crypto.importKey(new Uint8Array(32).fill(7));
		const rotatedVersion = ATTACHMENT_ENVELOPE_VERSION + 1;
		const rotatedScope = {
			...scope("attachment_unsupported"),
			envelopeVersion: rotatedVersion,
		};
		const envelope = await createAttachmentKeyEnvelope(
			vaultCrypto,
			vaultKey,
			rotatedScope,
		);

		const opened = await unwrapAttachmentKey(
			vaultCrypto,
			vaultKey,
			rotatedScope,
			envelope.encryptedAttachmentKey,
		);
		await vaultCrypto.destroyAttachmentKey(opened);
		await expect(
			unwrapAttachmentKey(
				vaultCrypto,
				vaultKey,
				{ ...rotatedScope, envelopeVersion: rotatedVersion + 1 },
				envelope.encryptedAttachmentKey,
			),
		).rejects.toThrow("Attachment-key envelope version mismatch");
		await vaultCrypto.destroyAttachmentKey(envelope.key);
	});

	test("a failed envelope creation retires its fresh Attachment key", async () => {
		const crypto = createInMemoryCryptoPort();
		const vaultCrypto = vaultCryptoFor(crypto);
		const vaultKey = await crypto.generateEncryptionKey();
		const destroyed: KeyRef[] = [];
		const originalDestroy = vaultCrypto.destroyAttachmentKey;
		vaultCrypto.destroyAttachmentKey = async (key) => {
			destroyed.push(key);
			await originalDestroy(key);
		};
		vaultCrypto.wrapAttachmentKey = async () => {
			throw new Error("wrap failed");
		};

		try {
			await expect(
				createAttachmentKeyEnvelope(
					vaultCrypto,
					vaultKey,
					scope("attachment_failed"),
				),
			).rejects.toThrow("wrap failed");
			expect(destroyed).toHaveLength(1);
			expect(crypto.liveKeyCount).toBe(1);
		} finally {
			await crypto.destroyKey(vaultKey);
		}
	});

	test("one Attachment key cannot open another Attachment", async () => {
		const crypto = createInMemoryCryptoPort();
		const vaultCrypto = vaultCryptoFor(crypto);
		const vaultKey = await crypto.generateEncryptionKey();
		const first = await createAttachmentKeyEnvelope(
			vaultCrypto,
			vaultKey,
			scope("attachment_1"),
		);
		const second = await createAttachmentKeyEnvelope(
			vaultCrypto,
			vaultKey,
			scope("attachment_2"),
		);

		try {
			const encrypted = await encryptAttachmentParts(
				vaultCrypto,
				first.key,
				scope("attachment_1"),
				{
					base64File: "ZmlsZQ==",
					name: "secret.txt",
					contentType: "text/plain",
				},
			);

			await expect(
				decryptAttachmentParts(
					vaultCrypto,
					second.key,
					scope("attachment_2"),
					encrypted,
				),
			).rejects.toThrow();
		} finally {
			await crypto.destroyKey(first.key);
			await crypto.destroyKey(second.key);
			await crypto.destroyKey(vaultKey);
		}
	});

	test("an Attachment-key envelope cannot move across Vaults or Attachments", async () => {
		const crypto = createInMemoryCryptoPort();
		const vaultCrypto = vaultCryptoFor(crypto);
		const vaultKey = await crypto.generateEncryptionKey();
		const { encryptedAttachmentKey, key } = await createAttachmentKeyEnvelope(
			vaultCrypto,
			vaultKey,
			scope("attachment_1"),
		);

		try {
			await expect(
				unwrapAttachmentKey(
					vaultCrypto,
					vaultKey,
					{
						...scope("attachment_1"),
						vaultId: "vault_2",
					},
					encryptedAttachmentKey,
				),
			).rejects.toThrow();
			await expect(
				unwrapAttachmentKey(
					vaultCrypto,
					vaultKey,
					scope("attachment_2"),
					encryptedAttachmentKey,
				),
			).rejects.toThrow();
		} finally {
			await crypto.destroyKey(key);
			await crypto.destroyKey(vaultKey);
		}
	});

	test("a cross-Vault move re-encrypts under a new Attachment key and envelope", async () => {
		const crypto = createInMemoryCryptoPort();
		const vaultCrypto = vaultCryptoFor(crypto);
		const sourceVaultKey = await crypto.generateEncryptionKey();
		const targetVaultKey = await crypto.generateEncryptionKey();
		const sourceScope = scope("attachment_source");
		const source = await createAttachmentKeyEnvelope(
			vaultCrypto,
			sourceVaultKey,
			sourceScope,
		);
		const targetScope = {
			...scope("attachment_target"),
			vaultId: "vault_2",
		};

		try {
			const encrypted = await encryptAttachmentParts(
				vaultCrypto,
				source.key,
				sourceScope,
				{
					base64File: "ZmlsZQ==",
					name: "secret.txt",
					contentType: "text/plain",
				},
			);
			const target = await createAttachmentKeyEnvelope(
				vaultCrypto,
				targetVaultKey,
				targetScope,
			);
			try {
				const moved = await encryptAttachmentParts(
					vaultCrypto,
					target.key,
					targetScope,
					await decryptAttachmentParts(
						vaultCrypto,
						source.key,
						sourceScope,
						encrypted,
					),
				);

				await expect(
					unwrapAttachmentKey(
						vaultCrypto,
						sourceVaultKey,
						targetScope,
						target.encryptedAttachmentKey,
					),
				).rejects.toThrow();
				expect(
					await decryptAttachmentParts(
						vaultCrypto,
						target.key,
						targetScope,
						moved,
					),
				).toEqual({
					base64File: "ZmlsZQ==",
					name: "secret.txt",
					contentType: "text/plain",
				});
			} finally {
				await crypto.destroyKey(target.key);
			}
		} finally {
			await crypto.destroyKey(source.key);
			await crypto.destroyKey(sourceVaultKey);
			await crypto.destroyKey(targetVaultKey);
		}
	});
});
