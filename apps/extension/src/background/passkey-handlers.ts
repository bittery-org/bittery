import type { DecryptedItem, DecryptedItemData, Passkey } from "@bittery/shared/types";
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
	PasskeyPageCreatePayload,
	PasskeyPageGetPayload,
	PasskeySerializedResult,
	SerializedCredentialDescriptor,
	SerializedGetResult,
} from "../passkey/types";
import { core } from "./core-instance";
import {
	ensureDesktopWriteCapability,
	hydrateDesktopAccountMaterial,
} from "./desktop-key-material";
import { desktopSync } from "./desktop-sync";
import { onLocalItemCreated, onLocalItemUpdated } from "./services/local-item-cache-service";
import { isUnlocked, updateActivity } from "./session-manager";
import { trpcClient } from "./trpc-client";
import type { MessageResponse } from "./types";
import { getDecryptedItemsForCurrentMode } from "./vault-utils";

const PASSKEY_FEATURE_FLAG_KEY = "feature_passkeys_v1_enabled";
const PASSKEY_TRANSPORTS: string[] = ["internal", "hybrid"];

type LoginItemWithAccount = DecryptedItem & {
	account?: {
		email?: string;
	};
};

type MatchedPasskey = {
	item: LoginItemWithAccount;
	passkey: Passkey;
	passkeyIndex: number;
};

type PasskeyHandlerResponse = MessageResponse & {
	fallbackToNative?: boolean;
	result?: PasskeySerializedResult;
};

