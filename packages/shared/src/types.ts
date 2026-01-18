/**
 * Shared type definitions for decrypted vault items
 */

import type { Address, PhoneNumber } from "./identity";

/**
 * Item categories for vault items
 * Matches the itemCategoryEnum in the database schema
 */
export type ItemCategory = "login" | "secure-note" | "credit-card" | "identity";

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
