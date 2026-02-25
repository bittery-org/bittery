import type { PasswordHistoryEntry } from "./types";

export const PASSWORD_HISTORY_LIMIT = 10;

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isValidHistoryEntry(
	entry: PasswordHistoryEntry | null | undefined,
): entry is PasswordHistoryEntry {
	return Boolean(
		entry &&
			isNonEmptyString(entry.password) &&
			isNonEmptyString(entry.changedAt),
	);
}

export function normalizePasswordHistory(
	history?: PasswordHistoryEntry[],
	currentPassword?: string,
): PasswordHistoryEntry[] | undefined {
	if (!history || history.length === 0) {
		return undefined;
	}

	const seenPasswords = new Set<string>();
	const normalized: PasswordHistoryEntry[] = [];

	for (const entry of history) {
		if (!isValidHistoryEntry(entry)) {
			continue;
		}
		if (entry.password === currentPassword) {
			continue;
		}
		if (seenPasswords.has(entry.password)) {
			continue;
		}

		seenPasswords.add(entry.password);
		normalized.push({
			password: entry.password,
			changedAt: entry.changedAt,
		});

		if (normalized.length >= PASSWORD_HISTORY_LIMIT) {
			break;
		}
	}

	return normalized.length > 0 ? normalized : undefined;
}

export interface ApplyPasswordHistoryOnPasswordChangeInput {
	passwordHistory?: PasswordHistoryEntry[];
	previousPassword?: string;
	nextPassword?: string;
	changedAt?: string;
}

export function applyPasswordHistoryOnPasswordChange({
	passwordHistory,
	previousPassword,
	nextPassword,
	changedAt,
}: ApplyPasswordHistoryOnPasswordChangeInput):
	| PasswordHistoryEntry[]
	| undefined {
	const normalizedHistory = normalizePasswordHistory(
		passwordHistory,
		nextPassword,
	);

	if (
		!isNonEmptyString(previousPassword) ||
		previousPassword === nextPassword
	) {
		return normalizedHistory;
	}

	return normalizePasswordHistory(
		[
			{
				password: previousPassword,
				changedAt: changedAt ?? new Date().toISOString(),
			},
			...(normalizedHistory ?? []),
		],
		nextPassword,
	);
}
