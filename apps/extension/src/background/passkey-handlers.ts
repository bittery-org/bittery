import { getItemServerUrl } from "@bittery/shared/favicon";
import type {
	DecryptedItemData,
	DecryptedItemWithContext,
	Passkey,
} from "@bittery/shared/types";
import { storage } from "../lib/storage";
import {
	buildPasskeyAttestationObject,
	generatePasskeyCredentialId,
	generatePasskeyKeypair,
	signPasskeyAssertion,
} from "../lib/wasm-crypto";
import {
	base64ToBytes,
	base64UrlToBytes,
	bytesToBase64,
	bytesToBase64Url,
} from "../passkey/base64";
import type {
	PasskeyCreateExistingItemOption,
	PasskeyCreateHandlerPayload,
	PasskeyCreateSaveDecision,
	PasskeyGetHandlerPayload,
	PasskeyGetPromptOption,
	PasskeySerializedResult,
	PasskeyUserInteractionRequest,
	PasskeyWritableVaultOption,
	SerializedCredentialDescriptor,
	SerializedGetResult,
} from "../passkey/types";
import { core } from "./core-instance";
import { ensureDesktopWriteCapability } from "./desktop-key-material";
import { desktopSync } from "./desktop-sync";
import { resolveAccountEmailForVault } from "./services/account-resolution";
import {
	onLocalItemCreated,
	onLocalItemUpdated,
} from "./services/local-item-cache-service";
import {
	isUnlocked,
	setDesktopModeSentinel,
	updateActivity,
} from "./session-manager";
import { trpcClient } from "./trpc-client";
import type { MessageResponse } from "./types";
import { getDecryptedItemsForCurrentMode } from "./vault-utils";

const PASSKEY_TRANSPORTS: string[] = ["internal", "hybrid"];

type LoginItemWithAccount = DecryptedItemWithContext & {
	account?: {
		email?: string;
		serverUrl?: string;
	};
	vault?: {
		name?: string;
	};
};

export type MatchedPasskey = {
	item: LoginItemWithAccount;
	passkey: Passkey;
	passkeyIndex: number;
};

export type PasskeyHandlerResponse = MessageResponse & {
	fallbackToNative?: boolean;
	result?: PasskeySerializedResult;
	requiresUserInteraction?: PasskeyUserInteractionRequest;
};

type PasskeyEventName =
	| "create_intercepted"
	| "get_intercepted"
	| "native_fallback"
	| "matching_error"
	| "signing_error"
	| "attach_create_decision"
	| "mark_suspect"
	| "handler_error";

type GetSelectionResolution =
	| {
			kind: "fallback";
			reason: "no_match" | "invalid_selection";
	  }
	| {
			kind: "prompt";
			options: PasskeyGetPromptOption[];
	  }
	| {
			kind: "selected";
			match: MatchedPasskey;
	  };

type CreateDecisionResolution =
	| {
			kind: "prompt";
	  }
	| {
			kind: "attach-existing";
			item: LoginItemWithAccount;
	  }
	| {
			kind: "create-new";
			vault: PasskeyWritableVaultOption;
	  }
	| {
			kind: "invalid";
			reason: string;
	  };

function getItemAccountEmail(item: LoginItemWithAccount): string | undefined {
	return item.accountEmail ?? item.account?.email;
}

function logPasskeyEvent(
	event: PasskeyEventName,
	metadata: Record<string, unknown>,
	level: "info" | "warn" | "error" = "info",
): void {
	const payload = {
		event,
		...metadata,
	};
	if (level === "error") {
		console.error("[Passkey]", payload);
		return;
	}
	if (level === "warn") {
		console.warn("[Passkey]", payload);
		return;
	}
	console.info("[Passkey]", payload);
}

async function isDesktopUnlockedNow(): Promise<boolean> {
	const cachedStatus = desktopSync.getLastStatus();
	const cachedUnlocked = !!(
		cachedStatus?.available &&
		!cachedStatus.locked &&
		(cachedStatus.unlockedAccounts?.length ?? 0) > 0
	);
	if (cachedUnlocked) {
		return true;
	}

	const refreshedStatus = await desktopSync.checkDesktopStatus();
	return !!(
		refreshedStatus?.available &&
		!refreshedStatus.locked &&
		(refreshedStatus.unlockedAccounts?.length ?? 0) > 0
	);
}

