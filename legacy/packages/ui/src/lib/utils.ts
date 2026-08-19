import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

export function getInitials(name: string): string {
	if (!name) return "??";
	const parts = name.trim().split(/\s+/);
	if (parts.length >= 2) {
		return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
	}
	return name.slice(0, 2).toUpperCase();
}

/**
 * Avatar initials for an account: team name, then personal name, then the email
 * prefix — never a raw-email slice artifact.
 *
 * Structurally typed rather than taking a named account type so every surface
 * (switcher, unlock screen, avatar group) can pass whatever shape it holds.
 */
export function getAccountInitials(account: {
	teamName?: string | null;
	name?: string | null;
	email: string;
}): string {
	const source = account.teamName || account.name;
	if (source) return getInitials(source);
	return account.email.slice(0, 2).toUpperCase();
}

/**
 * Display name for an account, matching the account switcher: team name, then
 * personal name, then the email local part — never the full address.
 */
export function getAccountLabel(account: {
	teamName?: string | null;
	name?: string | null;
	email: string;
}): string {
	return (
		account.teamName ||
		account.name ||
		account.email.split("@")[0] ||
		account.email
	);
}

/**
 * Whether picking an account is a real choice. One account is not a choice, so
 * every surface shows it instead of offering it.
 */
export function hasAccountChoice(accounts: { length: number }): boolean {
	return accounts.length > 1;
}

/**
 * The account a form should start on: the preferred one when it still exists,
 * otherwise the first. Keeps a stale or empty preference from leaving a
 * single-account form with nothing selected.
 */
export function resolveSelectedAccountId(
	accounts: readonly { accountId: string }[],
	preferredId: string | undefined,
): string | undefined {
	const preferred = accounts.find(
		(account) => account.accountId === preferredId,
	);
	return (preferred ?? accounts[0])?.accountId;
}
