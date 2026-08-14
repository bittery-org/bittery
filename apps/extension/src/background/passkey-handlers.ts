import { getItemServerUrl } from "@bittery/shared/favicon";
import type {
	DecryptedItemData,
	DecryptedItemWithContext,
	Passkey,
} from "@bittery/shared/types";
import { toVaultKeyEntry } from "@bittery/shared/vault-mapping";
import { crypto } from "../lib/crypto";
import {
	normalizeHost,
	parseHostname,
	registrableDomain,
} from "../lib/hostname";
import { storage } from "../lib/storage";
import {
	base64ToBytes,
	base64UrlToBytes,
	bytesToBase64,
	bytesToBase64Url,
} from "../passkey/base64";
import type {
	PasskeyBackgroundResponse,
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
import { apiClient } from "./api-client";
import { ensureDesktopWriteCapability } from "./desktop-key-material";
import { getDesktopStatus, isDesktopUnlockedNow } from "./desktop-status";
import {
	createExtensionItem,
	type ExtensionItemCommands,
	updateExtensionItem,
} from "./extension-item-mutations";
import {
	resolveAccountIdForItem,
	resolveEmailFromAccountId,
} from "./services/account-resolution";
import {
	isUnlocked,
	setDesktopModeSentinel,
	updateActivity,
} from "./session-manager";
import { getDecryptedItemsForCurrentMode } from "./vault-utils";

const PASSKEY_TRANSPORTS: string[] = ["internal", "hybrid"];

type LoginItemWithAccount = DecryptedItemWithContext & {
	account?: {
		accountId?: string;
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

/**
 * The passkey sub-protocol already publishes this shape for the page bridge;
 * the background answers with exactly it rather than a second copy.
 */
export type PasskeyHandlerResponse = PasskeyBackgroundResponse;

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

const lastSignCountByCredentialId = new Map<string, number>();

function computeNextSignCount(
	credentialId: string,
	knownCount: number,
): number {
	const previousLocal = lastSignCountByCredentialId.get(credentialId) ?? 0;
	const epochSeconds = Math.floor(Date.now() / 1000);
	const next = Math.max(knownCount + 1, previousLocal + 1, epochSeconds);
	lastSignCountByCredentialId.set(credentialId, next);
	return next;
}

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

async function ensurePasskeyHandlerUnlocked(): Promise<boolean> {
	if (isUnlocked()) {
		return true;
	}

	if (await isDesktopUnlockedNow()) {
		// Service worker restarts can lose the desktop sentinel between picker and selection.
		setDesktopModeSentinel();
		return true;
	}

	// The cached status may be stale after a service worker restart between
	// the picker and selection steps; force a fresh check before giving up.
	const refreshedStatus = await getDesktopStatus({ refresh: true });
	const refreshedUnlocked = !!(
		refreshedStatus?.available &&
		!refreshedStatus.locked &&
		(refreshedStatus.unlockedAccounts?.length ?? 0) > 0
	);
	if (refreshedUnlocked) {
		setDesktopModeSentinel();
		return true;
	}

	return false;
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
		hosts.add(registrableDomain(host));
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

async function getLoginItems(
	runtime: ClientRuntime,
): Promise<LoginItemWithAccount[]> {
	const items = await getDecryptedItemsForCurrentMode(runtime);
	return items.filter((item): item is LoginItemWithAccount => {
		if (item?.category !== "login") {
			return false;
		}
		return true;
	});
}

async function resolveItemAccountId(
	item: LoginItemWithAccount,
): Promise<string | undefined> {
	return (
		item.accountId ??
		item.account?.accountId ??
		(await resolveAccountIdForItem(item.id))
	);
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
	const accountId = await storage.getActiveAccount();
	if (!accountId) return [];
	const accountEmail = await resolveEmailFromAccountId(accountId);
	const { data: vaults } = await apiClient.vaults.list();
	return vaults
		.map((vault) => {
			const decodedVault = toVaultKeyEntry({
				...vault,
				icon: vault.icon ?? null,
				imageUrl: vault.imageUrl ?? null,
			});
			return {
				id: decodedVault.vaultId,
				name: decodedVault.vaultName,
				accountId,
				accountEmail: readVaultAccountEmail(vault) ?? accountEmail,
				type: decodedVault.vaultType,
				role: decodedVault.role,
			};
		})
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
	itemCommands: ExtensionItemCommands;
}): Promise<void> {
	const accountId = await resolveItemAccountId(input.item);
	if (!accountId) {
		throw new Error("Unable to resolve account for item");
	}
	const hasWriteCapability = await ensureDesktopWriteCapability(accountId);
	if (!hasWriteCapability) {
		throw new Error("No vault keys available for item account");
	}

	const existingData = toDecryptedData(input.item);
	const nextPasskeys = [...(existingData.passkeys ?? []), input.passkey];

	await updateExtensionItem(
		{
			itemId: input.item.id,
			data: {
				...existingData,
				passkeys: nextPasskeys,
			},
			accountId,
		},
		input.itemCommands,
	);
}

async function createItemWithPasskey(input: {
	rpId: string;
	username: string;
	passkey: Passkey;
	targetVault: PasskeyWritableVaultOption;
	itemCommands: ExtensionItemCommands;
}): Promise<void> {
	const hasWriteCapability = await ensureDesktopWriteCapability(
		input.targetVault.accountId,
	);
	if (!hasWriteCapability) {
		throw new Error("No vault keys available for writable vault");
	}

	await createExtensionItem(
		{
			vaultId: input.targetVault.id,
			category: "login",
			data: {
				title: input.rpId,
				url: `https://${input.rpId}`,
				username: input.username,
				passkeys: [input.passkey],
			},
			accountId: input.targetVault.accountId,
		},
		input.itemCommands,
	);
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

async function findMatchingPasskeys(
	input: {
		rpId: string;
		allowCredentials?: SerializedCredentialDescriptor[];
	},
	runtime: ClientRuntime,
): Promise<MatchedPasskey[]> {
	const items = await getLoginItems(runtime);
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
	itemCommands: ExtensionItemCommands;
}): Promise<void> {
	const accountId = await resolveItemAccountId(input.match.item);
	if (!accountId) {
		throw new Error("Unable to resolve account for passkey update");
	}
	const hasWriteCapability = await ensureDesktopWriteCapability(accountId, {
		allowBiometricPrompt: input.allowBiometricPrompt,
	});
	if (!hasWriteCapability) {
		throw new Error("No vault keys available for passkey update");
	}

	const data = toDecryptedData(input.match.item);
	const nextPasskeys = [...(data.passkeys ?? [])];
	const current = nextPasskeys[input.match.passkeyIndex];
	if (!current) {
		throw new Error("Passkey index out of bounds");
	}
	nextPasskeys[input.match.passkeyIndex] = input.update(current);

	await updateExtensionItem(
		{
			itemId: input.match.item.id,
			data: {
				...data,
				passkeys: nextPasskeys,
			},
			accountId,
		},
		input.itemCommands,
	);
}

async function updateAssertionUsage(input: {
	match: MatchedPasskey;
	nextSignCount: number;
	itemCommands: ExtensionItemCommands;
}): Promise<void> {
	const usedAt = new Date().toISOString();
	await updateStoredPasskey({
		itemCommands: input.itemCommands,
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
	itemCommands: ExtensionItemCommands;
}): Promise<void> {
	const statusUpdatedAt = new Date().toISOString();
	await updateStoredPasskey({
		itemCommands: input.itemCommands,
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
	itemCommands: ExtensionItemCommands;
}): Promise<void> {
	try {
		await markPasskeyAsSuspect({
			itemCommands: input.itemCommands,
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
	runtime: ClientRuntime,
	itemCommands: ExtensionItemCommands,
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

		const loginItems = await getLoginItems(runtime);
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
		const keypair = await crypto.generatePasskeyKeypair();
		const credentialIdBase64 = await crypto.generatePasskeyCredentialId();
		const credentialId = bytesToBase64Url(base64ToBytes(credentialIdBase64));

		const attestation = await crypto.buildPasskeyAttestationObject(
			rpId,
			credentialIdBase64,
			keypair.publicKeyCose,
			0,
		);

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
				itemCommands,
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
				itemCommands,
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
	runtime: ClientRuntime,
	itemCommands: ExtensionItemCommands,
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
		const matches = await findMatchingPasskeys(
			{
				rpId,
				allowCredentials: payload.publicKey.allowCredentials,
			},
			runtime,
		);
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
				const rpMatches = await findMatchingPasskeys({ rpId }, runtime);
				const suspectMatch = resolveUnknownCredentialSuspectMatch({
					rpMatches,
					allowCredentials: payload.publicKey.allowCredentials,
					selectedCredentialId: payload.selectedCredentialId,
				});
				if (suspectMatch) {
					await markPasskeyAsSuspectSafely({
						itemCommands,
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
		const nextSignCount = computeNextSignCount(
			match.passkey.credentialId,
			match.passkey.signCount ?? 0,
		);
		stage = "signing";
		const assertion = await crypto.signPasskeyAssertion(
			match.passkey.privateKey,
			rpId,
			bytesToBase64(base64UrlToBytes(payload.clientDataHash)),
			nextSignCount,
		);

		stage = "persist";
		try {
			await updateAssertionUsage({
				itemCommands,
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
				itemCommands,
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

import type { ClientRuntime } from "@bittery/core/services/client-runtime";