async function ensurePasskeyHandlerUnlocked(): Promise<boolean> {
	if (isUnlocked()) {
		return true;
	}

	if (await isDesktopUnlockedNow()) {
		// Service worker restarts can lose the desktop sentinel between picker and selection.
		setDesktopModeSentinel();
		return true;
	}

	return false;
}

function normalizeHost(value: string): string {
	return value.trim().toLowerCase().replace(/^\.+/, "").replace(/\.+$/, "");
}

function getBaseDomain(hostname: string): string {
	const parts = hostname.split(".").filter(Boolean);
	if (parts.length <= 2) {
		return hostname;
	}
	return parts.slice(-2).join(".");
}

function parseHostname(urlValue: string): string | null {
	try {
		const parsed = new URL(
			urlValue.startsWith("http://") || urlValue.startsWith("https://")
				? urlValue
				: `https://${urlValue}`,
		);
		return normalizeHost(parsed.hostname);
	} catch {
		return null;
	}
}

function deriveRpId(origin: string, rpId?: string): string {
	const originHost = parseHostname(origin);
	if (!originHost) {
		throw new Error("Invalid origin host");
	}

	if (!rpId) {
		return originHost;
	}

	const normalizedRpId = normalizeHost(rpId);
	const originMatchesRpId =
		originHost === normalizedRpId || originHost.endsWith(`.${normalizedRpId}`);
	if (!originMatchesRpId) {
		throw new Error("rpId does not match requesting origin");
	}

	return normalizedRpId;
}

function getItemCandidateRpIds(item: LoginItemWithAccount): string[] {
	const hosts = new Set<string>();
	const addHost = (urlValue?: string): void => {
		if (!urlValue) {
			return;
		}
		const host = parseHostname(urlValue);
		if (!host) {
			return;
		}

		hosts.add(host);
		hosts.add(getBaseDomain(host));
	};

	addHost(item.url);
	for (const urlValue of item.urls ?? []) {
		addHost(urlValue);
	}

	return Array.from(hosts);
}

function toDecryptedData(item: LoginItemWithAccount): DecryptedItemData {
	const record = item as LoginItemWithAccount & Record<string, unknown>;
	const {
		id: _id,
		vaultId: _vaultId,
		category: _category,
		favorite: _favorite,
		createdAt: _createdAt,
		updatedAt: _updatedAt,
		vault: _vault,
		account: _account,
		_encrypted,
		...data
	} = record;
	return data as DecryptedItemData;
}

function compareByMostRecent(
	left: Pick<Passkey, "lastUsedAt" | "createdAt">,
	right: Pick<Passkey, "lastUsedAt" | "createdAt">,
): number {
	const leftTime = Date.parse(left.lastUsedAt ?? left.createdAt);
	const rightTime = Date.parse(right.lastUsedAt ?? right.createdAt);
	return rightTime - leftTime;
}

async function getLoginItems(): Promise<LoginItemWithAccount[]> {
	const items = await getDecryptedItemsForCurrentMode();
	return items.filter((item): item is LoginItemWithAccount => {
		if (!item || item.category !== "login") {
			return false;
		}
		return true;
	});
}

async function resolveAccountEmailForItem(
	item: LoginItemWithAccount,
): Promise<string | undefined> {
	const itemAccountEmail = getItemAccountEmail(item);
	if (itemAccountEmail) {
		return itemAccountEmail;
	}

	const activeAccount = await storage.getActiveAccount();
	if (activeAccount?.type !== "all") {
		return activeAccount?.type === "single" ? activeAccount.email : undefined;
	}

	return undefined;
}

function allowCredentialIds(
	allowCredentials: SerializedCredentialDescriptor[] | undefined,
): Set<string> | null {
	if (!allowCredentials || allowCredentials.length === 0) {
		return null;
	}

	return new Set(
		allowCredentials
			.filter((descriptor) => descriptor.type === "public-key")
			.map((descriptor) => descriptor.id),
	);
}

