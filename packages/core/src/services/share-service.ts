import {
	getDecryptedVaultKey as getDecryptedVaultKeyUtil,
	type VaultKeyCryptoProvider,
} from "@bittery/shared";
import type { DecryptedItem } from "@bittery/shared/types";
import type { IStorageAdapter } from "@bittery/storage/adapter";
import type { ICrypto } from "@bittery/types";
import type { AccountResolver, DefaultRpcClient } from "./account-resolver";

export type ShareExpirationOption =
	| "1hour"
	| "1day"
	| "7days"
	| "14days"
	| "30days";

export type ShareAccessMode = "anyone" | "email-restricted";

export interface CreateShareInput {
	item: DecryptedItem;
	accessMode: ShareAccessMode;
	expiresIn: ShareExpirationOption;
	isOneTimeUse: boolean;
	allowedEmails?: string[];
	accountEmail?: string;
}

export interface CreateShareResult {
	token: string;
	shareKeyBase64: string;
	expiresAt: string;
	baseShareUrl: string;
}

/**
 * Build the full share URL.
 */
export function buildShareUrl(result: CreateShareResult): string {
	return `${result.baseShareUrl}${result.token}#${result.shareKeyBase64}`;
}

function arrayBufferToBase64(buffer: Uint8Array): string {
	return btoa(String.fromCharCode(...buffer));
}

interface ShareServiceDeps {
	storage: IStorageAdapter;
	crypto: ICrypto;
	accounts: AccountResolver;
}

export class ShareService {
	private readonly storage: IStorageAdapter;
	private readonly crypto: ICrypto;
	private readonly accounts: AccountResolver;

	constructor(deps: ShareServiceDeps) {
		this.storage = deps.storage;
		this.crypto = deps.crypto;
		this.accounts = deps.accounts;
	}

	async createShare(
		input: CreateShareInput,
		defaultClient: DefaultRpcClient,
	): Promise<CreateShareResult> {
		const {
			item,
			accessMode,
			expiresIn,
			isOneTimeUse,
			allowedEmails,
			accountEmail,
		} = input;

		const vaultKey = await getDecryptedVaultKeyUtil({
			vaultId: item.vaultId,
			email: accountEmail,
			storage: this.storage,
			crypto: this.crypto as unknown as VaultKeyCryptoProvider,
		});
		if (!vaultKey) {
			throw new Error("Could not decrypt vault key. Please log in again.");
		}

		const client = await this.accounts.getClientForAccount(
			defaultClient,
			accountEmail,
		);

		const shareKey = await this.crypto.generateEncryptionKey();

		const itemDataToShare = {
			title: item.title,
			category: item.category,
			url: item.url,
			urls: item.urls,
			username: item.username,
			password: item.password,
			notes: item.notes,
			note: item.note,
			customFields: item.customFields,
			cardholderName: item.cardholderName,
			cardNumber: item.cardNumber,
			cvv: item.cvv,
			expiryDate: item.expiryDate,
			billingAddress: item.billingAddress,
			firstName: item.firstName,
			middleName: item.middleName,
			lastName: item.lastName,
			email: item.email,
			addresses: item.addresses,
			phoneNumbers: item.phoneNumbers,
			ssn: item.ssn,
			passportNumber: item.passportNumber,
			driversLicense: item.driversLicense,
			dateOfBirth: item.dateOfBirth,
			totpSecret: item.totpSecret,
			totpIssuer: item.totpIssuer,
			totpAccountName: item.totpAccountName,
			totpAlgorithm: item.totpAlgorithm,
			totpDigits: item.totpDigits,
			totpPeriod: item.totpPeriod,
		};

		const encryptedData = await this.crypto.encrypt(
			JSON.stringify(itemDataToShare),
			shareKey,
		);

		const shareKeyBase64 = arrayBufferToBase64(shareKey);
		const shareKeyEncrypted = await this.crypto.encrypt(
			shareKeyBase64,
			shareKey,
		);

		const result = await client.share.create.mutate({
			itemId: item.id,
			accessMode,
			isOneTimeUse,
			expiresIn,
			allowedEmails:
				accessMode === "email-restricted" ? (allowedEmails ?? null) : null,
			encryptedItemData: encryptedData.ciphertext,
			encryptionIv: encryptedData.iv,
			encryptedShareKey: shareKeyEncrypted.ciphertext,
			shareKeyIv: shareKeyEncrypted.iv,
		});

		return {
			token: result.token,
			shareKeyBase64,
			expiresAt: result.expiresAt,
			baseShareUrl: result.baseShareUrl,
		};
	}

	buildShareUrl(result: CreateShareResult): string {
		return buildShareUrl(result);
	}
}
