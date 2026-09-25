/**
 * Ticket 91 maintained source cut. A real Bootstrap is paused at its first
 * Item-page network await, after its Vault stage and raw active baselines exist.
 * This does not implement admission or exercise the separate Sync checkpoint.
 */
import { beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { SyncBootstrapPage } from "@bittery/api-contract";
import { serverEncryptedItem } from "@bittery/shared/testing/item-fixtures";
import { createItemCache, metaCollection } from "@bittery/storage";
import {
	createInMemoryRecordPort,
	type InMemoryRecordPort,
} from "@bittery/storage/testing";
import {
	accountMetadata,
	createTestAccountStore,
} from "../testing/account-store-harness";
import {
	AccountVaultReplica,
	type BootstrapItemsClient,
} from "./account-vault-replica";
import {
	getTravelModeEnforcer,
	resetTravelModeEnforcerForTests,
} from "./travel-mode-enforcer";
import { createVaultCrypto } from "./vault-crypto";

const accountId = "acc-duplicate-stage";
const userId = `user-${accountId}`;
const serverUrl = "https://bittery.test";
const accountEmail = `${accountId}@test.com`;
const vaultId = "vault-duplicate";
const itemId = "item-duplicate";
type RawRecord = { id: string; value: string };

async function records(
	port: InMemoryRecordPort,
	collection: string,
): Promise<RawRecord[]> {
	return (await port.recordList(collection)).sort((a, b) =>
		a.id.localeCompare(b.id),
	);
}

async function withTimeout<T>(work: Promise<T>, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(message)), 5_000);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

beforeEach(() => resetTravelModeEnforcerForTests());

function comparableCapture(capture: {
	initialStateRaw: string;
	stateRaw: string;
	stage: Record<string, RawRecord[]>;
	stagedItemsName: string;
	[key: string]: unknown;
}) {
	const state = JSON.parse(capture.stateRaw);
	const activeGeneration = state.activeGeneration as string;
	const stagePrefix = `item-cache-stage:${accountId}:`;
	const stagedCollections = Object.keys(capture.stage);
	expect(stagedCollections).toHaveLength(3);
	const pendingGeneration = stagedCollections[0]
		?.slice(stagePrefix.length)
		.split(":")[0];
	expect(pendingGeneration).toBeTruthy();
	const normalizedState = (raw: string) => {
		const value = JSON.parse(raw);
		expect(value.activeGeneration).toBe(activeGeneration);
		expect(value.nativeView.itemsKeyPrefix).toBe(
			`record:${stagePrefix}${activeGeneration}:items:`,
		);
		expect(value.nativeView.vaultsKeyPrefix).toBe(
			`record:${stagePrefix}${activeGeneration}:vaults:`,
		);
		value.activeGeneration = "<active-generation>";
		value.nativeView.itemsKeyPrefix = `record:${stagePrefix}<active-generation>:items:`;
		value.nativeView.vaultsKeyPrefix = `record:${stagePrefix}<active-generation>:vaults:`;
		value.metadata.lastFullSyncAt = "<full-sync-time>";
		return value;
	};
	const normalizedStage = Object.fromEntries(
		stagedCollections.map((name) => {
			expect(name.startsWith(`${stagePrefix}${pendingGeneration}:`)).toBe(true);
			return [
				name.replace(
					`${stagePrefix}${pendingGeneration}:`,
					`${stagePrefix}<pending-generation>:`,
				),
				capture.stage[name],
			];
		}),
	);
	expect(capture.stagedItemsName).toBe(
		`${stagePrefix}${pendingGeneration}:items`,
	);
	return {
		...capture,
		initialStateRaw: normalizedState(capture.initialStateRaw),
		stateRaw: normalizedState(capture.stateRaw),
		stage: normalizedStage,
		stagedItemsName: `${stagePrefix}<pending-generation>:items`,
	};
}