function matchesCreationRpId(
	item: LoginItemWithAccount,
	rpId: string,
): boolean {
	return getItemCandidateRpIds(item).includes(rpId);
}

function matchesStoredPasskey(passkey: Passkey, rpId: string): boolean {
	return normalizeHost(passkey.rpId) === rpId;
}

function pickCreateTarget(
	candidates: LoginItemWithAccount[],
	userName: string,
): LoginItemWithAccount | null {
	if (candidates.length === 1) {
		return candidates[0] ?? null;
	}

	const userMatches = candidates.filter(
		(item) => item.username?.toLowerCase() === userName.toLowerCase(),
	);
	if (userMatches.length === 1) {
		return userMatches[0] ?? null;
	}

	return null;
}

function normalizeVaultRole(
	role: string,
): "owner" | "admin" | "member" | "read-only" {
	switch (role) {
		case "owner":
		case "admin":
		case "member":
		case "read-only":
			return role;
		default:
			return "member";
	}
}

function normalizeVaultType(type: string): "personal" | "team" {
	return type === "team" ? "team" : "personal";
}

function readVaultAccountEmail(vault: unknown): string | undefined {
	if (!vault || typeof vault !== "object") {
		return undefined;
	}
	const value = (vault as { accountEmail?: unknown }).accountEmail;
	return typeof value === "string" ? value : undefined;
}

async function getWritableVaultOptions(): Promise<
	PasskeyWritableVaultOption[]
> {
	const vaults = await trpcClient.vault.list.query();
	return vaults
		.map((vault) => ({
			id: vault.id,
			name: vault.name,
			accountEmail: readVaultAccountEmail(vault),
			type: normalizeVaultType(vault.type),
			role: normalizeVaultRole(vault.role),
		}))
		.filter((vault) => vault.role !== "read-only");
}

function pickWritableVault(
	vaults: PasskeyWritableVaultOption[],
	vaultId?: string,
): PasskeyWritableVaultOption | null {
	if (vaultId) {
		return vaults.find((vault) => vault.id === vaultId) ?? null;
	}
	return vaults[0] ?? null;
}

function getMostRecentMatchingPasskey(
	item: LoginItemWithAccount,
	rpId: string,
): Passkey | null {
	const matches = (item.passkeys ?? [])
		.filter((passkey) => matchesStoredPasskey(passkey, rpId))
		.sort(compareByMostRecent);
	return matches[0] ?? null;
}

function buildGetPromptOption(match: MatchedPasskey): PasskeyGetPromptOption {
	return {
		credentialId: match.passkey.credentialId,
		itemId: match.item.id,
		itemTitle: match.item.title,
		itemUrl: match.item.url,
		serverUrl: getItemServerUrl(match.item),
		itemUsername: match.item.username,
		passkeyUserName: match.passkey.userName,
		passkeyUserDisplayName: match.passkey.userDisplayName,
		vaultName: match.item.vault?.name,
		accountEmail: getItemAccountEmail(match.item),
		createdAt: match.passkey.createdAt,
		lastUsedAt: match.passkey.lastUsedAt,
	};
}

function buildCreateExistingItemOption(
	item: LoginItemWithAccount,
	rpId: string,
): PasskeyCreateExistingItemOption {
	const recentPasskey = getMostRecentMatchingPasskey(item, rpId);
	return {
		itemId: item.id,
		vaultId: item.vaultId,
		itemTitle: item.title,
		itemUrl: item.url,
		serverUrl: getItemServerUrl(item),
		itemUsername: item.username,
		vaultName: item.vault?.name,
		accountEmail: getItemAccountEmail(item),
		lastUsedAt: recentPasskey?.lastUsedAt ?? recentPasskey?.createdAt,
	};
}

export function resolveGetSelection(input: {
	matches: MatchedPasskey[];
	selectedCredentialId?: string;
}): GetSelectionResolution {
	if (input.matches.length === 0) {
		return {
			kind: "fallback",
			reason: "no_match",
		};
	}

	// Require an explicit user action before assertion, even for a single match.
	if (!input.selectedCredentialId) {
		return {
			kind: "prompt",
			options: input.matches.map(buildGetPromptOption),
		};
	}

	const selectedMatch = input.matches.find(
		(match) => match.passkey.credentialId === input.selectedCredentialId,
	);
	if (!selectedMatch) {
		return {
			kind: "fallback",
			reason: "invalid_selection",
		};
	}

	return {
		kind: "selected",
		match: selectedMatch,
	};
}

