import type { CryptoPort } from "@bittery/crypto-port";
import {
	decodeVaultType,
	type ServerVaultListEntry,
	toVaultKeyEntry,
} from "@bittery/shared/vault-mapping";
import type { AccountStore } from "@bittery/storage";
import { resolveUserIdForAccount } from "@bittery/storage/account-id";
import type { AccountResolver, DefaultApiClient } from "./account-resolver";
import type { VaultCrypto } from "./vault-crypto";

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

export type VaultListItem = Omit<ServerVaultListEntry, "icon" | "imageUrl"> & {
	icon?: string | null;
	imageUrl?: string | null;
};

export interface ApiVaultClient {
	vaults: {
		list: () => Promise<{ data: readonly VaultListItem[] }>;
	};
}

/**
 * Refresh vault keys from server and store in local storage.
 */
export async function refreshVaultKeys(
	apiClient: ApiVaultClient,
	storage: AccountStore,
	accountId?: string,
): Promise<void> {
	const { data: vaultList } = await apiClient.vaults.list();
	await storage.storeVaultKeys(
		vaultList.map((vault) =>
			toVaultKeyEntry({
				...vault,
				icon: vault.icon ?? null,
				imageUrl: vault.imageUrl ?? null,
			}),
		),
		accountId,
	);
}

interface VaultServiceDeps {
	storage: AccountStore;
	crypto: CryptoPort;
	vaultCrypto: VaultCrypto;
	accounts: AccountResolver;
}

export class VaultService {
	private readonly storage: AccountStore;
	private readonly crypto: CryptoPort;
	private readonly vaultCrypto: VaultCrypto;
	private readonly accounts: AccountResolver;

	constructor(deps: VaultServiceDeps) {
		this.storage = deps.storage;
		this.crypto = deps.crypto;
		this.vaultCrypto = deps.vaultCrypto;
		this.accounts = deps.accounts;
	}

	async createVault(
		input: CreateVaultInput,
		defaultClient: DefaultApiClient,
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
		const vaultId = await this.crypto.generateUuid();

		let imageKey = input.imageKey;
		if (input.imageFile && !imageKey) {
			const file = input.imageFile;
			const contentType = file.type;
			const fileName = "name" in file && file.name ? file.name : "image";

			if (!contentType.startsWith("image/")) {
				throw new Error("Vault image must be an image file");
			}

			const { data: upload } = await client.vaults.createImageUpload(vaultId, {
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

		const masterUnlockKey = await this.storage.getMasterUnlockKey(accountId);
		if (!masterUnlockKey) {
			throw new Error("Master Unlock Key not found. Please sign in again.");
		}
		// Session and account metadata are written together at login, so the
		// canonical resolver keeps this context bound to the requested account.
		const currentUserId = await resolveUserIdForAccount(
			this.storage,
			accountId,
			{ errorMessage: "Session data missing. Please sign in again." },
		);
		const vaultKey = await this.crypto.generateEncryptionKey();
		try {
			const encryptedVaultKey = await this.vaultCrypto.wrapVaultKeyForOwner({
				vaultKey,
				masterUnlockKey,
				vaultId,
				userId: currentUserId,
				keyVersion: 1,
			});

			const { data: result } = await client.vaults.create(vaultId, {
				name: trimmedName,
				vaultType: input.type,
				encryptedVaultKey,
				icon: input.icon,
				imageKey: imageKey ?? null,
			});

			return { vaultId: result.vaultId };
		} finally {
			await this.crypto.destroyKey(vaultKey);
		}
	}

	async updateVault(
		input: UpdateVaultInput,
		defaultClient: DefaultApiClient,
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
			const { data: upload } = await client.vaults.createImageUpload(
				input.vaultId,
				{
					fileName: input.imageFile.name,
					contentType: input.imageFile.type,
				},
			);

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

		await client.vaults.update(
			input.vaultId,
			{
				...(input.name !== undefined ? { name: input.name.trim() } : {}),
				...(input.icon !== undefined ? { icon: input.icon } : {}),
				...(imageKey !== undefined ? { imageKey } : {}),
			},
			{},
		);
	}

	async convertVaultType(
		input: ConvertVaultTypeInput,
		defaultClient: DefaultApiClient,
	): Promise<ConvertVaultTypeResult> {
		const accountId = input.accountId;
		const client = await this.accounts.getClientForAccount(
			defaultClient,
			accountId,
		);
		const { data: result } = await client.vaults.convertType(input.vaultId, {
			targetType: input.targetType,
			personalEncryptedVaultKey: input.personalEncryptedVaultKey ?? null,
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
		defaultClient: DefaultApiClient,
		accountId: string,
	): Promise<void> {
		const client = await this.accounts.getClientForAccount(
			defaultClient,
			accountId,
		);
		await client.vaults.remove(vaultId, {});
	}

	async refreshVaultKeys(
		defaultClient: DefaultApiClient,
		accountId: string,
	): Promise<void> {
		const client = await this.accounts.getClientForAccount(
			defaultClient,
			accountId,
		);
		await refreshVaultKeys(client, this.storage, accountId);
	}
}
