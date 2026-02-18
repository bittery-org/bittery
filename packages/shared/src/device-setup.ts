import { normalizeServerUrl } from "./server-url";

const DEVICE_SETUP_SCHEME = "bittery:";
const DEVICE_SETUP_ROUTE = "login";
const DEVICE_SETUP_FLAG = "1";
const DEVICE_SETUP_VERSION = "1";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SECRET_KEY_PATTERN = /^A3(?:-[A-Z2-7]{4,8}){3,8}$/;

type ParamInput = string | string[] | null | undefined;

export interface DeviceSetupLinkPayload {
	email: string;
	serverUrl: string;
	teamName?: string;
}

export interface DeviceSetupQrPayload extends DeviceSetupLinkPayload {
	secretKey: string;
}

export interface ParsedDeviceSetupPayload extends DeviceSetupLinkPayload {
	version: "1";
	secretKey?: string;
}

export interface DeviceSetupParamPayload {
	setup?: ParamInput;
	v?: ParamInput;
	email?: ParamInput;
	serverUrl?: ParamInput;
	teamName?: ParamInput;
	secretKey?: ParamInput;
}

function getParamValue(value: ParamInput): string | null {
	if (Array.isArray(value)) {
		return value[0] ?? null;
	}
	return value ?? null;
}

function normalizeEmail(email: string): string {
	const normalizedEmail = email.trim().toLowerCase();
	if (!EMAIL_PATTERN.test(normalizedEmail)) {
		throw new Error("Invalid email in setup payload");
	}
	return normalizedEmail;
}

function normalizeSecretKey(secretKey: string): string {
	const normalizedSecretKey = secretKey.trim().toUpperCase();
	if (!SECRET_KEY_PATTERN.test(normalizedSecretKey)) {
		throw new Error("Invalid secret key in setup payload");
	}
	return normalizedSecretKey;
}

function normalizeTeamName(teamName: string | null): string | undefined {
	if (!teamName) return undefined;
	const normalizedTeamName = teamName.trim();
	return normalizedTeamName.length > 0 ? normalizedTeamName : undefined;
}

function normalizePayload(
	payload: DeviceSetupParamPayload,
): ParsedDeviceSetupPayload {
	const setup = getParamValue(payload.setup);
	if (setup !== DEVICE_SETUP_FLAG) {
		throw new Error("Invalid setup flag in setup payload");
	}

	const version = getParamValue(payload.v);
	if (version !== DEVICE_SETUP_VERSION) {
		throw new Error("Unsupported setup payload version");
	}

	const email = getParamValue(payload.email);
	if (!email) {
		throw new Error("Missing email in setup payload");
	}

	const serverUrl = getParamValue(payload.serverUrl);
	if (!serverUrl) {
		throw new Error("Missing server URL in setup payload");
	}

	const normalizedServerUrl = normalizeServerUrl(serverUrl);
	if (!normalizedServerUrl) {
		throw new Error("Invalid server URL in setup payload");
	}

	const secretKey = getParamValue(payload.secretKey);

	return {
		version: DEVICE_SETUP_VERSION,
		email: normalizeEmail(email),
		serverUrl: normalizedServerUrl,
		teamName: normalizeTeamName(getParamValue(payload.teamName)),
		secretKey: secretKey ? normalizeSecretKey(secretKey) : undefined,
	};
}

function createSetupUrl(payload: DeviceSetupQrPayload | DeviceSetupLinkPayload) {
	const normalizedServerUrl = normalizeServerUrl(payload.serverUrl);
	if (!normalizedServerUrl) {
		throw new Error("Invalid server URL in setup payload");
	}

	const url = new URL(`${DEVICE_SETUP_SCHEME}//${DEVICE_SETUP_ROUTE}`);
	url.searchParams.set("setup", DEVICE_SETUP_FLAG);
	url.searchParams.set("v", DEVICE_SETUP_VERSION);
	url.searchParams.set("email", normalizeEmail(payload.email));
	url.searchParams.set("serverUrl", normalizedServerUrl);

	const normalizedTeamName = normalizeTeamName(payload.teamName ?? null);
	if (normalizedTeamName) {
		url.searchParams.set("teamName", normalizedTeamName);
	}

	if ("secretKey" in payload) {
		url.searchParams.set("secretKey", normalizeSecretKey(payload.secretKey));
	}

	return url.toString();
}

function resolveRoute(url: URL): string {
	if (url.hostname) {
		return url.hostname.toLowerCase();
	}

	const normalizedPath = url.pathname.replace(/^\/+/, "");
	const firstSegment = normalizedPath.split("/")[0] ?? "";
	return firstSegment.toLowerCase();
}

export function buildDeviceSetupQrUri(payload: DeviceSetupQrPayload): string {
	return createSetupUrl(payload);
}

export function buildDeviceSetupLinkUri(payload: DeviceSetupLinkPayload): string {
	return createSetupUrl(payload);
}

export function parseDeviceSetupUri(uri: string): ParsedDeviceSetupPayload {
	let url: URL;
	try {
		url = new URL(uri.trim());
	} catch {
		throw new Error("Invalid setup QR code");
	}

	if (url.protocol.toLowerCase() !== DEVICE_SETUP_SCHEME) {
		throw new Error("Unsupported setup URI scheme");
	}

	if (resolveRoute(url) !== DEVICE_SETUP_ROUTE) {
		throw new Error("Unsupported setup URI route");
	}

	return normalizePayload({
		setup: url.searchParams.get("setup"),
		v: url.searchParams.get("v"),
		email: url.searchParams.get("email"),
		serverUrl: url.searchParams.get("serverUrl"),
		teamName: url.searchParams.get("teamName"),
		secretKey: url.searchParams.get("secretKey"),
	});
}

export function parseDeviceSetupParams(
	params: DeviceSetupParamPayload,
): ParsedDeviceSetupPayload | null {
	const setup = getParamValue(params.setup);
	if (setup !== DEVICE_SETUP_FLAG) {
		return null;
	}
	return normalizePayload(params);
}