export function resolveUnknownCredentialSuspectMatch(input: {
	rpMatches: MatchedPasskey[];
	allowCredentials?: SerializedCredentialDescriptor[];
	selectedCredentialId?: string;
}): MatchedPasskey | null {
	const allowedIds = allowCredentialIds(input.allowCredentials);
	if (!allowedIds || allowedIds.size === 0) {
		return null;
	}

	if (input.selectedCredentialId) {
		return (
			input.rpMatches.find(
				(match) => match.passkey.credentialId === input.selectedCredentialId,
			) ?? null
		);
	}

	if (input.rpMatches.length === 1) {
		return input.rpMatches[0] ?? null;
	}

	return null;
}

export function resolveCreateDecision(input: {
	candidateItems: LoginItemWithAccount[];
	userName: string;
	writableVaults: PasskeyWritableVaultOption[];
	createDecision?: PasskeyCreateSaveDecision;
}): CreateDecisionResolution {
	const createDecision = input.createDecision;
	const autoAttachTarget = pickCreateTarget(
		input.candidateItems,
		input.userName,
	);
	const isAmbiguousCreate =
		input.candidateItems.length > 0 && !autoAttachTarget;

	if (createDecision?.action === "attach-existing") {
		const selectedItem = input.candidateItems.find(
			(item) => item.id === createDecision.itemId,
		);
		if (!selectedItem) {
			return {
				kind: "invalid",
				reason: "Selected item is not a valid passkey target",
			};
		}
		return {
			kind: "attach-existing",
			item: selectedItem,
		};
	}

	if (createDecision?.action === "create-new") {
		const selectedVault = pickWritableVault(
			input.writableVaults,
			createDecision.vaultId,
		);
		if (!selectedVault) {
			return {
				kind: "invalid",
				reason: "Selected vault is not writable",
			};
		}
		return {
			kind: "create-new",
			vault: selectedVault,
		};
	}

	if (autoAttachTarget) {
		return {
			kind: "attach-existing",
			item: autoAttachTarget,
		};
	}

	if (isAmbiguousCreate) {
		return {
			kind: "prompt",
		};
	}

	const defaultVault = pickWritableVault(input.writableVaults);
	if (!defaultVault) {
		return {
			kind: "invalid",
			reason: "No writable vault available",
		};
	}

	return {
		kind: "create-new",
		vault: defaultVault,
	};
}

async function attachPasskeyToExistingItem(input: {
	item: LoginItemWithAccount;
	passkey: Passkey;
}): Promise<void> {
	const accountEmail = await resolveAccountEmailForItem(input.item);
	if (accountEmail) {
		const hasWriteCapability = await ensureDesktopWriteCapability(accountEmail);
		if (!hasWriteCapability) {
			throw new Error("No vault keys available for item account");
		}
	}

	const existingData = toDecryptedData(input.item);
	const nextPasskeys = [...(existingData.passkeys ?? []), input.passkey];

	const updateResult = await core.items.updateItem(
		{
			itemId: input.item.id,
			vaultId: input.item.vaultId,
			data: {
				...existingData,
				passkeys: nextPasskeys,
			},
			accountEmail,
		},
		trpcClient as Parameters<typeof core.items.updateItem>[1],
	);

	await onLocalItemUpdated({
		itemId: input.item.id,
		encryptedData: updateResult._encryptedData,
		accountEmail: updateResult._accountEmail,
	});
}

