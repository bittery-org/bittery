import { buildVaultKeyEncryptionContext } from "@bittery/shared";
import {
	decodeVaultType,
	type ServerVaultListEntry,
	toVaultKeyEntry,
} from "@bittery/shared/vault-mapping";
import type { AccountStore } from "@bittery/storage";
import { resolveUserIdForAccount } from "@bittery/storage/account-id";
import type { ICrypto } from "@bittery/types";
import type { AccountResolver, DefaultRpcClient } from "./account-resolver";

/**
 * Image file input - supports File (browser) or Blob
 */
export type ImageFileInput = File | (Blob & { name?: string });

export interface CreateVaultInput {
	name: string;
	type: "personal" | "team";
	icon: string;
	imageFile?: ImageFileInput;
	imageKey?: string;
	accountId: string;
}

export interface CreateVaultResult {
	vaultId: string;
}

export interface UpdateVaultInput {
	vaultId: string;
	name?: string;
	icon?: string | null;
	imageFile?: File;
	removeImage?: boolean;
	accountId: string;
}

export interface ConvertVaultTypeInput {
	vaultId: string;
	targetType: "personal" | "team";
	personalEncryptedVaultKey?: string;
	accountId: string;
}

export interface ConvertVaultTypeResult {
	success: true;
	vaultId: string;
	previousType: "personal" | "team";
	newType: "personal" | "team";
}

export type VaultListItem = ServerVaultListEntry;

export interface RpcVaultClient {
	vault: {
		list: {
			query: () => Promise<VaultListItem[]>;
		};
	};
}

export type TRPCVaultClient = RpcVaultClient;

/**
 * Refresh vault keys from server and store in local storage.
 */
export async function refreshVaultKeys(
	rpcClient: RpcVaultClient,
	storage: AccountStore,
	accountId?: string,
): Promise<void> {
	const vaultList = await rpcClient.vault.list.query();
	await storage.storeVaultKeys(vaultList.map(toVaultKeyEntry), accountId);
}

interface VaultServiceDeps {
	storage: AccountStore;
	crypto: ICrypto;
	accounts: AccountResolver;
}

export class VaultService {
	private readonly storage: AccountStore;
	private readonly crypto: ICrypto;
	private readonly accounts: AccountResolver;

	constructor(deps: VaultServiceDeps) {
		this.storage = deps.storage;
		this.crypto = deps.crypto;
		this.accounts = deps.accounts;
	}

	async createVault(
		input: CreateVaultInput,
		defaultClient: DefaultRpcClient,
	): Promise<CreateVaultResult> {
		const trimmedName = input.name.trim();
		if (!trimmedName) {
			throw new Error("Vault name is required");
		}
		if (trimmedName.length < 2) {
			throw new Error("Vault name must be at least 2 characters");
		}

		const accountId = input.accountId;
		const client = await this.accounts.getClientForAccount(
			defaultClient,
			accountId,
		);

		let imageKey = input.imageKey;
		if (input.imageFile && !imageKey) {
			const file = input.imageFile;
			const contentType = file.type;
			const fileName = "name" in file && file.name ? file.name : "image";

			if (!contentType.startsWith("image/")) {
				throw new Error("Vault image must be an image file");
			}

			const upload = await client.vault.createImageUpload.mutate({
				vaultId: null,
				fileName,
				contentType,
			});

			const uploadResponse = await fetch(upload.uploadUrl, {
				method: "PUT",
				headers: {
					"Content-Type": contentType,
				},
				body: file,
			});

			if (!uploadResponse.ok) {
				throw new Error("Failed to upload vault image");
			}

			imageKey = upload.key;
		}

		const vaultKey = await this.crypto.generateEncryptionKey();
		const masterUnlockKey = await this.storage.getMasterUnlockKey(accountId);
		if (!masterUnlockKey) {
			throw new Error("Master Unlock Key not found. Please sign in again.");
		}
		// Migrated to the canonical session→metadata→active triad
		// (resolveUserIdForAccount). This is a superset of the previous
		// metadata→active lookup: it also tries the account's live session
		// first. Session userId and account metadata userId are written
		// together at login (see storeLoginSession/registerLoginAccount), so
		// for the same accountId they are always in sync — this is benign.
		const currentUserId = await resolveUserIdForAccount(
			this.storage,
			accountId,
			{ errorMessage: "Session data missing. Please sign in again." },
		);
		const vaultId = this.crypto.generateUuid
			? await this.crypto.generateUuid()
			: (globalThis.crypto?.randomUUID?.() ?? `vault_${Date.now()}`);

		const vaultKeyBase64 = btoa(String.fromCharCode(...vaultKey));
		const encryptedVaultKeyData = await this.crypto.encrypt(
			vaultKeyBase64,
			masterUnlockKey,
			buildVaultKeyEncryptionContext({
				vaultId,
				userId: currentUserId,
				keyVersion: 1,
			}),
		);

		const result = await client.vault.create.mutate({
			vaultId,
			name: trimmedName,
			vaultType: input.type,
			encryptedVaultKey: JSON.stringify(encryptedVaultKeyData),
			icon: input.icon,
			imageKey: imageKey ?? null,
			clientId: null,
		});

		return { vaultId: result.vaultId };
	}

