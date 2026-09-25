import { resolve } from "node:path";
import type { JSHandle, Page } from "@playwright/test";
import type { TestUser } from "./auth";

export interface NativeCreateSourceSnapshot {
	accountId: string;
	userId: string;
	storeJson: number[];
	syncStoreJson: number[];
	protectedEntry: number[];
}

interface BrowserCreateSource {
	capture(): Promise<NativeCreateSourceSnapshot>;
	start(): void;
}

/**
 * A short-lived legacy Desktop owner backed by the real writers and a memory Tauri seam.
 * The caller closes the owning Page while its exact Create reply is held by the proxy.
 */
export async function nativeCreateLossSource(
	page: Page,
	input: {
		user: TestUser;
		serverUrl: string;
		vaultId: string;
		itemId: string;
		operationId: string;
		sourceCommandId: string;
		attemptId: string;
		itemTitle: string;
	},
) {
	const repository = resolve(import.meta.dirname, "../../../..");
	const handle = (await page.evaluateHandle(
		async ({ input, repository }) => {
			const cryptoPath = "/src/lib/crypto.ts";
			const storagePath = `/@fs${repository}/packages/storage/src/index.ts`;
			const tauriPath = `/@fs${repository}/packages/storage/src/adapters/tauri.ts`;
			const doublesPath = `/@fs${repository}/packages/storage/src/adapters/tauri-test-doubles.ts`;
			const authPath = `/@fs${repository}/packages/core/src/services/auth-service.ts`;
			const apiPath = `/@fs${repository}/packages/shared/src/api-client-factory.ts`;
			const vaultPath = `/@fs${repository}/packages/core/src/services/vault-crypto.ts`;
			const syncPath = `/@fs${repository}/packages/sync/src/index.ts`;
			const { crypto } = (await import(
				cryptoPath
			)) as typeof import("../../src/lib/crypto");
			const { createAccountStore, createItemCache } = (await import(
				storagePath
			)) as typeof import("@bittery/storage");
			const { createTauriPlatformPort, createTauriRecordPort } = (await import(
				tauriPath
			)) as typeof import("@bittery/storage/adapters/tauri");
			const { createTauriDoubles } = (await import(
				doublesPath
			)) as typeof import("../../../../packages/storage/src/adapters/tauri-test-doubles");
			const { performSRPLogin, storeLoginSessionOwned } = (await import(
				authPath
			)) as typeof import("@bittery/core/services/auth-service");
			const { createApiClientForServer, createAccountApiClient } =
				(await import(
					apiPath
				)) as typeof import("@bittery/shared/api-client-factory");
			const { createVaultCrypto } = (await import(
				vaultPath
			)) as typeof import("@bittery/core/services/vault-crypto");
			const { buildDefaultSyncSourceId, NamespacedSyncStorage, OutboundQueue } =
				(await import(syncPath)) as typeof import("@bittery/sync");

			const primitives = createTauriDoubles();
			const storage = createAccountStore({
				port: createTauriPlatformPort(primitives.deps),
				crypto,
			});
			const itemCache = createItemCache({
				port: createTauriRecordPort(primitives.deps),
			});
			await crypto.initialize();
			await storage.initialize();
			await itemCache.initialize();
			const clientId = globalThis.crypto.randomUUID();
			const metadata = {
				clientPlatform: "desktop" as const,
				clientVersion: "ticket91-create-loss-fixture",
				insecureTransportConfirmed: true,
			};
			const login = await performSRPLogin(
				{
					email: input.user.email,
					password: input.user.password,
					secretKey: input.user.secretKey,
					serverUrl: input.serverUrl,
					insecureTransportConfirmed: true,
				},
				{
					crypto,
					storage,
					apiClient: createApiClientForServer(
						input.serverUrl,
						clientId,
						metadata,
					),
				},
			);
			const userId = login.user.id;
			const selectedKey = login.vaultKeys.find(
				(key) => key.vaultId === input.vaultId,
			);
			if (!selectedKey || selectedKey.role === "read-only") {
				await crypto.destroyKey(login.masterUnlockKey);
				throw new Error(
					"Create-loss fixture did not receive a writable Vault key",
				);
			}
			const api = createAccountApiClient(
				login.token,
				input.serverUrl,
				clientId,
				undefined,
				metadata,
			);
			const accountId = await storeLoginSessionOwned(
				login,
				input.user.secretKey,
				storage,
				itemCache,
				crypto,
				input.user.email,
				{
					serverUrl: input.serverUrl,
					insecureTransportConfirmed: true,
				},
			);
			const account = (await storage.getAccountsList()).find(
				(value) => value.accountId === accountId,
			);
			if (!account)
				throw new Error("Create-loss fixture Account was not stored");
			const vaultCrypto = createVaultCrypto({ crypto, storage });
			const vaultKey = await vaultCrypto.getVaultKey({
				accountId,
				vaultId: input.vaultId,
				userId,
			});
			if (!vaultKey)
				throw new Error("Create-loss fixture Vault key cannot be opened");
			const plaintext = JSON.stringify({
				title: input.itemTitle,
				username: "legacy-create-loss@example.test",
				password: "retained-create-loss-secret",
			});
			let encrypted: Awaited<ReturnType<typeof vaultCrypto.encryptItem>>;
			try {
				encrypted = await vaultCrypto.encryptItem(plaintext, vaultKey, {
					vaultId: input.vaultId,
					itemId: input.itemId,
					version: 1,
					userId,
				});
			} finally {
				await crypto.destroyKey(vaultKey);
			}
			await itemCache.setCachedItems([], accountId);
			await itemCache.setCachedVaults(
				[
					{
						id: input.vaultId,
						name: selectedKey.vaultName,
						type: selectedKey.vaultType,
						icon: selectedKey.vaultIcon ?? null,
						imageUrl: selectedKey.vaultImageUrl ?? null,
						accountId,
						accountEmail: account.email,
						serverUrl: account.serverUrl,
					},
				],
				accountId,
			);
			const capturedAt = Date.now();
			await itemCache.setItemCacheMetadata(
				{
					lastFullSyncAt: capturedAt,
					itemCount: 0,
					cacheVersion: 1,
					syncBaseline: {
						serverUrl: account.serverUrl,
						cursorId: null,
					},
				},
				accountId,
			);

			const syncStore = await primitives.deps.loadStore("sync-store.json");
			let updateTail: Promise<void> = Promise.resolve();
			const syncStorage: import("@bittery/sync").SyncStorage = {
				async get<T>(key: string) {
					const value = await syncStore.get<string>(key);
					return value === undefined ? null : (JSON.parse(value) as T);
				},
				async set<T>(key: string, value: T) {
					await syncStore.set(key, JSON.stringify(value));
					await syncStore.save();
				},
				async remove(key: string) {
					await syncStore.delete(key);
					await syncStore.save();
				},
				async update<T>(key: string, updater: (current: T | null) => T | null) {
					let result: T | null = null;
					const update = updateTail.then(async () => {
						const stored = await syncStore.get<string>(key);
						const current =
							stored === undefined ? null : (JSON.parse(stored) as T);
						result = updater(current);
						if (result === null) await syncStore.delete(key);
						else await syncStore.set(key, JSON.stringify(result));
						await syncStore.save();
					});
					updateTail = update.catch(() => undefined);
					await update;
					return result;
				},
			};
			await syncStorage.set("bittery_sync_client_id", clientId);
			const sourceId = buildDefaultSyncSourceId(account.serverUrl, accountId);
			const sourceStorage = new NamespacedSyncStorage(
				syncStorage,
				`sync_source_${encodeURIComponent(sourceId)}`,
			);
			await sourceStorage.set("syncBaselineV1", {
				initialized: true,
				cursor: null,
			});
			const queue = new OutboundQueue(syncStorage, clientId);
			await queue.enqueue({
				accountId,
				accountEmail: account.email,
				id: input.sourceCommandId,
				operationId: input.operationId,
				attemptId: input.attemptId,
				type: "create",
				entityId: input.itemId,
				vaultId: input.vaultId,
				category: "login",
				encryptedPayload: {
					encryptedData: encrypted.ciphertext,
					encryptionIv: encrypted.iv,
					encryptionAlgorithm: encrypted.algorithm,
					encryptionVersion: 1,
					encryptedByUserId: userId,
				},
				baseVersion: 0,
				timestamp: capturedAt,
				retryCount: 0,
				status: "pending",
			});
			await queue.whenPersisted();
			primitives.keychain.entries.set(
				"unrelated_create_loss_entry",
				"preserved",
			);
			const encode = (entries: Iterable<[string, unknown]>, pretty: boolean) =>
				Array.from(
					new TextEncoder().encode(
						JSON.stringify(
							Object.fromEntries(entries),
							null,
							pretty ? 2 : undefined,
						),
					),
				);
			let started = false;
			return {
				async capture() {
					return {
						accountId,
						userId,
						storeJson: encode(await primitives.store.entries(), true),
						syncStoreJson: encode(await syncStore.entries(), false),
						protectedEntry: encode(primitives.keychain.entries, false),
					};
				},
				start() {
					if (started) throw new Error("Create-loss dispatch already started");
					started = true;
					void queue.drain(() => api).catch(() => undefined);
				},
			};
		},
		{ input, repository },
	)) as JSHandle<BrowserCreateSource>;
	return {
		capture: () => handle.evaluate((source) => source.capture()),
		start: () => handle.evaluate((source) => source.start()),
		dispose: () => handle.dispose(),
	};
}