async function createItemWithPasskey(input: {
	rpId: string;
	username: string;
	passkey: Passkey;
	targetVault: PasskeyWritableVaultOption;
}): Promise<void> {
	const accountEmail =
		input.targetVault.accountEmail ??
		(await resolveAccountEmailForVault(input.targetVault.id));
	if (!accountEmail) {
		throw new Error("Unable to resolve account for writable vault");
	}

	const hasWriteCapability = await ensureDesktopWriteCapability(accountEmail);
	if (!hasWriteCapability) {
		throw new Error("No vault keys available for writable vault");
	}

	const createResult = await core.items.createItem(
		{
			vaultId: input.targetVault.id,
			category: "login",
			data: {
				title: input.rpId,
				url: `https://${input.rpId}`,
				username: input.username,
				passkeys: [input.passkey],
			},
			accountEmail,
		},
		trpcClient as Parameters<typeof core.items.createItem>[1],
	);

	await onLocalItemCreated({
		itemId: createResult.itemId,
		vaultId: input.targetVault.id,
		category: "login",
		encryptedData: createResult._encryptedData,
		accountEmail: createResult._accountEmail,
	});
}

function buildCreateResult(input: {
	credentialId: string;
	clientDataJSON: string;
	attestationObjectBytes: Uint8Array;
}): PasskeySerializedResult {
	return {
		kind: "create",
		id: input.credentialId,
		rawId: input.credentialId,
		type: "public-key",
		response: {
			clientDataJSON: input.clientDataJSON,
			attestationObject: bytesToBase64Url(input.attestationObjectBytes),
		},
		authenticatorAttachment: "platform",
	};
}

function buildGetResult(input: {
	passkey: Passkey;
	clientDataJSON: string;
	authenticatorDataBytes: Uint8Array;
	signatureBytes: Uint8Array;
}): SerializedGetResult {
	return {
		kind: "get",
		id: input.passkey.credentialId,
		rawId: input.passkey.credentialId,
		type: "public-key",
		response: {
			clientDataJSON: input.clientDataJSON,
			authenticatorData: bytesToBase64Url(input.authenticatorDataBytes),
			signature: bytesToBase64Url(input.signatureBytes),
			userHandle: input.passkey.userHandle,
		},
		authenticatorAttachment: "platform",
	};
}

function toPasskeyModel(input: {
	credentialId: string;
	rpId: string;
	rpName: string;
	userHandle: string;
	userName: string;
	userDisplayName: string;
	privateKey: string;
	publicKey: string;
}): Passkey {
	return {
		credentialId: input.credentialId,
		rpId: input.rpId,
		rpName: input.rpName,
		userHandle: input.userHandle,
		userName: input.userName,
		userDisplayName: input.userDisplayName,
		privateKey: input.privateKey,
		publicKey: input.publicKey,
		algorithm: -7,
		signCount: 0,
		transports: PASSKEY_TRANSPORTS,
		createdAt: new Date().toISOString(),
		status: "active",
	};
}

export function findMatchingPasskeysForItems(input: {
	items: LoginItemWithAccount[];
	rpId: string;
	allowCredentials?: SerializedCredentialDescriptor[];
}): MatchedPasskey[] {
	const allowedIds = allowCredentialIds(input.allowCredentials);
	const matches: MatchedPasskey[] = [];

	for (const item of input.items) {
		const passkeys = item.passkeys ?? [];
		for (const [index, passkey] of passkeys.entries()) {
			if (!matchesStoredPasskey(passkey, input.rpId)) {
				continue;
			}
			if (allowedIds && !allowedIds.has(passkey.credentialId)) {
				continue;
			}

			matches.push({
				item,
				passkey,
				passkeyIndex: index,
			});
		}
	}

	return matches.sort((left, right) =>
		compareByMostRecent(left.passkey, right.passkey),
	);
}

async function findMatchingPasskeys(input: {
	rpId: string;
	allowCredentials?: SerializedCredentialDescriptor[];
}): Promise<MatchedPasskey[]> {
	const items = await getLoginItems();
	return findMatchingPasskeysForItems({
		items,
		rpId: input.rpId,
		allowCredentials: input.allowCredentials,
	});
}

