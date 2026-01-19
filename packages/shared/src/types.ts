/**
 * Shared type definitions for decrypted vault items
 */

import type { Address, PhoneNumber } from "./identity";

/**
 * Item categories for vault items
 * Matches the itemCategoryEnum in the database schema
 */
export type ItemCategory = "login" | "secure-note" | "credit-card" | "identity" | "totp";

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
	notes?: string;
	note?: string;
	customFields?: CustomField[];
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
