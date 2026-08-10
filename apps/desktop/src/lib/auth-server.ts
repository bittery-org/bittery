import { normalizeServerUrl } from "@bittery/shared/server-url";
import { storage } from "./storage";

const KNOWN_AUTH_SERVERS_STORAGE_KEY = "bittery_known_auth_servers";
const ACTIVE_AUTH_SERVER_STORAGE_KEY = "bittery_active_auth_server";
const MAX_KNOWN_AUTH_SERVERS = 10;
const activeAuthServerListeners = new Set<(serverUrl: string) => void>();

function getFallbackServerUrl(): string {
	const configured = import.meta.env.VITE_SERVER_URL;
	if (!configured?.trim()) return "http://localhost:3000";
	const normalized = normalizeServerUrl(configured);
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

		const normalized = normalizeServerUrl(item);
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

	return normalizeServerUrl(stored);
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
	const normalized = normalizeServerUrl(serverUrl);
	if (!normalized) {
		return readKnownServerUrls();
	}

	const existing = readKnownServerUrls().filter((url) => url !== normalized);
	const next = [normalized, ...existing].slice(0, MAX_KNOWN_AUTH_SERVERS);
	writeKnownServerUrls(next);
	return next;
}

export async function setActiveAuthServerUrl(
	serverUrl: string,
): Promise<string | null> {
	const normalized = normalizeServerUrl(serverUrl);
	if (!normalized) {
		return null;
	}

	const activeAccount = await storage.getActiveAccount();
	if (activeAccount) {
		await storage.storeServerUrl(normalized, activeAccount);
	}

	storeActiveServerUrl(normalized);
	rememberServerUrl(normalized);
	return normalized;
}

export async function resolveActiveAuthServerUrl(): Promise<string> {
	const activeAccount = await storage.getActiveAccount();
	if (activeAccount) {
		const activeAccountServerUrl = normalizeServerUrl(
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
		const accountServerUrl = normalizeServerUrl(
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