async function updateStoredPasskey(input: {
	match: MatchedPasskey;
	update: (current: Passkey) => Passkey;
	allowBiometricPrompt?: boolean;
}): Promise<void> {
	const accountEmail = await resolveAccountEmailForItem(input.match.item);
	if (accountEmail) {
		const hasWriteCapability = await ensureDesktopWriteCapability(
			accountEmail,
			{
				allowBiometricPrompt: input.allowBiometricPrompt,
			},
		);
		if (!hasWriteCapability) {
			throw new Error("No vault keys available for passkey update");
		}
	}

	const data = toDecryptedData(input.match.item);
	const nextPasskeys = [...(data.passkeys ?? [])];
	const current = nextPasskeys[input.match.passkeyIndex];
	if (!current) {
		throw new Error("Passkey index out of bounds");
	}
	nextPasskeys[input.match.passkeyIndex] = input.update(current);

	const updateResult = await core.items.updateItem(
		{
			itemId: input.match.item.id,
			vaultId: input.match.item.vaultId,
			data: {
				...data,
				passkeys: nextPasskeys,
			},
			accountEmail,
		},
		trpcClient as Parameters<typeof core.items.updateItem>[1],
	);

	await onLocalItemUpdated({
		itemId: input.match.item.id,
		encryptedData: updateResult._encryptedData,
		accountEmail: updateResult._accountEmail,
	});
}

async function updateAssertionUsage(input: {
	match: MatchedPasskey;
	nextSignCount: number;
}): Promise<void> {
	const usedAt = new Date().toISOString();
	await updateStoredPasskey({
		match: input.match,
		update: (current) => ({
			...current,
			signCount: input.nextSignCount,
			lastUsedAt: usedAt,
			status: "active",
			statusReason: undefined,
			statusUpdatedAt: usedAt,
		}),
		allowBiometricPrompt: false,
	});
}

async function markPasskeyAsSuspect(input: {
	match: MatchedPasskey;
	reason: NonNullable<Passkey["statusReason"]>;
}): Promise<void> {
	const statusUpdatedAt = new Date().toISOString();
	await updateStoredPasskey({
		match: input.match,
		update: (current) => ({
			...current,
			status: "suspect",
			statusReason: input.reason,
			statusUpdatedAt,
		}),
		allowBiometricPrompt: false,
	});
}

async function markPasskeyAsSuspectSafely(input: {
	requestId?: string;
	rpId: string;
	match: MatchedPasskey;
	reason: NonNullable<Passkey["statusReason"]>;
}): Promise<void> {
	try {
		await markPasskeyAsSuspect({
			match: input.match,
			reason: input.reason,
		});
		logPasskeyEvent("mark_suspect", {
			requestId: input.requestId,
			rpId: input.rpId,
			credentialId: input.match.passkey.credentialId,
			reason: input.reason,
			flow: "get",
		});
	} catch (markError) {
		logPasskeyEvent(
			"handler_error",
			{
				requestId: input.requestId,
				rpId: input.rpId,
				stage: "mark_suspect",
				error:
					markError instanceof Error ? markError.message : String(markError),
				flow: "get",
			},
			"error",
		);
	}
}

function buildCreatePromptPayload(input: {
	rpId: string;
	rpName: string;
	userName: string;
	userDisplayName: string;
	candidateItems: LoginItemWithAccount[];
	writableVaults: PasskeyWritableVaultOption[];
}): Extract<PasskeyUserInteractionRequest, { kind: "create-save-target" }> {
	const existingItems = input.candidateItems
		.map((item) => buildCreateExistingItemOption(item, input.rpId))
		.sort((left, right) => {
			const leftTs = Date.parse(left.lastUsedAt ?? "1970-01-01T00:00:00.000Z");
			const rightTs = Date.parse(
				right.lastUsedAt ?? "1970-01-01T00:00:00.000Z",
			);
			return rightTs - leftTs;
		});

	return {
		kind: "create-save-target",
		rpId: input.rpId,
		rpName: input.rpName,
		userName: input.userName,
		userDisplayName: input.userDisplayName,
		existingItems,
		writableVaults: input.writableVaults,
	};
}

