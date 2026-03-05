import type { IStorageAdapter } from "@bittery/storage/adapter";
import { buildVaultKeyEncryptionContext } from "@bittery/shared";
import type { ICrypto } from "@bittery/types";
import type { AccountResolver, DefaultTrpcClient } from "./account-resolver";

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
	accountEmail?: string;
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
	accountEmail?: string;
}

export interface ConvertVaultTypeInput {
	vaultId: string;
	targetType: "personal" | "team";
	personalEncryptedVaultKey?: string;
	accountEmail?: string;
}

export interface ConvertVaultTypeResult {
	success: true;
	vaultId: string;
	previousType: "personal" | "team";
	newType: "personal" | "team";
}

export interface VaultListItem {
	id: string;
	name: string;
	type: "personal" | "team";
	icon: string | null;
	imageUrl: string | null;
	encryptedVaultKey: string;
	role: "owner" | "admin" | "member" | "read-only";
}

export interface TRPCVaultClient {
	vault: {
		list: {
			query: () => Promise<VaultListItem[]>;
		};
	};
}

/**
 * Refresh vault keys from server and store in local storage.
 */
export async function refreshVaultKeys(
	trpcClient: TRPCVaultClient,
	storage: IStorageAdapter,
	accountEmail?: string,
): Promise<void> {
	const vaultList = await trpcClient.vault.list.query();
	await storage.storeVaultKeys(
		vaultList.map((vault) => ({
			vaultId: vault.id,
			vaultName: vault.name,
			vaultType: vault.type,
			vaultIcon: vault.icon,
			vaultImageUrl: vault.imageUrl,
			encryptedVaultKey: vault.encryptedVaultKey,
			role: vault.role,
		})),
		accountEmail,
	);
}

interface VaultServiceDeps {
	storage: IStorageAdapter;
	crypto: ICrypto;
	accounts: AccountResolver;
}

export class VaultService {
	private readonly storage: IStorageAdapter;
	private readonly crypto: ICrypto;
	private readonly accounts: AccountResolver;

	constructor(deps: VaultServiceDeps) {
		this.storage = deps.storage;
		this.crypto = deps.crypto;
		this.accounts = deps.accounts;
	}

	async createVault(
		input: CreateVaultInput,
		defaultClient: DefaultTrpcClient,
	): Promise<CreateVaultResult> {
		const trimmedName = input.name.trim();
		if (!trimmedName) {
			throw new Error("Vault name is required");
		}
		if (trimmedName.length < 2) {
			throw new Error("Vault name must be at least 2 characters");
		}

		const client = await this.accounts.getClientForAccount(
			defaultClient,
			input.accountEmail,
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
		const masterUnlockKey = await this.storage.getMasterUnlockKey(
			input.accountEmail,
		);
		if (!masterUnlockKey) {
			throw new Error("Master Unlock Key not found. Please sign in again.");
		}
		const currentUserId = await this.storage.getActiveAccountUserId();
		if (!currentUserId) {
			throw new Error("Session data missing. Please sign in again.");
		}
		const vaultId = this.crypto.generateUuid
			? await this.crypto.generateUuid()
			: globalThis.crypto?.randomUUID?.() ?? `vault_${Date.now()}`;

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
			type: input.type,
			encryptedVaultKey: JSON.stringify(encryptedVaultKeyData),
			icon: input.icon,
			...(imageKey ? { imageKey } : {}),
		});

		return { vaultId: result.vaultId };
	}

	async updateVault(
		input: UpdateVaultInput,
		defaultClient: DefaultTrpcClient,
	): Promise<void> {
		const client = await this.accounts.getClientForAccount(
			defaultClient,
			input.accountEmail,
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
		});
	}

	async convertVaultType(
		input: ConvertVaultTypeInput,
		defaultClient: DefaultTrpcClient,
	): Promise<ConvertVaultTypeResult> {
		const client = await this.accounts.getClientForAccount(
			defaultClient,
			input.accountEmail,
		);
		return client.vault.convertType.mutate({
			vaultId: input.vaultId,
			targetType: input.targetType,
			...(input.personalEncryptedVaultKey
				? { personalEncryptedVaultKey: input.personalEncryptedVaultKey }
				: {}),
		});
	}

	async deleteVault(
		vaultId: string,
		defaultClient: DefaultTrpcClient,
		accountEmail?: string,
	): Promise<void> {
		const client = await this.accounts.getClientForAccount(
			defaultClient,
			accountEmail,
		);
		await client.vault.delete.mutate({ vaultId });
	}

	async refreshVaultKeys(
		defaultClient: DefaultTrpcClient,
		accountEmail?: string,
	): Promise<void> {
		const client = await this.accounts.getClientForAccount(
			defaultClient,
			accountEmail,
		);
		await refreshVaultKeys(client, this.storage, accountEmail);
	}
}