async function isPasskeyFeatureEnabled(): Promise<boolean> {
	const value = await chrome.storage.local.get(PASSKEY_FEATURE_FLAG_KEY);
	const storedValue = value[PASSKEY_FEATURE_FLAG_KEY];
	if (typeof storedValue === "boolean") {
		return storedValue;
	}

	return import.meta.env.MODE !== "production";
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
		_encrypted: _encrypted,
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

async function resolveAccountEmailForVault(
	vaultId: string,
): Promise<string | undefined> {
	const activeAccount = await storage.getActiveAccount();
	if (activeAccount?.type === "single") {
		return activeAccount.email;
	}

	const localUnlockedEmails = (await storage.getUnlockedAccounts?.()) ?? [];
	const desktopStatus = desktopSync.getLastStatus();
	const desktopUnlockedEmails =
		desktopStatus?.available && !desktopStatus.locked
			? (desktopStatus.unlockedAccounts ?? [])
			: [];

	const unlockedEmails = Array.from(
		new Set([...localUnlockedEmails, ...desktopUnlockedEmails]),
	);

	for (const email of unlockedEmails) {
		await hydrateDesktopAccountMaterial(email);
		let vaultKeys = await storage.getVaultKeys(email);
		if (!vaultKeys || vaultKeys.length === 0) {
			const hydrated = await ensureDesktopWriteCapability(email);
			if (hydrated) {
				vaultKeys = await storage.getVaultKeys(email);
			}
		}
		if (vaultKeys?.some((vaultKey) => vaultKey.vaultId === vaultId)) {
			return email;
		}
	}

	return undefined;
}

async function resolveAccountEmailForItem(
	item: LoginItemWithAccount,
): Promise<string | undefined> {
	const activeAccount = await storage.getActiveAccount();
	if (activeAccount?.type !== "all") {
		return activeAccount?.type === "single" ? activeAccount.email : undefined;
	}

	return item.account?.email;
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

function matchesCreationRpId(item: LoginItemWithAccount, rpId: string): boolean {
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
}): Promise<void> {
	const writableVaults = (await trpcClient.vault.list.query()).filter(
		(vault) => vault.role !== "read-only",
	);
	const targetVault = writableVaults[0];
	if (!targetVault) {
		throw new Error("No writable vault available");
	}

	const accountEmail = await resolveAccountEmailForVault(targetVault.id);
	if (!accountEmail) {
		throw new Error("Unable to resolve account for writable vault");
	}

	const hasWriteCapability = await ensureDesktopWriteCapability(accountEmail);
	if (!hasWriteCapability) {
		throw new Error("No vault keys available for writable vault");
	}

	const createResult = await core.items.createItem(
		{
			vaultId: targetVault.id,
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
		vaultId: targetVault.id,
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
	};
}

async function findMatchingPasskeys(input: {
	rpId: string;
	allowCredentials?: SerializedCredentialDescriptor[];
}): Promise<MatchedPasskey[]> {
	const allowedIds = allowCredentialIds(input.allowCredentials);
	const items = await getLoginItems();
	const matches: MatchedPasskey[] = [];

	for (const item of items) {
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

	return matches.sort((left, right) => compareByMostRecent(left.passkey, right.passkey));
}

async function updateAssertionUsage(input: {
	match: MatchedPasskey;
	nextSignCount: number;
}): Promise<void> {
	const accountEmail = await resolveAccountEmailForItem(input.match.item);
	if (accountEmail) {
		const hasWriteCapability = await ensureDesktopWriteCapability(accountEmail);
		if (!hasWriteCapability) {
			throw new Error("No vault keys available for assertion update");
		}
	}

	const data = toDecryptedData(input.match.item);
	const nextPasskeys = [...(data.passkeys ?? [])];
	const current = nextPasskeys[input.match.passkeyIndex];
	if (!current) {
		throw new Error("Passkey index out of bounds");
	}
	nextPasskeys[input.match.passkeyIndex] = {
		...current,
		signCount: input.nextSignCount,
		lastUsedAt: new Date().toISOString(),
	};

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

export async function handlePasskeyCreate(payload: {
	requestId?: string;
} & PasskeyPageCreatePayload): Promise<PasskeyHandlerResponse> {
	updateActivity();

	if (!(await isPasskeyFeatureEnabled())) {
		return { success: true, fallbackToNative: true };
	}

	if (!isUnlocked()) {
		return {
			success: false,
			error: "Extension is locked",
			fallbackToNative: true,
		};
	}

	try {
		const rpId = deriveRpId(payload.origin, payload.publicKey.rp.id);
		const rpName = payload.publicKey.rp.name;
		const user = payload.publicKey.user;

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

		const loginItems = await getLoginItems();
		const candidateItems = loginItems.filter((item) =>
			matchesCreationRpId(item, rpId),
		);
		const attachTarget = pickCreateTarget(candidateItems, user.name);

		if (attachTarget) {
			await attachPasskeyToExistingItem({
				item: attachTarget,
				passkey,
			});
			console.info("[Passkey] create attached to existing item", {
				requestId: payload.requestId,
				rpId,
				itemId: attachTarget.id,
			});
		} else {
			await createItemWithPasskey({
				rpId,
				username: user.name,
				passkey,
			});
			console.info("[Passkey] create saved in new item", {
				requestId: payload.requestId,
				rpId,
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
		console.error("[Passkey] create failed:", error);
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
			fallbackToNative: true,
		};
	}
}

export async function handlePasskeyGet(payload: {
	requestId?: string;
} & PasskeyPageGetPayload): Promise<PasskeyHandlerResponse> {
	updateActivity();

	if (!(await isPasskeyFeatureEnabled())) {
		return { success: true, fallbackToNative: true };
	}

	if (!isUnlocked()) {
		return {
			success: false,
			error: "Extension is locked",
			fallbackToNative: true,
		};
	}

	try {
		const rpId = deriveRpId(payload.origin, payload.publicKey.rpId);
		const matches = await findMatchingPasskeys({
			rpId,
			allowCredentials: payload.publicKey.allowCredentials,
		});

		if (matches.length === 0) {
			console.info("[Passkey] get fallback: no matching credential", {
				requestId: payload.requestId,
				rpId,
			});
			return { success: true, fallbackToNative: true };
		}

		const match = matches[0];
		if (!match) {
			return { success: true, fallbackToNative: true };
		}

		const nextSignCount = (match.passkey.signCount ?? 0) + 1;
		const assertion = await signPasskeyAssertion({
			privateKeyBase64: match.passkey.privateKey,
			rpId,
			clientDataHashBase64: bytesToBase64(base64UrlToBytes(payload.clientDataHash)),
			signCount: nextSignCount,
		});

		await updateAssertionUsage({
			match,
			nextSignCount,
		});

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
		console.error("[Passkey] get failed:", error);
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
			fallbackToNative: true,
		};
	}
}

export async function handlePasskeyCancel(_payload: {
	requestId?: string;
}): Promise<PasskeyHandlerResponse> {
	return { success: true };
}
