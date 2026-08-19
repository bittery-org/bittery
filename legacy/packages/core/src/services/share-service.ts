import type { CryptoPort } from "@bittery/crypto-port";
import { arrayBufferToBase64 } from "@bittery/shared/crypto";
import type { DecryptedItem, SharedItemPayload } from "@bittery/shared/types";
import type { AccountResolver } from "./account-resolver";
import type { VaultCrypto } from "./vault-crypto";

export const SHARE_EXPIRATION_OPTIONS = [
	"1hour",
	"1day",
	"7days",
	"14days",
	"30days",
] as const;

export type ShareExpirationOption = (typeof SHARE_EXPIRATION_OPTIONS)[number];

export type ShareAccessMode = "anyone" | "email-restricted";

export interface CreateShareInput {
	item: DecryptedItem;
	accessMode: ShareAccessMode;
	expiresIn: ShareExpirationOption;
	isOneTimeUse: boolean;
	allowedEmails?: string[];
	accountId: string;
}

// The share key only ever exists in the URL fragment, so a link assembled from
// parts without it is permanently undecryptable — hence the parts never leave here.
export interface CreateShareResult {
	shareUrl: string;
	expiresAt: string;
}

interface ShareUrlParts {
	baseShareUrl: string;
	token: string;
	shareKeyBase64: string;
}

function buildShareUrl(parts: ShareUrlParts): string {
	return `${parts.baseShareUrl}${parts.token}#${parts.shareKeyBase64}`;
}

export function readShareKeyFromUrl(url: string): string | null {
	const fragmentStart = url.indexOf("#");
	if (fragmentStart === -1) {
		return null;
	}
	return url.slice(fragmentStart + 1) || null;
}

function buildSharedItemPayload(item: DecryptedItem): SharedItemPayload {
	return {
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
}

interface ShareServiceDeps {
	crypto: CryptoPort;
	vaultCrypto: VaultCrypto;
	accounts: AccountResolver;
}

export class ShareService {
	private readonly crypto: CryptoPort;
	private readonly vaultCrypto: VaultCrypto;
	private readonly accounts: AccountResolver;

	constructor(deps: ShareServiceDeps) {
		this.crypto = deps.crypto;
		this.vaultCrypto = deps.vaultCrypto;
		this.accounts = deps.accounts;
	}

	async createShare(input: CreateShareInput): Promise<CreateShareResult> {
		const {
			item,
			accessMode,
			expiresIn,
			isOneTimeUse,
			allowedEmails,
			accountId,
		} = input;

		// `item` is already decrypted, so this decrypt is purely an unlock gate:
		// sharing must be refused unless this account can still open the vault.
		const vaultUnlockProof = await this.vaultCrypto.getVaultKey({
			vaultId: item.vaultId,
			accountId,
		});
		if (!vaultUnlockProof) {
			throw new Error("Could not decrypt vault key. Please log in again.");
		}

		try {
			const client = await this.accounts.getClientForAccount(accountId);
			const shareKey = await this.crypto.generateEncryptionKey();
			try {
				const encryptedData = await this.crypto.encrypt(
					JSON.stringify(buildSharedItemPayload(item)),
					shareKey,
					null,
				);
				const shareKeyBase64 = arrayBufferToBase64(
					await this.crypto.exportKey(shareKey),
				);
				const shareKeyEncrypted = await this.crypto.encrypt(
					shareKeyBase64,
					shareKey,
					null,
				);

				const { data: result } = await client.share.create(item.id, {
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
					shareUrl: buildShareUrl({
						baseShareUrl: result.baseShareUrl,
						token: result.token,
						shareKeyBase64,
					}),
					expiresAt: result.expiresAt,
				};
			} finally {
				await this.crypto.destroyKey(shareKey);
			}
		} finally {
			await this.crypto.destroyKey(vaultUnlockProof);
		}
	}
}
