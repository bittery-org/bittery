import type { DecryptedItem } from "@bittery/shared";

/**
 * Normalizes a string for case-insensitive searching
 */
function normalizeString(str: string | null | undefined): string {
	return (str || "").toLowerCase().trim();
}

/**
 * Checks if any of the provided values match the query
 */
function matchesQuery(
	query: string,
	...values: (string | null | undefined)[]
): boolean {
	const normalizedQuery = normalizeString(query);
	if (!normalizedQuery) return true; // Empty query matches everything

	return values.some((value) =>
		normalizeString(value).includes(normalizedQuery),
	);
}

/**
 * Filters login/credential items by query
 * Searches across: title, username, email, URL, vault name, account email
 */
export function filterLoginItems(
	items: DecryptedItem[],
	query: string,
): DecryptedItem[] {
	if (!query.trim()) return items;

	return items.filter((item) => {
		return matchesQuery(
			query,
			item.title,
			item.username,
			item.email,
			item.url,
			item.password,
		);
	});
}

/**
 * Filters credit card items by query
 * Searches across: title, cardholder name, last 4 digits, vault name, account email
 */
export function filterCreditCardItems(
	items: DecryptedItem[],
	query: string,
): DecryptedItem[] {
	if (!query.trim()) return items;

	return items.filter((item) => {
		return matchesQuery(
			query,
			item.title,
			item.cardholderName,
			item.cardNumber,
		);
	});
}

/**
 * Filters identity items by query
 * Searches across: title, name fields (first, middle, last), email, addresses, vault name, account email
 */
export function filterIdentityItems(
	items: DecryptedItem[],
	query: string,
): DecryptedItem[] {
	if (!query.trim()) return items;

	return items.filter((item) => {
		return matchesQuery(
			query,
			item.title,
			item.firstName,
			item.middleName,
			item.lastName,
			item.firstName,
			item.middleName,
			item.lastName,
			item.email,
			...(item.addresses || []).map(
				(addr) =>
					`${addr.street} ${addr.city} ${addr.state} ${addr.zip} ${addr.country}`,
			),
		);
	});
}
