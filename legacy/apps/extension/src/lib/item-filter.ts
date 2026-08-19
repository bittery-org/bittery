import type { DecryptedItemWithContext } from "@bittery/shared/types";
import { rankByQuery } from "./autofill-ranking";

/**
 * Filters and ranks login/credential items by query.
 *
 * Searches title, username, email and URL — deliberately *not* the password.
 * Matching on the secret meant typing into a username field could surface an
 * item purely because its password contained those characters, which is both
 * confusing and a needless oracle.
 *
 * Results keep their incoming order for equally good matches, and callers feed
 * this the hostname-ranked list, so the site you are actually on stays on top.
 */
export function filterLoginItems(
	items: DecryptedItemWithContext[],
	query: string,
): DecryptedItemWithContext[] {
	return rankByQuery(items, query, (item) => [
		{ value: item.username, weight: 60 },
		{ value: item.email, weight: 55 },
		{ value: item.title, weight: 50 },
		{ value: item.url, weight: 30 },
	]);
}

/**
 * Filters credit card items by query
 * Searches across: title, cardholder name, last 4 digits, vault name, account email
 */
export function filterCreditCardItems(
	items: DecryptedItemWithContext[],
	query: string,
): DecryptedItemWithContext[] {
	return rankByQuery(items, query, (item) => [
		{ value: item.title, weight: 60 },
		{ value: item.cardholderName, weight: 50 },
		{ value: item.cardNumber, weight: 40 },
	]);
}

/**
 * Filters identity items by query
 * Searches across: title, name fields (first, middle, last), email, addresses, vault name, account email
 */
export function filterIdentityItems(
	items: DecryptedItemWithContext[],
	query: string,
): DecryptedItemWithContext[] {
	return rankByQuery(items, query, (item) => [
		{ value: item.firstName, weight: 60 },
		{ value: item.lastName, weight: 60 },
		{ value: item.email, weight: 55 },
		{ value: item.title, weight: 50 },
		{ value: item.middleName, weight: 40 },
		...(item.addresses || []).map((addr) => ({
			value: [addr.street, addr.city, addr.state, addr.zip, addr.country]
				.filter(Boolean)
				.join(" "),
			weight: 20,
		})),
	]);
}