export async function handlePasskeyCreate(
	payload: PasskeyCreateHandlerPayload,
): Promise<PasskeyHandlerResponse> {
	updateActivity();
	logPasskeyEvent("create_intercepted", {
		requestId: payload.requestId,
		origin: payload.origin,
	});

	if (!(await ensurePasskeyHandlerUnlocked())) {
		logPasskeyEvent("native_fallback", {
			requestId: payload.requestId,
			reason: "locked",
			flow: "create",
		});
		return {
			success: false,
			error: "Extension is locked",
			fallbackToNative: true,
		};
	}

	let rpId = "";
	const rpName = payload.publicKey.rp.name;
	let stage: "matching" | "crypto" | "persist" = "matching";

	try {
		rpId = deriveRpId(payload.origin, payload.publicKey.rp.id);
		const user = payload.publicKey.user;

		const loginItems = await getLoginItems();
		const candidateItems = loginItems.filter((item) =>
			matchesCreationRpId(item, rpId),
		);
		const writableVaults = await getWritableVaultOptions();
		const createResolution = resolveCreateDecision({
			candidateItems,
			userName: user.name,
			writableVaults,
			createDecision: payload.createDecision,
		});

		if (createResolution.kind === "prompt") {
			logPasskeyEvent("attach_create_decision", {
				requestId: payload.requestId,
				rpId,
				decision: "prompt_required",
				candidateCount: candidateItems.length,
			});
			return {
				success: true,
				requiresUserInteraction: buildCreatePromptPayload({
					rpId,
					rpName,
					userName: user.name,
					userDisplayName: user.displayName,
					candidateItems,
					writableVaults,
				}),
			};
		}

		if (createResolution.kind === "invalid") {
			logPasskeyEvent(
				"native_fallback",
				{
					requestId: payload.requestId,
					rpId,
					reason: "invalid_create_decision",
					details: createResolution.reason,
					flow: "create",
				},
				"warn",
			);
			return {
				success: false,
				error: createResolution.reason,
				fallbackToNative: true,
			};
		}

		stage = "crypto";
		const keypair = await generatePasskeyKeypair();
		const credentialIdBase64 = await generatePasskeyCredentialId();
		const credentialId = bytesToBase64Url(base64ToBytes(credentialIdBase64));

		const attestation = await buildPasskeyAttestationObject({
			rpId,
			credentialIdBase64,
			cosePublicKeyBase64: keypair.publicKeyCose,
			signCount: 0,
		});

		const passkey = toPasskeyModel({
			credentialId,
			rpId,
			rpName,
			userHandle: user.id,
			userName: user.name,
			userDisplayName: user.displayName,
			privateKey: keypair.privateKey,
			publicKey: keypair.publicKeyCose,
		});

		stage = "persist";
		if (createResolution.kind === "attach-existing") {
			await attachPasskeyToExistingItem({
				item: createResolution.item,
				passkey,
			});
			logPasskeyEvent("attach_create_decision", {
				requestId: payload.requestId,
				rpId,
				decision: "attach-existing",
				itemId: createResolution.item.id,
				vaultId: createResolution.item.vaultId,
			});
		} else {
			await createItemWithPasskey({
				rpId,
				username: user.name,
				passkey,
				targetVault: createResolution.vault,
			});
			logPasskeyEvent("attach_create_decision", {
				requestId: payload.requestId,
				rpId,
				decision: "create-new",
				vaultId: createResolution.vault.id,
			});
		}

		return {
			success: true,
			result: buildCreateResult({
				credentialId,
				clientDataJSON: payload.clientDataJSON,
				attestationObjectBytes: attestation.attestationObject,
			}),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (stage === "matching") {
			logPasskeyEvent(
				"matching_error",
				{
					requestId: payload.requestId,
					rpId,
					error: message,
					flow: "create",
				},
				"error",
			);
		} else {
			logPasskeyEvent(
				"handler_error",
				{
					requestId: payload.requestId,
					rpId,
					stage,
					error: message,
					flow: "create",
				},
				"error",
			);
		}
		return {
			success: false,
			error: message,
			fallbackToNative: true,
		};
	}
}

export async function handlePasskeyGet(
	payload: PasskeyGetHandlerPayload,
): Promise<PasskeyHandlerResponse> {
	updateActivity();
	logPasskeyEvent("get_intercepted", {
		requestId: payload.requestId,
		origin: payload.origin,
	});

	if (!(await ensurePasskeyHandlerUnlocked())) {
		logPasskeyEvent("native_fallback", {
			requestId: payload.requestId,
			reason: "locked",
			flow: "get",
		});
		return {
			success: false,
			error: "Extension is locked",
			fallbackToNative: true,
		};
	}

	let rpId = "";
	let stage: "matching" | "signing" | "persist" = "matching";
	let selectedMatch: MatchedPasskey | null = null;
	try {
		rpId = deriveRpId(payload.origin, payload.publicKey.rpId);
		const matches = await findMatchingPasskeys({
			rpId,
			allowCredentials: payload.publicKey.allowCredentials,
		});
		logPasskeyEvent("get_intercepted", {
			requestId: payload.requestId,
			origin: payload.origin,
			rpId,
			selectedCredentialId: payload.selectedCredentialId,
			mediation: payload.mediation,
			allowCredentialsCount: payload.publicKey.allowCredentials?.length ?? 0,
			matchCount: matches.length,
			matchCredentialIds: matches.map((match) => match.passkey.credentialId),
		});
		const selection = resolveGetSelection({
			matches,
			selectedCredentialId: payload.selectedCredentialId,
		});

		if (selection.kind === "fallback") {
			logPasskeyEvent("native_fallback", {
				requestId: payload.requestId,
				rpId,
				reason: selection.reason,
				flow: "get",
				matchCount: matches.length,
			});
			if (selection.reason === "no_match") {
				const rpMatches = await findMatchingPasskeys({ rpId });
				const suspectMatch = resolveUnknownCredentialSuspectMatch({
					rpMatches,
					allowCredentials: payload.publicKey.allowCredentials,
					selectedCredentialId: payload.selectedCredentialId,
				});
				if (suspectMatch) {
					await markPasskeyAsSuspectSafely({
						requestId: payload.requestId,
						rpId,
						match: suspectMatch,
						reason: "unknown-credential",
					});
				}
				return { success: true, fallbackToNative: true };
			}
			return {
				success: false,
				error: "Selected passkey is no longer available",
				fallbackToNative: true,
			};
		}

		if (selection.kind === "prompt") {
			logPasskeyEvent("attach_create_decision", {
				requestId: payload.requestId,
				rpId,
				decision: "get-picker",
				optionCount: selection.options.length,
			});
			return {
				success: true,
				requiresUserInteraction: {
					kind: "get-picker",
					rpId,
					options: selection.options,
				},
			};
		}

		const match = selection.match;
		selectedMatch = match;
		const nextSignCount = (match.passkey.signCount ?? 0) + 1;
		stage = "signing";
		const assertion = await signPasskeyAssertion({
			privateKeyBase64: match.passkey.privateKey,
			rpId,
			clientDataHashBase64: bytesToBase64(
				base64UrlToBytes(payload.clientDataHash),
			),
			signCount: nextSignCount,
		});

		stage = "persist";
		try {
			await updateAssertionUsage({
				match,
				nextSignCount,
			});
		} catch (persistError) {
			logPasskeyEvent(
				"handler_error",
				{
					requestId: payload.requestId,
					rpId,
					stage: "persist",
					error:
						persistError instanceof Error
							? persistError.message
							: String(persistError),
					flow: "get",
				},
				"warn",
			);
		}

		return {
			success: true,
			result: buildGetResult({
				passkey: {
					...match.passkey,
					signCount: nextSignCount,
				},
				clientDataJSON: payload.clientDataJSON,
				authenticatorDataBytes: assertion.authenticatorData,
				signatureBytes: assertion.signatureDer,
			}),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (stage === "signing" && selectedMatch) {
			await markPasskeyAsSuspectSafely({
				requestId: payload.requestId,
				rpId,
				match: selectedMatch,
				reason: "signing-error",
			});
		}
		logPasskeyEvent(
			stage === "matching" ? "matching_error" : "signing_error",
			{
				requestId: payload.requestId,
				rpId,
				stage,
				error: message,
				flow: "get",
			},
			"error",
		);
		return {
			success: false,
			error: message,
			fallbackToNative: true,
		};
	}
}

export async function handlePasskeyCancel(payload: {
	requestId?: string;
}): Promise<PasskeyHandlerResponse> {
	logPasskeyEvent("native_fallback", {
		requestId: payload.requestId,
		reason: "request_cancelled",
		flow: "bridge",
	});
	return { success: true };
}
