/**
 * Shared type definitions for decrypted vault items
 */

import type { Address, PhoneNumber } from "./identity";

/**
 * Item categories for vault items
 * Matches the itemCategoryEnum in the database schema
 */
export type ItemCategory =
	| "login"
	| "secure-note"
	| "credit-card"
	| "identity"
	| "totp";

/**
 * TOTP algorithm options (RFC 6238)
 */
export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

/**
 * TOTP digits options (typically 6 or 8)
 */
export type TotpDigits = 6 | 7 | 8;

/**
 * Custom field definition for vault items
 */
export interface CustomField {
	id: string;
	label: string;
	value: string;
	type: "text" | "password" | "email" | "url";
}

export interface PasswordHistoryEntry {
	password: string;
	changedAt: string;
}

/**
 * Stored passkey metadata for login items.
 * All fields are encrypted as part of the item data blob.
 */
export type PasskeyStatus = "active" | "suspect";
export type PasskeyStatusReason =
	| "manual"
	| "unknown-credential"
	| "signing-error"
	| "other";

export interface Passkey {
	credentialId: string;
	rpId: string;
	rpName: string;
	userHandle: string;
	userName: string;
	userDisplayName: string;
	privateKey: string;
	publicKey: string;
	algorithm: number;
	signCount: number;
	transports: string[];
	createdAt: string;
	lastUsedAt?: string;
	status?: PasskeyStatus;
	statusReason?: PasskeyStatusReason;
	statusUpdatedAt?: string;
}

/**
 * Decrypted data payload for vault items (without metadata)
 * Contains all the actual sensitive data that gets encrypted/decrypted
 */
export interface DecryptedItemData {
	title: string;
	url?: string;
	urls?: string[];
	username?: string;
	password?: string;
	passwordHistory?: PasswordHistoryEntry[];
	passkeys?: Passkey[];
	notes?: string;
	note?: string;
	customFields?: CustomField[];
	// Tags - stored as part of encrypted data
	tags?: string[];
	// Credit card fields
	cardholderName?: string;
	cardNumber?: string;
	cvv?: string;
	expiryDate?: string;
	billingAddress?: string;
	// Identity fields
	firstName?: string;
	middleName?: string;
	lastName?: string;
	email?: string;
	addresses?: Address[];
	phoneNumbers?: PhoneNumber[];
	ssn?: string;
	passportNumber?: string;
	driversLicense?: string;
	dateOfBirth?: string;
	// TOTP fields
	totpSecret?: string;
	totpIssuer?: string;
	totpAccountName?: string;
	totpAlgorithm?: TotpAlgorithm;
	totpDigits?: TotpDigits;
	totpPeriod?: number;
	linkedItemId?: string; // Optional link to a login item
}

/**
 * Complete decrypted vault item with metadata and decrypted data
 * Extends DecryptedItemData with item metadata (id, timestamps, etc.)
 * Note: createdAt/updatedAt are strings (ISO format) as returned by tRPC
 */
export interface DecryptedItem extends DecryptedItemData {
	id: string;
	vaultId: string;
	category: ItemCategory;
	favorite: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface ItemAccountContext {
	email?: string;
	userId?: string;
	name?: string;
	serverUrl?: string;
	teamName?: string;
	teamAvatarUrl?: string | null;
}

export interface ItemContextMetadata {
	accountEmail?: string;
	serverUrl?: string;
	account?: ItemAccountContext | null;
}

export type DecryptedItemWithContext = DecryptedItem & ItemContextMetadata;

/**
 * Category-specific display data types for read-only item views
 */

export interface LoginDisplayData {
	title: string;
	url?: string;
	urls?: string[];
	username?: string;
	password?: string;
	passwordHistory?: PasswordHistoryEntry[];
	passkeys?: Passkey[];
	notes?: string;
	customFields?: CustomField[];
	tags?: string[];
	totpSecret?: string;
	totpIssuer?: string;
	totpAccountName?: string;
	totpAlgorithm?: TotpAlgorithm;
	totpDigits?: TotpDigits;
	totpPeriod?: number;
}

export interface SecureNoteDisplayData {
	title: string;
	note: string;
	tags?: string[];
}

export interface CreditCardDisplayData {
	title: string;
	cardholderName: string;
	cardNumber: string;
	cvv: string;
	expiryDate: string;
	billingAddress?: string;
	notes?: string;
	tags?: string[];
}

export interface IdentityDisplayData {
	title: string;
	firstName?: string;
	middleName?: string;
	lastName?: string;
	email?: string;
	addresses?: Address[];
	phoneNumbers?: PhoneNumber[];
	ssn?: string;
	passportNumber?: string;
	driversLicense?: string;
	dateOfBirth?: string;
	notes?: string;
	tags?: string[];
}

export interface TotpDisplayData {
	title: string;
	totpSecret: string;
	totpIssuer?: string;
	totpAccountName?: string;
	totpAlgorithm?: TotpAlgorithm;
	totpDigits?: TotpDigits;
	totpPeriod?: number;
	notes?: string;
	tags?: string[];
}

export type ItemDetailDisplayData =
	| LoginDisplayData
	| SecureNoteDisplayData
	| CreditCardDisplayData
	| IdentityDisplayData
	| TotpDisplayData;
