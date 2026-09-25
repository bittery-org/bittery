import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import type { TestUser } from "./auth";

/** Own SRP Session and key handles, isolated from the live Web Runtime. */
export async function durableAttachmentDevice(
	page: Page,
	user: TestUser,
	itemId: string,
	vaultId: string,
	plaintext: number[],
) {
	const repository = resolve(import.meta.dirname, "../../../..");
	return page.evaluateHandle(
		async ({ user, itemId, vaultId, plaintext, repository }) => {
			const cryptoPath = "/src/lib/crypto.ts";
			const serverPath = "/src/lib/auth-server.ts";
			const storagePath = `/@fs${repository}/packages/storage/src/index.ts`;
			const memoryPath = `/@fs${repository}/packages/storage/src/testing/in-memory-port.ts`;
			const authPath = `/@fs${repository}/packages/core/src/services/auth-service.ts`;
			const apiPath = `/@fs${repository}/packages/shared/src/api-client-factory.ts`;
			const vaultPath = `/@fs${repository}/packages/core/src/services/vault-crypto.ts`;
			const attachmentPath = `/@fs${repository}/packages/core/src/services/attachment-crypto.ts`;
			const { crypto } = (await import(
				cryptoPath
			)) as typeof import("../../src/lib/crypto");
			const { getServerUrl } = (await import(
				serverPath
			)) as typeof import("../../src/lib/auth-server");
			const { createAccountStore, createItemCache } = (await import(
				storagePath
			)) as typeof import("@bittery/storage");
			const { createInMemoryPlatformPort, createInMemoryRecordPort } =
				(await import(memoryPath)) as typeof import("@bittery/storage/testing");
			const { performSRPLogin, storeLoginSessionOwned } = (await import(
				authPath
			)) as typeof import("@bittery/core/services/auth-service");
			const { createApiClientForServer, createAccountApiClient } =
				(await import(
					apiPath
				)) as typeof import("@bittery/shared/api-client-factory");
			const { createVaultCrypto } = (await import(
				vaultPath
			)) as typeof import("@bittery/core/services/vault-crypto");
			const attachments = (await import(
				attachmentPath
			)) as typeof import("@bittery/core/services/attachment-crypto");
			const storage = createAccountStore({
				port: createInMemoryPlatformPort(),
				crypto,
			});
			const itemCache = createItemCache({ port: createInMemoryRecordPort() });
			await storage.initialize();
			await itemCache.initialize();
			const serverUrl = getServerUrl();
			const clientId = globalThis.crypto.randomUUID();
			const metadata = {
				clientPlatform: "web",
				clientVersion: "durable-upload-fixture",
				insecureTransportConfirmed: true,
			};
			const login = await performSRPLogin(
				{
					email: user.email,
					password: user.password,
					secretKey: user.secretKey,
					serverUrl,
					insecureTransportConfirmed: true,
				},
				{
					crypto,
					storage,
					apiClient: createApiClientForServer(serverUrl, clientId, metadata),
				},
			);
			const api = createAccountApiClient(
				login.token,
				serverUrl,
				clientId,
				undefined,
				metadata,
			);
			const accountId = await storeLoginSessionOwned(
				login,
				user.secretKey,
				storage,
				itemCache,
				crypto,
				user.email,
				{ serverUrl, insecureTransportConfirmed: true },
			);
			const vaultCrypto = createVaultCrypto({ crypto, storage });
			const vaultKey = await vaultCrypto.getVaultKey({
				accountId,
				vaultId,
				userId: login.user.id,
			});
			if (!vaultKey)
				throw new Error("Own SRP fixture did not receive the target Vault key");
			const attachmentId = globalThis.crypto.randomUUID();
			const scope = {
				vaultId,
				attachmentId,
				userId: login.user.id,
				envelopeVersion: 1,
			};
			const attachment = await attachments.createAttachmentKeyEnvelope(
				vaultCrypto,
				vaultKey,
				scope,
			);
			const expected = {
				base64File: attachments.attachmentBytesToBase64(
					new Uint8Array(plaintext),
				),
				name: "durable upload — original.txt",
				contentType: "text/plain",
			};
			const encrypted = await attachments.encryptAttachmentParts(
				vaultCrypto,
				attachment.key,
				scope,
				expected,
			);
			const ciphertext = attachments.encodeAttachmentBlobEnvelope(
				encrypted.blobEnvelope,
			);
			const digest = Array.from(
				new Uint8Array(
					await globalThis.crypto.subtle.digest("SHA-256", ciphertext),
				),
				(byte) => byte.toString(16).padStart(2, "0"),
			).join("");
			const intent = {
				fileName: "opaque.enc",
				contentType: "application/octet-stream",
				fileSize: plaintext.length,
				durableUpload: { attachmentId, ciphertextSha256: digest },
			};
			let storageKey: string | undefined;
			return {
				prepared: { attachmentId, digest, ciphertext: Array.from(ciphertext) },
				async grant() {
					try {
						const { data } = await api.attachments.createUpload(itemId, intent);
						storageKey = data.key;
						return { ok: true as const, upload: data };
					} catch (error) {
						return {
							ok: false as const,
							status:
								typeof error === "object" && error !== null && "status" in error
									? Number(error.status)
									: null,
						};
					}
				},
				async registerAndVerify() {
					if (!storageKey) throw new Error("No accepted grant identity");
					const metadata = {
						attachmentId,
						storageKey,
						...attachment.encryptedAttachmentKey,
						encryptedName: encrypted.encryptedName,
						encryptedContentType: encrypted.encryptedContentType,
						encryptionIv: encrypted.encryptionIv,
						encryptedContentTypeIv: encrypted.encryptedContentTypeIv,
						encryptionAlgorithm: encrypted.encryptionAlgorithm,
						fileSize: plaintext.length,
					};
					const { data: created } = await api.attachments.create(
						itemId,
						metadata,
					);
					const { data: rows } = await api.attachments.list(itemId);
					const row = rows.find((row) => row.id === attachmentId);
					if (
						created.attachmentId !== attachmentId ||
						!row ||
						row.itemId !== itemId ||
						row.vaultId !== vaultId ||
						row.uploadedBy !== login.user.id ||
						Object.entries(metadata).some(
							([key, value]) =>
								key !== "attachmentId" &&
								row[key as keyof typeof row] !== value,
						)
					) {
						throw new Error(
							"Fresh registered Attachment metadata did not match the immutable request",
						);
					}
					const { data: download } =
						await api.attachments.createDownloadUrl(attachmentId);
					return {
						attachmentId: created.attachmentId,
						downloadUrl: download.downloadUrl,
					};
				},
				async verifyDownload(bytes: number[]) {
					const opened = await attachments.unwrapAttachmentKey(
						vaultCrypto,
						vaultKey,
						scope,
						attachment.encryptedAttachmentKey,
					);
					try {
						const actual = await attachments.decryptAttachmentParts(
							vaultCrypto,
							opened,
							scope,
							{
								...encrypted,
								blobEnvelope: attachments.parseAttachmentBlobEnvelope(
									new TextDecoder().decode(new Uint8Array(bytes)),
								),
							},
						);
						return (
							actual.base64File === expected.base64File &&
							actual.name === expected.name &&
							actual.contentType === expected.contentType
						);
					} finally {
						await crypto.destroyKey(opened);
					}
				},
				async close(userDeletionProven: boolean) {
					if (!userDeletionProven)
						throw new Error(
							"Retain the fixture credentials until public User deletion is proved",
						);
					await crypto.destroyKey(attachment.key);
					await crypto.destroyKey(vaultKey);
					await itemCache.clearItemCache(accountId);
					await storage.clearAllStoredData(accountId);
				},
			};
		},
		{ user, itemId, vaultId, plaintext, repository },
	);
}
