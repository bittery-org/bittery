const PUBLIC_STORAGE_KEY_PREFIXES = ["teams/", "vaults/"] as const;

export function isPublicStorageKeyAllowed(key: string): boolean {
	const normalizedKey = key.trim().replace(/^\/+/, "");
	if (!normalizedKey) {
		return false;
	}

	return PUBLIC_STORAGE_KEY_PREFIXES.some((prefix) =>
		normalizedKey.startsWith(prefix),
	);
}
