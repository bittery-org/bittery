import { normalizeServerUrl } from "@bittery/shared/server-url";
import { storage } from "./storage";

const KNOWN_AUTH_SERVERS_STORAGE_KEY = "bittery_known_auth_servers";
const ACTIVE_AUTH_SERVER_STORAGE_KEY = "bittery_active_auth_server";
const MAX_KNOWN_AUTH_SERVERS = 10;
const activeAuthServerListeners = new Set<(serverUrl: string) => void>();

function getFallbackServerUrl(): string {
	return (
		normalizeServerUrl(import.meta.env.VITE_SERVER_URL ?? "") ??
		"http://localhost:3000"
	);
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
	if (activeAccount?.type === "single") {
		await storage.storeServerUrl(normalized, activeAccount.email);
	}

	storeActiveServerUrl(normalized);
	rememberServerUrl(normalized);
	return normalized;
}

export async function resolveActiveAuthServerUrl(): Promise<string> {
	const activeAccount = await storage.getActiveAccount();
	if (activeAccount?.type === "single") {
		const activeAccountServerUrl = normalizeServerUrl(
			(await storage.getServerUrl(activeAccount.email)) ?? "",
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

	const legacyServerUrl = normalizeServerUrl(
		(await storage.getLegacyServerUrl()) ?? "",
	);
	if (legacyServerUrl) {
		storeActiveServerUrl(legacyServerUrl);
		rememberServerUrl(legacyServerUrl);
		return legacyServerUrl;
	}

	const fallback = getFallbackServerUrl();
	storeActiveServerUrl(fallback);
	rememberServerUrl(fallback);
	return fallback;
}
