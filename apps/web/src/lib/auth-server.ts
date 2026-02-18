import { normalizeServerUrl } from "@bittery/shared/server-url";
import { storage } from "./storage";

const KNOWN_AUTH_SERVERS_STORAGE_KEY = "bittery_known_auth_servers";
const MAX_KNOWN_AUTH_SERVERS = 10;

function getFallbackServerUrl(): string {
	return (
		normalizeServerUrl(import.meta.env.VITE_SERVER_URL ?? "") ??
		(typeof window !== "undefined"
			? window.location.origin
			: "http://localhost:3000")
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

	await storage.storeServerUrl(normalized);
	rememberServerUrl(normalized);
	return normalized;
}

export async function resolveActiveAuthServerUrl(): Promise<string> {
	const stored = await storage.getServerUrl();
	const normalized = normalizeServerUrl(stored ?? "");
	if (normalized) {
		rememberServerUrl(normalized);
		return normalized;
	}

	const fallback = getFallbackServerUrl();
	await storage.storeServerUrl(fallback);
	rememberServerUrl(fallback);
	return fallback;
}