	async updateVault(
		input: UpdateVaultInput,
		defaultClient: DefaultRpcClient,
	): Promise<void> {
		const accountId = input.accountId;
		const client = await this.accounts.getClientForAccount(
			defaultClient,
			accountId,
		);

		if (input.name !== undefined) {
			const trimmedName = input.name.trim();
			if (!trimmedName) {
				throw new Error("Vault name is required");
			}
			if (trimmedName.length < 2) {
				throw new Error("Vault name must be at least 2 characters");
			}
		}

		let imageKey: string | null | undefined;
		if (input.imageFile) {
			const upload = await client.vault.createImageUpload.mutate({
				vaultId: input.vaultId,
				fileName: input.imageFile.name,
				contentType: input.imageFile.type,
			});

			const uploadResponse = await fetch(upload.uploadUrl, {
				method: "PUT",
				body: input.imageFile,
				headers: {
					"Content-Type": input.imageFile.type,
				},
			});

			if (!uploadResponse.ok) {
				throw new Error("Failed to upload vault image");
			}

			imageKey = upload.key;
		} else if (input.removeImage) {
			imageKey = null;
		}

		await client.vault.update.mutate({
			vaultId: input.vaultId,
			...(input.name !== undefined ? { name: input.name.trim() } : {}),
			...(input.icon !== undefined ? { icon: input.icon } : {}),
			...(imageKey !== undefined ? { imageKey } : {}),
			clientId: null,
		} as Parameters<typeof client.vault.update.mutate>[0]);
	}

	async convertVaultType(
		input: ConvertVaultTypeInput,
		defaultClient: DefaultRpcClient,
	): Promise<ConvertVaultTypeResult> {
		const accountId = input.accountId;
		const client = await this.accounts.getClientForAccount(
			defaultClient,
			accountId,
		);
		const result = await client.vault.convertType.mutate({
			vaultId: input.vaultId,
			targetType: input.targetType,
			personalEncryptedVaultKey: input.personalEncryptedVaultKey ?? null,
			clientId: null,
		});

		if (!result.success) {
			throw new Error("Vault type conversion failed");
		}

		return {
			success: true,
			vaultId: result.vaultId,
			previousType: decodeVaultType(result.previousType),
			newType: decodeVaultType(result.newType),
		};
	}

	async deleteVault(
		vaultId: string,
		defaultClient: DefaultRpcClient,
		accountId: string,
	): Promise<void> {
		const client = await this.accounts.getClientForAccount(
			defaultClient,
			accountId,
		);
		await client.vault.delete.mutate({ vaultId });
	}

	async refreshVaultKeys(
		defaultClient: DefaultRpcClient,
		accountId: string,
	): Promise<void> {
		const client = await this.accounts.getClientForAccount(
			defaultClient,
			accountId,
		);
		await refreshVaultKeys(client, this.storage, accountId);
	}
}
