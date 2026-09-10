import { normalizeServerUrl } from "@bittery/shared/server-url";
import { storage } from "./storage";

const KNOWN_AUTH_SERVERS_STORAGE_KEY = "bittery_known_auth_servers";
const ACTIVE_AUTH_SERVER_STORAGE_KEY = "bittery_active_auth_server";
const MAX_KNOWN_AUTH_SERVERS = 10;
const activeAuthServerListeners = new Set<(serverUrl: string) => void>();

function normalizeAuthServerUrl(value: string): string | null {
	return normalizeServerUrl(value, {
		operatorEnabled: true,
		accountConfirmed: true,
	});
}

function getFallbackServerUrl(): string {
	const configured = import.meta.env.VITE_SERVER_URL;
	if (!configured?.trim()) return "http://localhost:3000";
	const normalized = normalizeAuthServerUrl(configured);
	if (!normalized) {
		throw new TypeError(
			"Configured server URL is invalid or remote HTTP transport is not authorized.",
		);
	}
	return normalized;
}

function normalizeServerList(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	const uniqueServers = new Set<string>();
	for (const item of value) {
		if (typeof item !== "string") {
			continue;
		}

		const normalized = normalizeAuthServerUrl(item);
		if (normalized) {
			uniqueServers.add(normalized);
		}

		if (uniqueServers.size >= MAX_KNOWN_AUTH_SERVERS) {
			break;
		}
	}

	return [...uniqueServers];
}

function writeKnownServerUrls(serverUrls: string[]): void {
	if (typeof window === "undefined") {
		return;
	}

	window.localStorage.setItem(
		KNOWN_AUTH_SERVERS_STORAGE_KEY,
		JSON.stringify(serverUrls),
	);
}

function notifyServerChange(serverUrl: string): void {
	for (const listener of [...activeAuthServerListeners]) {
		listener(serverUrl);
	}
}

function storeActiveServerUrl(serverUrl: string): void {
	if (typeof window === "undefined") {
		return;
	}

	window.localStorage.setItem(ACTIVE_AUTH_SERVER_STORAGE_KEY, serverUrl);
	notifyServerChange(serverUrl);
}

function readStoredActiveServerUrl(): string | null {
	if (typeof window === "undefined") {
		return null;
	}

	const stored = window.localStorage.getItem(ACTIVE_AUTH_SERVER_STORAGE_KEY);
	if (!stored) {
		return null;
	}

	return normalizeAuthServerUrl(stored);
}

export function subscribeActiveAuthServerUrl(
	onChange: (serverUrl: string) => void,
): () => void {
	activeAuthServerListeners.add(onChange);
	return () => {
		activeAuthServerListeners.delete(onChange);
	};
}

export function readCurrentAuthServerUrl(): string {
	return readStoredActiveServerUrl() ?? getFallbackServerUrl();
}

export function readKnownServerUrls(): string[] {
	if (typeof window === "undefined") {
		return [];
	}

	const stored = window.localStorage.getItem(KNOWN_AUTH_SERVERS_STORAGE_KEY);
	if (!stored) {
		return [];
	}

	try {
		return normalizeServerList(JSON.parse(stored));
	} catch {
		return [];
	}
}

export function rememberServerUrl(serverUrl: string): string[] {
	const normalized = normalizeAuthServerUrl(serverUrl);
	if (!normalized) {
		return readKnownServerUrls();
	}

	const existing = readKnownServerUrls().filter((url) => url !== normalized);
	const next = [normalized, ...existing].slice(0, MAX_KNOWN_AUTH_SERVERS);
	writeKnownServerUrls(next);
	return next;
}

/**
 * Drop a URL from the recency list. The active server and any account assignment
 * stay put — this is only the picker's remembered hosts.
 */
export function forgetServerUrl(serverUrl: string): string[] {
	const normalized = normalizeAuthServerUrl(serverUrl);
	const current = readKnownServerUrls();
	if (!normalized) {
		return current;
	}

	const next = current.filter((url) => url !== normalized);
	writeKnownServerUrls(next);
	return next;
}

/** Hostname (and port, when it is not the default) for a picker row. */
export function getServerLabel(serverUrl: string): string {
	try {
		const parsed = new URL(serverUrl);
		return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
	} catch {
		return serverUrl;
	}
}

export async function setActiveAuthServerUrl(
	serverUrl: string,
	options?: { persistToAccount?: boolean },
): Promise<string | null> {
	const normalized = normalizeAuthServerUrl(serverUrl);
	if (!normalized) {
		return null;
	}

	// "Add account" is already sitting on another account. Writing through
	// would re-point that account at a host it never signed in to.
	if (options?.persistToAccount !== false) {
		const activeAccount = await storage.getActiveAccount();
		if (activeAccount) {
			await storage.storeServerUrl(normalized, activeAccount);
		}
	}

	storeActiveServerUrl(normalized);
	rememberServerUrl(normalized);
	return normalized;
}

export async function resolveActiveAuthServerUrl(): Promise<string> {
	const activeAccount = await storage.getActiveAccount();
	if (activeAccount) {
		const activeAccountServerUrl = normalizeAuthServerUrl(
			(await storage.getServerUrl(activeAccount)) ?? "",
		);

		if (activeAccountServerUrl) {
			storeActiveServerUrl(activeAccountServerUrl);
			rememberServerUrl(activeAccountServerUrl);
			return activeAccountServerUrl;
		}
	}

	const activeServerUrl = readStoredActiveServerUrl();
	if (activeServerUrl) {
		rememberServerUrl(activeServerUrl);
		return activeServerUrl;
	}

	// When nothing is active yet (first paint after a restart, or straight after a
	// sign-out), fall back to the first account that has a server URL rather than jumping
	// to the build default.
	for (const account of await storage.getAccountsList()) {
		const accountServerUrl = normalizeAuthServerUrl(
			(await storage.getServerUrl(account.accountId)) ?? "",
		);
		if (accountServerUrl) {
			storeActiveServerUrl(accountServerUrl);
			rememberServerUrl(accountServerUrl);
			return accountServerUrl;
		}
	}

	const fallback = getFallbackServerUrl();
	storeActiveServerUrl(fallback);
	rememberServerUrl(fallback);
	return fallback;
}