test("actual first Item-page wait leaves only byte-duplicate unpublished rows", async () => {
	const frozenCapture = JSON.parse(
		readFileSync(
			new URL(
				"./fixtures/legacy-item-cache-duplicate-only-native-first-item-page.json",
				import.meta.url,
			),
			"utf8",
		),
	);
	expect(frozenCapture.frozenTree).toBe(
		"841ead9af08c2bcc51b1bd6e2f80f043d7e370c4",
	);
	expect(frozenCapture.boundary).toBe(
		"AccountVaultReplica.hydrateFromServer awaited first Item page",
	);
	expect(frozenCapture.activeItems).toEqual(frozenCapture.initialActiveItems);
	expect(frozenCapture.activeVaults).toEqual(frozenCapture.initialActiveVaults);
	expect(frozenCapture.stagedItems).toEqual([]);
	const trace: string[] = [];
	const { store, crypto } = await createTestAccountStore();
	// Match Desktop's physical RecordPort key namespace in the raw pointer.
	const port = createInMemoryRecordPort({ recordKeyPrefix: "record:" });
	const cache = createItemCache({ port });
	await cache.initialize();
	await store.addAccount(accountMetadata({ accountId, email: accountEmail }));
	await store.storeServerUrl(serverUrl, accountId);
	const masterUnlockKey = await crypto.importKey(new Uint8Array(32));
	await store.setMasterUnlockKey(masterUnlockKey, accountId);
	const vaultCrypto = createVaultCrypto({ crypto, storage: store });
	const frozenVault = JSON.parse(frozenCapture.serverVaultWireRaw) as {
		encryptedVaultKey: string;
	};
	const encryptedVaultKey = frozenVault.encryptedVaultKey;
	await store.storeVaultKeys(
		[
			{
				vaultId,
				vaultName: "Unchanged Vault",
				vaultType: "personal",
				vaultIcon: null,
				vaultImageUrl: null,
				encryptedVaultKey,
				role: "owner",
			},
		],
		accountId,
	);
	await getTravelModeEnforcer(store, cache).applyConfig(accountId, {
		enabled: false,
		hiddenVaultIds: [],
	});
	const repo = new AccountVaultReplica(
		crypto,
		vaultCrypto,
		store,
		cache,
		accountId,
		serverUrl,
		accountEmail,
	);
	const retainedKey = await vaultCrypto.getVaultKey({
		vaultId,
		accountId,
		userId,
	});
	if (!retainedKey) throw new Error("Missing test Vault key");
	const frozenItem = JSON.parse(frozenCapture.activeItems[0].value) as {
		encryptedData: string;
		encryptionIv: string;
		encryptionAlgorithm: string;
	};
	await crypto.destroyKey(retainedKey);
	const item = serverEncryptedItem({
		id: itemId,
		vaultId,
		version: 1,
		encryptionVersion: 1,
		encryptedData: frozenItem.encryptedData,
		encryptionIv: frozenItem.encryptionIv,
		encryptionAlgorithm: frozenItem.encryptionAlgorithm,
		encryptedByUserId: userId,
		lastModifiedBy: userId,
		createdAt: "2026-09-01T00:00:00.000Z",
		updatedAt: "2026-09-01T00:00:00.000Z",
		attachments: [],
	});
	const vault = Object.freeze({
		id: vaultId,
		name: "Unchanged Vault",
		vaultType: "personal" as const,
		icon: null,
		imageUrl: null,
		encryptedVaultKey,
		role: "owner" as const,
	});
	const serverVaultWireRaw = JSON.stringify(vault);
	const initialPages: SyncBootstrapPage[] = [
		{
			phase: "vaults",
			vaults: [vault],
			hasMore: false,
			syncCursor: { id: "evt-original" },
		},
		{
			phase: "items",
			items: [{ ...item, attachments: item.attachments ?? [] }],
			hasMore: false,
			syncCursor: { id: "evt-original" },
		},
	];
	let initialIndex = 0;
	const initialClient: BootstrapItemsClient = {
		sync: {
			bootstrap: async (request) => {
				const page = initialPages[initialIndex++];
				if (!page || page.phase !== request.phase)
					throw new Error("Unexpected initial Bootstrap page");
				trace.push(`initial:${page.phase}`);
				return { data: page };
			},
		},
	};
	await repo.hydrateFromServer(initialClient);
	trace.push("initial:promoted");
	const initialStateRaw = await port.recordGet(
		metaCollection(accountId),
		"meta",
	);
	if (!initialStateRaw) throw new Error("Missing initial ItemCache pointer");
	const initialState = JSON.parse(initialStateRaw) as {
		activeGeneration: string;
		nativeView: { itemsKeyPrefix: string; vaultsKeyPrefix: string };
		metadata: { syncBaseline: { cursorId: string } };
	};
	const activeItemsCollection = initialState.nativeView.itemsKeyPrefix.slice(
		port.recordKeyPrefix.length,
		-1,
	);
	const activeVaultsCollection = initialState.nativeView.vaultsKeyPrefix.slice(
		port.recordKeyPrefix.length,
		-1,
	);
	const initialActiveItems = await records(port, activeItemsCollection);
	const initialActiveVaults = await records(port, activeVaultsCollection);
	expect(initialState.activeGeneration).toBeTruthy();
	expect(initialState.metadata.syncBaseline.cursorId).toBe("evt-original");
	expect(initialActiveItems.map(({ id }) => id)).toEqual([itemId]);
	expect(initialActiveVaults.map(({ id }) => id)).toEqual([vaultId]);

	let signalItemPage!: () => void;
	const itemPageRequested = new Promise<void>((resolve) => {
		signalItemPage = resolve;
	});
	let rejectHeldPage!: (error: Error) => void;
	const heldPage = new Promise<{ data: SyncBootstrapPage }>(
		(_resolve, reject) => {
			rejectHeldPage = reject;
		},
	);
	void heldPage.catch(() => undefined);
	const secondClient: BootstrapItemsClient = {
		sync: {
			bootstrap: async (request) => {
				if (request.phase === "vaults") {
					trace.push("second:vault-page-returned");
					return {
						data: {
							phase: "vaults",
							vaults: [vault],
							hasMore: false,
							syncCursor: { id: "evt-new-unpublished" },
						} as SyncBootstrapPage,
					};
				}
				if (request.phase !== "items" || request.cursor !== undefined) {
					throw new Error("Expected first Item-page request");
				}
				trace.push("second:first-item-page-await-entered");
				signalItemPage();
				return await heldPage;
			},
		},
	};
	const secondBootstrap = repo.hydrateFromServer(secondClient);
	const observedSecond = secondBootstrap.then(
		() => ({ kind: "resolved" as const }),
		(error: unknown) => ({ kind: "rejected" as const, error }),
	);
	const controlledFailure = new Error(
		"controlled failure after duplicate-only capture",
	);
	const capturePath = process.env.BITTERY_CACHE_DUPLICATE_CAPTURE;
	let stageNames: string[] = [];
	let activeItemsAtCapture: RawRecord[] | undefined;
	let activeVaultsAtCapture: RawRecord[] | undefined;
	try {
		await withTimeout(
			itemPageRequested,
			"Bootstrap did not request its first Item page",
		);
		const stateRaw = await port.recordGet(metaCollection(accountId), "meta");
		if (!stateRaw) throw new Error("Missing pointer at capture");
		stageNames = port
			.collections()
			.filter(
				(name) =>
					name.startsWith(`item-cache-stage:${accountId}:`) &&
					!name.includes(initialState.activeGeneration),
			);
		const stage = Object.fromEntries(
			await Promise.all(
				stageNames.map(async (name) => [name, await records(port, name)]),
			),
		);
		const stageEntry = (suffix: string): RawRecord[] => {
			const name = stageNames.find((candidate) =>
				candidate.endsWith(`:${suffix}`),
			);
			if (!name) throw new Error(`Missing stage collection ${suffix}`);
			return stage[name] as RawRecord[];
		};
		const itemBaseline = stageEntry("item-baseline");
		const vaultBaseline = stageEntry("vault-baseline");
		const stagedVaults = stageEntry("vaults");
		const vaultStageName = stageNames.find((name) => name.endsWith(":vaults"));
		if (!vaultStageName) throw new Error("Missing staged Vault collection");
		const stagedItemsName = vaultStageName.replace(/:vaults$/, ":items");
		const stagedItems = await records(port, stagedItemsName);
		const activeItems = await records(port, activeItemsCollection);
		const activeVaults = await records(port, activeVaultsCollection);
		activeItemsAtCapture = activeItems;
		activeVaultsAtCapture = activeVaults;
		trace.push("capture:before-error-release-and-discard");
		const capture = {
			frozenTree: "841ead9af08c2bcc51b1bd6e2f80f043d7e370c4",
			boundary: "AccountVaultReplica.hydrateFromServer awaited first Item page",
			trace,
			serverVaultWireRaw,
			serverVaultWireRawAtCapture: JSON.stringify(vault),
			initialStateRaw,
			stateRaw,
			initialActiveItems,
			initialActiveVaults,
			activeItems,
			activeVaults,
			stage,
			stagedItemsName,
			stagedItems,
		};
		expect(comparableCapture(capture)).toEqual(
			comparableCapture(frozenCapture),
		);
		if (capturePath)
			await Bun.write(capturePath, `${JSON.stringify(capture, null, 2)}\n`);

		expect(stateRaw).toBe(initialStateRaw);
		expect(JSON.stringify(vault)).toBe(serverVaultWireRaw);
		expect(activeItems).toEqual(initialActiveItems);
		expect(activeVaults).toEqual(initialActiveVaults);
		expect(stageNames).toHaveLength(3);
		expect(
			stageNames.map((name) => name.slice(name.lastIndexOf(":") + 1)).sort(),
		).toEqual(["item-baseline", "vault-baseline", "vaults"]);
		expect(itemBaseline).toEqual(activeItems);
		expect(vaultBaseline).toEqual(activeVaults);
		expect(stagedVaults).toEqual(activeVaults);
		expect(stagedItems).toEqual([]);
		expect(port.collections()).not.toContain(stagedItemsName);
		expect(
			(await cache.getCachedItems(accountId))?.map(({ id }) => id),
		).toEqual([itemId]);
		expect(
			(await cache.getItemCacheMetadata(accountId))?.syncBaseline?.cursorId,
		).toBe("evt-original");
	} finally {
		rejectHeldPage(controlledFailure);
		const outcome = await withTimeout(
			observedSecond,
			"Bootstrap did not settle after page release",
		);
		expect(outcome.kind).toBe("rejected");
		if (outcome.kind === "rejected")
			expect(outcome.error).toBe(controlledFailure);
		trace.push("second:catch-discard-settled");
		if (capturePath)
			await Bun.write(
				`${capturePath}.trace.json`,
				`${JSON.stringify(trace, null, 2)}\n`,
			);
	}
	for (const name of stageNames) expect(await records(port, name)).toEqual([]);
	expect(await port.recordGet(metaCollection(accountId), "meta")).toBe(
		initialStateRaw,
	);
	if (activeItemsAtCapture)
		expect(await records(port, activeItemsCollection)).toEqual(
			activeItemsAtCapture,
		);
	if (activeVaultsAtCapture)
		expect(await records(port, activeVaultsCollection)).toEqual(
			activeVaultsAtCapture,
		);
}, 15_000);
