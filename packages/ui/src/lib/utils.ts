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
