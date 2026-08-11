import type { CryptoPort, KeyRef } from "@bittery/crypto-port";
import { getDefaultServerUrl } from "@bittery/shared/api-client-factory";
import type { DecryptedItem, DecryptedItemData } from "@bittery/shared/types";
import {
	decodeVaultType,
	type ServerVaultListEntry,
	type ServerVaultSummary,
	toCachedVaultFields,
	toVaultKeyEntry,
} from "@bittery/shared/vault-mapping";
import type { AccountStore, ItemCache } from "@bittery/storage";
import { resolveUserIdForAccount } from "@bittery/storage/account-id";
import type { VaultKeyData } from "@bittery/storage/types";
import type {
	CachedAttachment,
	CachedEncryptedItem,
	CachedVaultMetadata,
	ItemEncryptionContextMigrationPort,
	ItemSyncAcknowledgement,
	ItemSyncCommand,
} from "@bittery/types";
import { getTravelModeEnforcer } from "./travel-mode-enforcer";
import { isVaultHidden } from "./travel-mode-service";
import type { VaultCrypto } from "./vault-crypto";

export interface VaultView {
	id: string;
	name: string;
	type: string;
	icon: string | null;
	imageUrl: string | null;
}

export interface VaultRepositoryItem extends DecryptedItem {
	accountId?: string;
	accountEmail?: string;
	serverUrl?: string;
	deletedAt: string | null;
	version: number;
	lastModifiedBy: string | null;
	encryptionVersion?: number | null;
	encryptedByUserId?: string | null;
	encryptionContextPendingMigration?: boolean;
	attachments?: CachedAttachment[];
	_encrypted: {
		data: string;
		iv: string;
		algorithm: string;
	};
	vault: VaultView;
}

export interface EncryptedPayload {
	ciphertext: string;
	iv: string;
	algorithm: string;
	encryptionVersion?: number;
	encryptedByUserId?: string;
}

export type {
	DiscoveredItemEncryptionContext,
	ItemEncryptionContextMigrationPort,
} from "@bittery/types";

const LEGACY_ENCRYPTION_VERSION_WINDOW = 8;
const LEGACY_ENCRYPTION_AUTHOR_LIMIT = 32;

export type LegacyEncryptionAuthorProvider = (
	vaultId: string,
) => Promise<string[]>;

interface BootstrapItemPage {
	items: Array<{
		id: string;
		vaultId: string;
		category: string;
		favorite: boolean;
		encryptedData: string;
		encryptionIv: string;
		encryptionAlgorithm: string;
		version?: number;
		lastModifiedBy?: string | null;
		encryptionVersion?: number | null;
		encryptedByUserId?: string | null;
		createdAt: string | Date;
		updatedAt: string | Date;
		deletedAt?: string | Date | null;
		attachments?: CachedAttachment[];
		vault: ServerVaultSummary;
	}>;
	hasMore: boolean;
	nextCursor?: string;
}

export interface BootstrapItemsClient {
	sync: {
		bootstrap: (input: {
			cursor?: string;
			limit?: number;
		}) => Promise<{ data: BootstrapItemPage }>;
	};
	vaults?: {
		list?: () => Promise<{ data: Array<ServerVaultListEntry> }>;
	};
}

export class VaultRepository {
	private readonly fallbackServerUrl = getDefaultServerUrl();

	private readonly items = new Map<string, VaultRepositoryItem>();
	private readonly authoritativeItems = new Map<string, CachedEncryptedItem>();
	private readonly pendingCommands = new Map<string, ItemSyncCommand>();
	private readonly vaults = new Map<string, CachedVaultMetadata>();
	private readonly vaultKeyEntries = new Map<string, VaultKeyData>();
	private readonly legacyEncryptionAuthorsByVaultId = new Map<
		string,
		Promise<string[]>
	>();
	private readonly listeners = new Set<() => void>();
	private snapshot = 0;
	private hydrated = false;
	private hydrating = false;
	private hasCacheSnapshotFlag = false;
	private serverUrl?: string;

	/**
	 * One repo is bound to one account for its whole life: every cache read, write,
	 * API and crypto call below keys off this `accountId` rather than re-resolving.
	 */
	constructor(
		private readonly crypto: CryptoPort,
		private readonly vaultCrypto: VaultCrypto,
		private readonly storage: AccountStore,
		private readonly itemCache: ItemCache,
		private readonly accountId: string,
		serverUrl?: string,
		private readonly accountEmail?: string,
		private readonly onEncryptionContextDiscovered?: ItemEncryptionContextMigrationPort,
		private readonly getLegacyEncryptionAuthors?: LegacyEncryptionAuthorProvider,
	) {
		this.serverUrl = serverUrl;
	}

	getAccountId(): string {
		return this.accountId;
	}

	getAccountEmail(): string | undefined {
		return this.accountEmail;
	}

	getServerUrl(): string | undefined {
		return this.serverUrl;
	}

	setServerUrl(serverUrl?: string): void {
		this.serverUrl = serverUrl ?? undefined;
	}

	isHydrated(): boolean {
		return this.hydrated;
	}

	/**
	 * Every item and vault key in here is decrypted under the account's master unlock key,
	 * so a locked account has nothing this repository can build. Callers hydrate on mount
	 * and on every account change, which is well before the user has unlocked.
	 */
	private async isLocked(): Promise<boolean> {
		return (await this.storage.getMasterUnlockKey(this.accountId)) === null;
	}

	isHydrating(): boolean {
		return this.hydrating;
	}

	hasCacheSnapshot(): boolean {
		return this.hasCacheSnapshotFlag;
	}

	getAll(): VaultRepositoryItem[] {
		const items = Array.from(this.items.values()).filter(
			(item) => !item.deletedAt,
		);
		return this.applyTravelModeItemFilter(items);
	}

	getByVault(vaultId: string): VaultRepositoryItem[] {
		if (this.isTravelModeVaultHidden(vaultId)) {
			return [];
		}
		return Array.from(this.items.values()).filter(
			(item) => item.vaultId === vaultId && !item.deletedAt,
		);
	}

	getById(id: string): VaultRepositoryItem | undefined {
		const item = this.items.get(id);
		if (!item || item.deletedAt) {
			return undefined;
		}
		if (this.isTravelModeVaultHidden(item.vaultId)) {
			return undefined;
		}
		return item;
	}

	getDeleted(): VaultRepositoryItem[] {
		const items = Array.from(this.items.values()).filter(
			(item) => !!item.deletedAt,
		);
		return this.applyTravelModeItemFilter(items);
	}

	getVaults(): CachedVaultMetadata[] {
		const vaults = Array.from(this.vaults.values());
		const enforcer = getTravelModeEnforcer(this.storage, this.itemCache);
		if (!enforcer.isVerified(this.accountId)) return [];
		const config = enforcer.getConfig(this.accountId);
		if (!config.enabled) {
			return vaults;
		}
		return vaults.filter((vault) => !isVaultHidden(config, vault.id));
	}

	getVaultById(vaultId: string): CachedVaultMetadata | undefined {
		if (this.isTravelModeVaultHidden(vaultId)) {
			return undefined;
		}
		return this.vaults.get(vaultId);
	}

	getVaultKeys(): VaultKeyData[] {
		const vaultKeys = Array.from(this.vaultKeyEntries.values());
		const enforcer = getTravelModeEnforcer(this.storage, this.itemCache);
		if (!enforcer.isVerified(this.accountId)) return [];
		return enforcer.filterVaultKeys(this.accountId, vaultKeys);
	}

	hasVault(vaultId: string): boolean {
		return this.vaults.has(vaultId);
	}

	getSnapshot = (): number => this.snapshot;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	private emit(): void {
		this.snapshot++;
		for (const listener of this.listeners) {
			listener();
		}
	}

	/**
	 * A repo only ever handles its own account. The former "no accountId means
	 * everyone" branch applied scopeless sync events to every open repo.
	 */
	private isForThisAccount(accountId: string): boolean {
		return this.accountId === accountId;
	}

	private isTravelModeVaultHidden(vaultId: string): boolean {
		const enforcer = getTravelModeEnforcer(this.storage, this.itemCache);
		if (!enforcer.isVerified(this.accountId)) return true;
		return isVaultHidden(enforcer.getConfig(this.accountId), vaultId);
	}

	private applyTravelModeItemFilter(
		items: VaultRepositoryItem[],
	): VaultRepositoryItem[] {
		const enforcer = getTravelModeEnforcer(this.storage, this.itemCache);
		if (!enforcer.isVerified(this.accountId)) return [];
		return enforcer.filterItems(this.accountId, items);
	}

	purgeHiddenVaults(hiddenVaultIds: string[]): void {
		if (hiddenVaultIds.length === 0) {
			return;
		}
		const hidden = new Set(hiddenVaultIds);
		for (const vaultId of hidden) {
			this.vaults.delete(vaultId);
			this.vaultKeyEntries.delete(vaultId);
		}
		for (const [itemId, item] of this.items) {
			if (hidden.has(item.vaultId)) {
				this.items.delete(itemId);
				this.authoritativeItems.delete(itemId);
			}
		}
		this.emit();
	}

	private getVaultView(vaultId: string): VaultView {
		const vault = this.vaults.get(vaultId);
		if (!vault) {
			return {
				id: vaultId,
				name: "Unknown",
				type: "personal",
				icon: null,
				imageUrl: null,
			};
		}
		return {
			id: vault.id,
			name: vault.name,
			type: vault.type,
			icon: vault.icon,
			imageUrl: vault.imageUrl,
		};
	}

	private async resolveUserId(): Promise<string> {
		return resolveUserIdForAccount(this.storage, this.accountId);
	}

	private getLegacyVersionCandidates(version: number): number[] {
		const normalized =
			Number.isFinite(version) && version > 0 ? Math.floor(version) : 1;
		const candidates: number[] = [];
		const minimum = Math.max(
			1,
			normalized - LEGACY_ENCRYPTION_VERSION_WINDOW + 1,
		);
		for (let candidate = normalized; candidate >= minimum; candidate -= 1) {
			candidates.push(candidate);
		}
		return candidates;
	}

	private getLegacyAuthors(vaultId: string): Promise<string[]> {
		const existing = this.legacyEncryptionAuthorsByVaultId.get(vaultId);
		if (existing) return existing;
		const lookup = Promise.resolve(
			this.getLegacyEncryptionAuthors?.(vaultId) ?? [],
		)
			.then((authors) => authors.slice(0, LEGACY_ENCRYPTION_AUTHOR_LIMIT))
			.catch((error) => {
				this.legacyEncryptionAuthorsByVaultId.delete(vaultId);
				throw error;
			});
		this.legacyEncryptionAuthorsByVaultId.set(vaultId, lookup);
		return lookup;
	}

	private async getEncryptionContextCandidates(
		item: CachedEncryptedItem,
		defaultUserId: string,
	): Promise<Array<{ version: number; userId: string; legacy: boolean }>> {
		const hasVersion = item.encryptionVersion != null;
		const hasAuthor = item.encryptedByUserId != null;
		if (hasVersion || hasAuthor) {
			if (
				!hasVersion ||
				!hasAuthor ||
				!Number.isInteger(item.encryptionVersion) ||
				(item.encryptionVersion ?? 0) < 1 ||
				item.encryptedByUserId === ""
			) {
				return [];
			}
			return [
				{
					version: item.encryptionVersion as number,
					userId: item.encryptedByUserId as string,
					legacy: false,
				},
			];
		}

		let vaultAuthors: string[] = [];
		try {
			vaultAuthors = await this.getLegacyAuthors(item.vaultId);
		} catch {
			// The bounded local candidates still cover personal Vaults while offline.
		}
		const authors = Array.from(
			new Set(
				[item.lastModifiedBy, defaultUserId, ...vaultAuthors].filter(
					(author): author is string =>
						typeof author === "string" && author !== "",
				),
			),
		).slice(0, LEGACY_ENCRYPTION_AUTHOR_LIMIT);
		return this.getLegacyVersionCandidates(item.version).flatMap((version) =>
			authors.map((userId) => ({ version, userId, legacy: true })),
		);
	}

	private async persistDiscoveredEncryptionContext(
		item: CachedEncryptedItem,
		version: number,
		encryptedByUserId: string,
		publish = true,
	): Promise<CachedEncryptedItem> {
		const migrated = {
			...item,
			encryptionVersion: version,
			encryptedByUserId,
			encryptionContextPendingMigration: true,
		};
		await this.persistItem(migrated);
		try {
			if (publish)
				await this.onEncryptionContextDiscovered?.({
					accountId: this.accountId,
					itemId: item.id,
					vaultId: item.vaultId,
					baseVersion: item.version,
					encryptionVersion: version,
					encryptedByUserId,
				});
		} catch (error) {
			console.warn(
				`[VaultRepository] Failed to publish discovered encryption context for item ${item.id}:`,
				error,
			);
		}
		return migrated;
	}

	private async decryptItemPayload(
		item: CachedEncryptedItem,
		vaultKey: KeyRef,
		userId: string,
	): Promise<{ plaintext: string; item: CachedEncryptedItem }> {
		let lastError: unknown = null;

		for (const context of await this.getEncryptionContextCandidates(
			item,
			userId,
		)) {
			try {
				const decrypted = await this.vaultCrypto.decryptItem(
					{
						ciphertext: item.encryptedData,
						iv: item.encryptionIv,
						algorithm: item.encryptionAlgorithm,
					},
					vaultKey,
					{
						vaultId: item.vaultId,
						itemId: item.id,
						version: context.version,
						userId: context.userId,
					},
				);

				if (context.legacy) {
					console.debug(
						`[VaultRepository] Recovered item ${item.id} with legacy encryption context version ${context.version} (stored version ${item.version})`,
					);
					return {
						plaintext: decrypted,
						item: await this.persistDiscoveredEncryptionContext(
							item,
							context.version,
							context.userId,
							false,
						),
					};
				}

				return { plaintext: decrypted, item };
			} catch (error) {
				lastError = error;
			}
		}

		throw lastError ?? new Error(`Failed to decrypt item ${item.id}`);
	}

	/**
	 * Which of this account's vault keys, if any, opens a payload its own vault key
	 * could not. Decrypts without AAD on purpose: that isolates "wrong key" from
	 * "wrong encryption context", which is the only distinction worth making here.
	 */
	private async findVaultKeyThatOpens(
		item: CachedEncryptedItem,
	): Promise<string | null> {
		for (const vaultId of this.vaultKeyEntries.keys()) {
			let vaultKey: KeyRef;
			try {
				vaultKey = await this.decryptVaultKey(vaultId);
			} catch {
				continue;
			}
			try {
				await this.crypto.decrypt(
					{
						ciphertext: item.encryptedData,
						iv: item.encryptionIv,
						algorithm: item.encryptionAlgorithm,
					},
					vaultKey,
					null,
				);
				return vaultId;
			} catch {
				// Not this key.
			} finally {
				await this.crypto.destroyKey(vaultKey);
			}
		}
		return null;
	}

	/**
	 * Ids, a version and a length only. This is a password manager: no ciphertext,
	 * no plaintext, no key material may reach a log sink.
	 */
	private async describeUndecryptableItem(
		item: CachedEncryptedItem,
	): Promise<string> {
		const openedBy = await this.findVaultKeyThatOpens(item);
		return `item ${item.id} vault=${item.vaultId} version=${item.version} lastModifiedBy=${item.lastModifiedBy ?? "null"} encryptedDataLength=${item.encryptedData.length} openedByVaultKey=${openedBy ?? "none"}`;
	}

	private async decryptItemBatch(
		items: readonly CachedEncryptedItem[],
	): Promise<
		Array<
			| { item: CachedEncryptedItem; decrypted: VaultRepositoryItem }
			| { item: CachedEncryptedItem; error: unknown }
		>
	> {
		if (items.length === 0) return [];
		const defaultUserId = await this.resolveUserId();
		const vaultKeys = new Map<string, KeyRef>();
		const keyErrors = new Map<string, unknown>();

		try {
			for (const vaultId of new Set(items.map((item) => item.vaultId))) {
				try {
					vaultKeys.set(vaultId, await this.decryptVaultKey(vaultId));
				} catch (error) {
					keyErrors.set(vaultId, error);
				}
			}

			const candidates = await Promise.all(
				items.map(async (item) => {
					const vaultKey = vaultKeys.get(item.vaultId);
					const contexts = await this.getEncryptionContextCandidates(
						item,
						defaultUserId,
					);
					return vaultKey && contexts[0] ? { item, vaultKey, contexts } : null;
				}),
			);
			const decryptable = candidates.filter((entry) => entry !== null);
			const primary = await this.vaultCrypto.decryptItems(
				decryptable.map(({ item, vaultKey, contexts }) => ({
					id: item.id,
					data: {
						ciphertext: item.encryptedData,
						iv: item.encryptionIv,
						algorithm: item.encryptionAlgorithm,
					},
					vaultKey,
					scope: {
						vaultId: item.vaultId,
						itemId: item.id,
						version: contexts[0]?.version ?? item.version,
						userId: contexts[0]?.userId ?? defaultUserId,
					},
				})),
			);

			const outcomeByItem = new Map<
				CachedEncryptedItem,
				| { ok: true; decrypted: VaultRepositoryItem }
				| { ok: false; error: unknown }
			>();
			for (const [index, result] of primary.entries()) {
				const entry = decryptable[index];
				if (!entry) continue;
				if (result.ok) {
					const primaryContext = entry.contexts[0];
					const migratedItem = primaryContext?.legacy
						? await this.persistDiscoveredEncryptionContext(
								entry.item,
								primaryContext.version,
								primaryContext.userId,
								false,
							)
						: entry.item;
					outcomeByItem.set(entry.item, {
						ok: true,
						decrypted: this.buildItem(
							migratedItem,
							JSON.parse(result.plaintext) as DecryptedItemData,
						),
					});
					continue;
				}

				let fallbackError: unknown = new Error(result.error);
				for (const context of entry.contexts.slice(1)) {
					try {
						const plaintext = await this.vaultCrypto.decryptItem(
							{
								ciphertext: entry.item.encryptedData,
								iv: entry.item.encryptionIv,
								algorithm: entry.item.encryptionAlgorithm,
							},
							entry.vaultKey,
							{
								vaultId: entry.item.vaultId,
								itemId: entry.item.id,
								version: context.version,
								userId: context.userId,
							},
						);
						console.debug(
							`[VaultRepository] Recovered item ${entry.item.id} with legacy encryption context version ${context.version} (stored version ${entry.item.version})`,
						);
						const migratedItem = await this.persistDiscoveredEncryptionContext(
							entry.item,
							context.version,
							context.userId,
							false,
						);
						outcomeByItem.set(entry.item, {
							ok: true,
							decrypted: this.buildItem(
								migratedItem,
								JSON.parse(plaintext) as DecryptedItemData,
							),
						});
						fallbackError = null;
						break;
					} catch (error) {
						fallbackError = error;
					}
				}
				if (fallbackError) {
					outcomeByItem.set(entry.item, {
						ok: false,
						error: fallbackError,
					});
				}
			}

			return items.map((item) => {
				const outcome = outcomeByItem.get(item);
				if (outcome?.ok) {
					return { item, decrypted: outcome.decrypted };
				}
				return {
					item,
					error:
						(outcome?.ok === false ? outcome.error : undefined) ??
						keyErrors.get(item.vaultId) ??
						new Error(`Failed to decrypt item ${item.id}`),
				};
			});
		} finally {
			await Promise.all(
				Array.from(vaultKeys.values(), (key) => this.crypto.destroyKey(key)),
			);
		}
	}

	private toCachedItem(item: VaultRepositoryItem): CachedEncryptedItem {
		return {
			id: item.id,
			vaultId: item.vaultId,
			accountId: item.accountId ?? this.accountId,
			accountEmail: item.accountEmail ?? this.accountEmail,
			serverUrl: item.serverUrl ?? this.serverUrl ?? this.fallbackServerUrl,
			category: item.category,
			favorite: item.favorite,
			encryptedData: item._encrypted.data,
			encryptionIv: item._encrypted.iv,
			encryptionAlgorithm: item._encrypted.algorithm,
			version: item.version,
			lastModifiedBy: item.lastModifiedBy,
			encryptionVersion: item.encryptionVersion,
			encryptedByUserId: item.encryptedByUserId,
			encryptionContextPendingMigration: item.encryptionContextPendingMigration,
			createdAt: item.createdAt,
			updatedAt: item.updatedAt,
			deletedAt: item.deletedAt,
			attachments: item.attachments,
		};
	}

	private commandOperationId(command: ItemSyncCommand): string {
		return command.operationId ?? command.id;
	}

	private commandsForItem(itemId: string): ItemSyncCommand[] {
		return Array.from(this.pendingCommands.values())
			.filter((command) => command.entityId === itemId)
			.sort((left, right) => left.timestamp - right.timestamp);
	}

	private hasPendingEncryptedCommand(itemId: string): boolean {
		return this.commandsForItem(itemId).some(
			(command) =>
				command.type === "create" ||
				command.type === "update" ||
				command.type === "move" ||
				command.type === "cross_account_move",
		);
	}

	private applyCommandToCachedItem(
		base: CachedEncryptedItem | undefined,
		command: ItemSyncCommand,
	): CachedEncryptedItem | undefined {
		const timestamp = new Date(command.timestamp).toISOString();
		if (command.type === "permanent_delete") {
			return base;
		}
		if (command.type === "create") {
			const payload = command.encryptedPayload;
			if (!payload || !command.category) {
				throw new Error(
					`Missing create projection data for ${command.entityId}`,
				);
			}
			return {
				id: command.entityId,
				vaultId: command.vaultId,
				accountId: this.accountId,
				accountEmail: command.accountEmail ?? this.accountEmail,
				serverUrl: this.serverUrl ?? this.fallbackServerUrl,
				category: command.category,
				favorite: false,
				encryptedData: payload.encryptedData,
				encryptionIv: payload.encryptionIv,
				encryptionAlgorithm: payload.encryptionAlgorithm,
				version: payload.encryptionVersion ?? 1,
				lastModifiedBy: payload.encryptedByUserId ?? null,
				encryptionVersion: payload.encryptionVersion ?? 1,
				encryptedByUserId: payload.encryptedByUserId,
				createdAt: timestamp,
				updatedAt: timestamp,
				deletedAt: null,
			};
		}
		if (!base) {
			return undefined;
		}

		switch (command.type) {
			case "cross_account_move":
				return base;
			case "update":
			case "move": {
				const payload = command.encryptedPayload;
				if (!payload) {
					throw new Error(`Missing ${command.type} projection data`);
				}
				return {
					...base,
					vaultId:
						command.type === "move"
							? (command.targetVaultId ?? base.vaultId)
							: base.vaultId,
					encryptedData: payload.encryptedData,
					encryptionIv: payload.encryptionIv,
					encryptionAlgorithm: payload.encryptionAlgorithm,
					version: payload.encryptionVersion ?? base.version + 1,
					lastModifiedBy: payload.encryptedByUserId ?? base.lastModifiedBy,
					encryptionVersion: payload.encryptionVersion ?? base.version + 1,
					encryptedByUserId:
						payload.encryptedByUserId ?? base.encryptedByUserId,
					updatedAt: timestamp,
				};
			}
			case "delete":
				return { ...base, deletedAt: timestamp, updatedAt: timestamp };
			case "restore":
				return { ...base, deletedAt: null, updatedAt: timestamp };
			case "toggle_favorite":
				return {
					...base,
					favorite: command.favorite ?? false,
					updatedAt: timestamp,
				};
			case "adopt_encryption_context":
				return {
					...base,
					encryptionVersion:
						command.encryptedPayload?.encryptionVersion ??
						base.encryptionVersion,
					encryptedByUserId:
						command.encryptedPayload?.encryptedByUserId ??
						base.encryptedByUserId,
					encryptionContextPendingMigration: true,
				};
		}
	}

	private async rebuildItemProjection(itemId: string): Promise<void> {
		let projected = this.authoritativeItems.get(itemId);
		for (const command of this.commandsForItem(itemId)) {
			projected = this.applyCommandToCachedItem(projected, command);
		}
		if (!projected || (await this.isLocked())) {
			this.items.delete(itemId);
			this.emit();
			return;
		}
		try {
			this.items.set(itemId, await this.decryptItem(projected));
		} catch (error) {
			this.items.delete(itemId);
			console.error(
				`[VaultRepository] Failed to project ${await this.describeUndecryptableItem(projected)}:`,
				error,
			);
		}
		this.emit();
	}

	private mergeVaultKeyEntries(
		vaultKeys: VaultKeyData[] | null | undefined,
	): void {
		if (!vaultKeys) {
			return;
		}

		this.vaultKeyEntries.clear();
		for (const vaultKey of vaultKeys) {
			this.vaultKeyEntries.set(vaultKey.vaultId, vaultKey);

			if (this.vaults.has(vaultKey.vaultId)) {
				continue;
			}

			this.vaults.set(vaultKey.vaultId, {
				id: vaultKey.vaultId,
				accountId: this.accountId,
				accountEmail: this.accountEmail,
				serverUrl: this.serverUrl ?? this.fallbackServerUrl,
				name: vaultKey.vaultName,
				type: vaultKey.vaultType,
				icon: vaultKey.vaultIcon ?? null,
				imageUrl: vaultKey.vaultImageUrl ?? null,
			});
		}
	}

	private async fetchVaultKeysFromServer(
		client: BootstrapItemsClient,
	): Promise<VaultKeyData[] | null> {
		if (!client.vaults?.list) {
			return null;
		}

		try {
			const { data: vaults } = await client.vaults.list();
			return vaults.map(toVaultKeyEntry);
		} catch (error) {
			console.error("[VaultRepository] Failed to refresh vault keys:", error);
			return null;
		}
	}

	private async ensureServerUrl(): Promise<void> {
		if (this.serverUrl) {
			return;
		}
		this.serverUrl =
			(await this.storage.getServerUrl(this.accountId)) ??
			this.fallbackServerUrl;
	}

	/**
	 * One `recordPut`, no read-modify-write. Delta sync calls this once per changed
	 * item, which is exactly why `RecordPort` has per-record primitives.
	 */
	private async persistItem(item: CachedEncryptedItem): Promise<boolean> {
		return this.itemCache.upsertCachedItem(item, this.accountId);
	}

	private buildItem(
		cached: CachedEncryptedItem,
		decryptedData: DecryptedItemData,
	): VaultRepositoryItem {
		return {
			id: cached.id,
			vaultId: cached.vaultId,
			accountId: cached.accountId ?? this.accountId,
			accountEmail: cached.accountEmail ?? this.accountEmail,
			serverUrl: cached.serverUrl ?? this.serverUrl ?? this.fallbackServerUrl,
			category: cached.category as DecryptedItem["category"],
			favorite: cached.favorite,
			createdAt: cached.createdAt,
			updatedAt: cached.updatedAt,
			deletedAt: cached.deletedAt ?? null,
			version: cached.version,
			lastModifiedBy: cached.lastModifiedBy,
			encryptionVersion: cached.encryptionVersion,
			encryptedByUserId: cached.encryptedByUserId,
			encryptionContextPendingMigration:
				cached.encryptionContextPendingMigration,
			attachments: cached.attachments,
			...decryptedData,
			_encrypted: {
				data: cached.encryptedData,
				iv: cached.encryptionIv,
				algorithm: cached.encryptionAlgorithm,
			},
			vault: this.getVaultView(cached.vaultId),
		};
	}

	private async decryptVaultKey(vaultId: string): Promise<KeyRef> {
		const vaultKeys = await this.storage.getVaultKeys(this.accountId);
		if (!vaultKeys) {
			throw new Error(`No vault key found for vault ${vaultId}.`);
		}

		const vaultKeyData = vaultKeys?.find(
			(vaultKey) => vaultKey.vaultId === vaultId,
		);
		if (!vaultKeyData) {
			throw new Error(`No vault key found for vault ${vaultId}.`);
		}

		const userId = await this.resolveUserId();
		try {
			return await this.vaultCrypto.unwrapStoredVaultKey({
				encryptedVaultKey: vaultKeyData.encryptedVaultKey,
				vaultId,
				userId,
				accountId: this.accountId,
			});
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error ?? "");
			if (
				message !== "Vault key wrap vault mismatch" &&
				message !== "Vault key wrap user mismatch"
			) {
				throw error;
			}

			return this.vaultCrypto.unwrapStoredVaultKey({
				encryptedVaultKey: vaultKeyData.encryptedVaultKey,
				accountId: this.accountId,
			});
		}
	}

	async decryptItem(item: CachedEncryptedItem): Promise<VaultRepositoryItem> {
		const vaultKey = await this.decryptVaultKey(item.vaultId);
		try {
			const decrypted = await this.decryptItemPayload(
				item,
				vaultKey,
				await this.resolveUserId(),
			);
			return this.buildItem(
				decrypted.item,
				JSON.parse(decrypted.plaintext) as DecryptedItemData,
			);
		} finally {
			await this.crypto.destroyKey(vaultKey);
		}
	}

	/**
	 * Never throws on a bad payload: sync catch-up applies events one at a time and a
	 * throw here would stop the cursor advancing, wedging sync on the same event forever.
	 */
	async upsertEncrypted(
		item: CachedEncryptedItem,
		accountId: string,
	): Promise<void> {
		if (!this.isForThisAccount(accountId)) {
			return;
		}
		if (!(await this.persistItem(item))) {
			return;
		}
		const currentBase = this.authoritativeItems.get(item.id);
		if (currentBase && currentBase.version > item.version) {
			return;
		}
		this.authoritativeItems.set(item.id, item);

		// Sync keeps running on a locked account, and the ciphertext is all the cache
		// wants from it. Decryption waits for the hydrate that follows the unlock, rather
		// than failing once per delta.
		await this.rebuildItemProjection(item.id);
	}

	async upsertLocal(
		item: DecryptedItem,
		encryptedPayload: EncryptedPayload,
	): Promise<void> {
		const existing = this.items.get(item.id);
		const now = new Date().toISOString();
		const version = (existing?.version ?? 0) + 1;
		const encryptedByUserId =
			encryptedPayload.encryptedByUserId ?? (await this.resolveUserId());
		const next: VaultRepositoryItem = {
			...existing,
			...item,
			accountId: existing?.accountId ?? this.accountId,
			accountEmail: existing?.accountEmail ?? this.accountEmail,
			serverUrl:
				existing?.serverUrl ?? this.serverUrl ?? this.fallbackServerUrl,
			updatedAt: existing ? now : item.updatedAt,
			createdAt: existing ? existing.createdAt : item.createdAt,
			deletedAt: existing?.deletedAt ?? null,
			version,
			lastModifiedBy: existing?.lastModifiedBy ?? null,
			encryptionVersion: encryptedPayload.encryptionVersion ?? version,
			encryptedByUserId,
			attachments: existing?.attachments,
			_encrypted: {
				data: encryptedPayload.ciphertext,
				iv: encryptedPayload.iv,
				algorithm: encryptedPayload.algorithm,
			},
			vault: existing?.vault ?? this.getVaultView(item.vaultId),
		};

		this.items.set(item.id, next);
		this.authoritativeItems.set(item.id, this.toCachedItem(next));
		await this.persistItem(this.toCachedItem(next));
		this.emit();
	}

	async softDelete(itemId: string): Promise<void> {
		const existing = this.items.get(itemId);
		if (!existing) {
			return;
		}
		const now = new Date().toISOString();
		const next: VaultRepositoryItem = {
			...existing,
			deletedAt: now,
			updatedAt: now,
			// Do not increment version — the encrypted payload is unchanged.
			// Version is part of the AEAD context; bumping it without re-encrypting
			// causes a stored-version/ciphertext mismatch during decryption.
		};
		this.items.set(itemId, next);
		this.authoritativeItems.set(itemId, this.toCachedItem(next));
		await this.persistItem(this.toCachedItem(next));
		this.emit();
	}

	async restore(itemId: string): Promise<void> {
		const existing = this.items.get(itemId);
		if (!existing) {
			return;
		}
		const now = new Date().toISOString();
		const next: VaultRepositoryItem = {
			...existing,
			deletedAt: null,
			updatedAt: now,
			// Do not increment version — the encrypted payload is unchanged.
			// Version is part of the AEAD context; bumping it without re-encrypting
			// causes a stored-version/ciphertext mismatch during decryption.
		};
		this.items.set(itemId, next);
		this.authoritativeItems.set(itemId, this.toCachedItem(next));
		await this.persistItem(this.toCachedItem(next));
		this.emit();
	}

	async removeItem(itemId: string): Promise<void> {
		this.items.delete(itemId);
		this.authoritativeItems.delete(itemId);
		for (const [operationId, command] of this.pendingCommands) {
			if (command.entityId === itemId) {
				this.pendingCommands.delete(operationId);
			}
		}
		await this.itemCache.removeCachedItem(itemId, this.accountId);
		this.emit();
	}

	replaceItemId(tempId: string, realId: string): void {
		const existing = this.items.get(tempId);
		this.items.delete(tempId);
		const authoritative = this.authoritativeItems.get(tempId);
		if (authoritative) {
			this.authoritativeItems.delete(tempId);
			const current = this.authoritativeItems.get(realId);
			if (!current || current.version < authoritative.version) {
				this.authoritativeItems.set(realId, { ...authoritative, id: realId });
			}
		}
		if (existing) {
			this.items.set(realId, { ...existing, id: realId });
		}
		for (const command of this.pendingCommands.values()) {
			if (command.entityId === tempId) {
				command.entityId = realId;
			}
		}
		const base = this.authoritativeItems.get(realId);
		void Promise.all([
			this.itemCache.removeCachedItem(tempId, this.accountId),
			base ? this.persistItem(base) : Promise.resolve(),
			this.rebuildItemProjection(realId),
		]);
		this.emit();
	}

	async updateFavorite(itemId: string, favorite: boolean): Promise<void> {
		const existing = this.items.get(itemId);
		if (!existing) {
			return;
		}
		const next: VaultRepositoryItem = {
			...existing,
			favorite,
			updatedAt: new Date().toISOString(),
		};
		this.items.set(itemId, next);
		this.authoritativeItems.set(itemId, this.toCachedItem(next));
		await this.persistItem(this.toCachedItem(next));
		this.emit();
	}

	async applyItemCommand(command: ItemSyncCommand): Promise<void> {
		if (!this.isForThisAccount(command.accountId)) {
			return;
		}
		this.pendingCommands.set(this.commandOperationId(command), command);
		await this.rebuildItemProjection(command.entityId);
	}

	async discardItemCommandAcknowledgedElsewhere(
		command: ItemSyncCommand,
	): Promise<void> {
		if (!this.isForThisAccount(command.accountId)) return;
		this.pendingCommands.delete(this.commandOperationId(command));
		const cached = (await this.itemCache.getCachedItems(this.accountId))?.find(
			(item) => item.id === command.entityId,
		);
		if (cached) {
			await this.upsertEncrypted(cached, this.accountId);
			return;
		}
		if (command.type === "permanent_delete") {
			this.authoritativeItems.delete(command.entityId);
			this.items.delete(command.entityId);
			this.emit();
			return;
		}
		await this.rebuildItemProjection(command.entityId);
	}

	async preserveItemConflict(
		command: ItemSyncCommand,
	): Promise<ItemSyncCommand | undefined> {
		if (
			!this.isForThisAccount(command.accountId) ||
			(command.type !== "update" &&
				command.type !== "move" &&
				command.type !== "cross_account_move") ||
			!command.conflictCopyId
		) {
			return undefined;
		}
		const local = this.items.get(command.entityId);
		if (!local) return undefined;

		const {
			id: _id,
			vaultId: _vaultId,
			category: _category,
			favorite: _favorite,
			createdAt: _createdAt,
			updatedAt: _updatedAt,
			accountId: _accountId,
			accountEmail: _accountEmail,
			serverUrl: _serverUrl,
			deletedAt: _deletedAt,
			version: _version,
			lastModifiedBy: _lastModifiedBy,
			encryptionVersion: _encryptionVersion,
			encryptedByUserId: _encryptedByUserId,
			encryptionContextPendingMigration: _pendingMigration,
			attachments: _attachments,
			_encrypted,
			vault: _vault,
			...data
		} = local;
		const payload = await this.encryptWithVaultKey(local.vaultId, data, {
			itemId: command.conflictCopyId,
			version: 1,
		});
		this.pendingCommands.delete(this.commandOperationId(command));
		await this.rebuildItemProjection(command.entityId);
		const operationId = `conflict-copy:${this.commandOperationId(command)}`;
		return {
			accountId: this.accountId,
			accountEmail: command.accountEmail ?? this.accountEmail,
			id: operationId,
			operationId,
			type: "create",
			entityId: command.conflictCopyId,
			vaultId: local.vaultId,
			category: local.category,
			encryptedPayload: {
				encryptedData: payload.ciphertext,
				encryptionIv: payload.iv,
				encryptionAlgorithm: payload.algorithm,
				encryptionVersion: payload.encryptionVersion,
				encryptedByUserId: payload.encryptedByUserId,
			},
			baseVersion: 0,
			timestamp: Date.now(),
			retryCount: 0,
			status: "pending",
		};
	}

	async acknowledgeItemCommand(
		command: ItemSyncCommand,
		acknowledgement: ItemSyncAcknowledgement,
	): Promise<void> {
		if (!this.isForThisAccount(command.accountId)) {
			return;
		}
		const version = acknowledgement.version;
		if (version === undefined) {
			throw new Error(
				`Item command ${command.operationId ?? command.id} returned no strong revision`,
			);
		}
		this.pendingCommands.delete(this.commandOperationId(command));
		if (command.type === "cross_account_move") {
			this.authoritativeItems.delete(command.entityId);
			await this.itemCache.removeCachedItem(command.entityId, this.accountId);
			await this.rebuildItemProjection(command.entityId);
			return;
		}
		if (command.type === "permanent_delete") {
			this.authoritativeItems.delete(acknowledgement.entityId);
			await this.itemCache.removeCachedItem(
				acknowledgement.entityId,
				this.accountId,
			);
			await this.rebuildItemProjection(acknowledgement.entityId);
			return;
		}

		const base = this.authoritativeItems.get(acknowledgement.entityId);
		if (base && base.version >= version) {
			await this.rebuildItemProjection(acknowledgement.entityId);
			return;
		}
		const projected = this.applyCommandToCachedItem(base, command);
		if (!projected) {
			await this.rebuildItemProjection(acknowledgement.entityId);
			return;
		}
		const acknowledged: CachedEncryptedItem = {
			...projected,
			id: acknowledgement.entityId,
			version,
		};
		if (command.type === "adopt_encryption_context") {
			acknowledged.encryptionVersion =
				command.encryptedPayload?.encryptionVersion ??
				acknowledged.encryptionVersion;
			acknowledged.encryptedByUserId =
				command.encryptedPayload?.encryptedByUserId ??
				acknowledged.encryptedByUserId;
			acknowledged.encryptionContextPendingMigration = false;
		}
		this.authoritativeItems.set(acknowledgement.entityId, acknowledged);
		await this.persistItem(acknowledged);
		await this.rebuildItemProjection(acknowledgement.entityId);
	}

	async publishPendingEncryptionContextMigration(
		itemId: string,
	): Promise<void> {
		if (!this.onEncryptionContextDiscovered) return;
		const item = (await this.itemCache.getCachedItems(this.accountId))?.find(
			(candidate) => candidate.id === itemId,
		);
		if (
			!item?.encryptionContextPendingMigration ||
			item.encryptionVersion == null ||
			!item.encryptedByUserId
		) {
			return;
		}
		await this.onEncryptionContextDiscovered({
			accountId: this.accountId,
			itemId: item.id,
			vaultId: item.vaultId,
			baseVersion: item.version,
			encryptionVersion: item.encryptionVersion,
			encryptedByUserId: item.encryptedByUserId,
		});
	}

	/**
	 * `decryptedData` is the plaintext the caller sealed into
	 * `newEncryptedPayload`. Re-deriving the encryption context here to decrypt
	 * it back would race the inbound sync stream: an item event landing between
	 * sealing and this write bumps `existing.version`, and the re-derived AAD no
	 * longer matches the sealed one.
	 */
	async moveItem(
		itemId: string,
		targetVaultId: string,
		newEncryptedPayload: EncryptedPayload,
		decryptedData: DecryptedItemData,
	): Promise<void> {
		const existing = this.items.get(itemId);
		if (!existing) {
			return;
		}

		const next: VaultRepositoryItem = {
			...existing,
			...decryptedData,
			vaultId: targetVaultId,
			updatedAt: new Date().toISOString(),
			version: existing.version + 1,
			encryptionVersion:
				newEncryptedPayload.encryptionVersion ?? existing.version + 1,
			encryptedByUserId:
				newEncryptedPayload.encryptedByUserId ?? (await this.resolveUserId()),
			_encrypted: {
				data: newEncryptedPayload.ciphertext,
				iv: newEncryptedPayload.iv,
				algorithm: newEncryptedPayload.algorithm,
			},
			vault: this.getVaultView(targetVaultId),
		};

		this.items.set(itemId, next);
		this.authoritativeItems.set(itemId, this.toCachedItem(next));
		await this.persistItem(this.toCachedItem(next));
		this.emit();
	}

	async hydrate(): Promise<void> {
		if (this.hydrating || (await this.isLocked())) {
			return;
		}

		this.hydrating = true;
		this.emit();

		try {
			getTravelModeEnforcer(this.storage, this.itemCache).assertVerified(
				this.accountId,
			);
			await this.ensureServerUrl();
			const [cachedItems, cachedVaults, cacheMeta, storedVaultKeys] =
				await Promise.all([
					this.itemCache.getCachedItems(this.accountId),
					this.itemCache.getCachedVaults(this.accountId),
					this.itemCache.getItemCacheMetadata(this.accountId),
					this.storage.getVaultKeys(this.accountId),
				]);

			this.items.clear();
			this.authoritativeItems.clear();
			this.vaults.clear();
			this.vaultKeyEntries.clear();
			this.legacyEncryptionAuthorsByVaultId.clear();

			for (const vault of cachedVaults ?? []) {
				if (!this.serverUrl && vault.serverUrl) {
					this.serverUrl = vault.serverUrl;
				}
				this.vaults.set(vault.id, vault);
			}
			this.mergeVaultKeyEntries(storedVaultKeys);

			for (const cachedItem of cachedItems ?? []) {
				if (!this.serverUrl && cachedItem.serverUrl) {
					this.serverUrl = cachedItem.serverUrl;
				}
			}
			for (const outcome of await this.decryptItemBatch(cachedItems ?? [])) {
				if ("decrypted" in outcome) {
					this.items.set(outcome.item.id, outcome.decrypted);
					this.authoritativeItems.set(
						outcome.item.id,
						this.toCachedItem(outcome.decrypted),
					);
				} else {
					this.authoritativeItems.set(outcome.item.id, outcome.item);
					console.error(
						`[VaultRepository] Failed to decrypt cached ${await this.describeUndecryptableItem(outcome.item)}:`,
						outcome.error,
					);
				}
			}
			for (const itemId of new Set(
				Array.from(
					this.pendingCommands.values(),
					(command) => command.entityId,
				),
			)) {
				await this.rebuildItemProjection(itemId);
			}

			this.hasCacheSnapshotFlag =
				!!cachedItems &&
				!!cachedVaults &&
				(cachedItems.length > 0 || cacheMeta !== null);
			this.hydrated = true;
		} finally {
			this.hydrating = false;
			this.emit();
		}
	}

	async hydrateFromServer(client: BootstrapItemsClient): Promise<void> {
		if (await this.isLocked()) {
			return;
		}

		const travelMode = getTravelModeEnforcer(this.storage, this.itemCache);
		travelMode.assertVerified(this.accountId);
		await this.ensureServerUrl();

		const conflictBases = new Map(
			Array.from(this.authoritativeItems).filter(([itemId]) =>
				this.hasPendingEncryptedCommand(itemId),
			),
		);
		let cursor: string | undefined;
		const staging = await this.itemCache.beginStagedGeneration(this.accountId);
		let refreshedVaultKeys: VaultKeyData[] | null = null;

		try {
			while (true) {
				const { data: page } = await client.sync.bootstrap({
					cursor,
					limit: 500,
				});

				for (const rawItem of travelMode.filterItems(
					this.accountId,
					page.items,
				)) {
					const cachedItem: CachedEncryptedItem = {
						id: rawItem.id,
						vaultId: rawItem.vaultId,
						accountId: this.accountId,
						accountEmail: this.accountEmail,
						serverUrl: this.serverUrl ?? this.fallbackServerUrl,
						category: rawItem.category,
						favorite: rawItem.favorite,
						encryptedData: rawItem.encryptedData,
						encryptionIv: rawItem.encryptionIv,
						encryptionAlgorithm: rawItem.encryptionAlgorithm,
						version: rawItem.version ?? 0,
						lastModifiedBy: rawItem.lastModifiedBy ?? null,
						encryptionVersion: rawItem.encryptionVersion ?? null,
						encryptedByUserId: rawItem.encryptedByUserId ?? null,
						createdAt: String(rawItem.createdAt),
						updatedAt: String(rawItem.updatedAt),
						deletedAt: rawItem.deletedAt ? String(rawItem.deletedAt) : null,
						attachments: rawItem.attachments,
					};
					await staging.upsertCachedItem(cachedItem);

					await staging.upsertCachedVault({
						...toCachedVaultFields(rawItem.vault),
						accountId: this.accountId,
						accountEmail: this.accountEmail,
						serverUrl: this.serverUrl ?? this.fallbackServerUrl,
					});
				}

				if (!page.hasMore || !page.nextCursor) {
					break;
				}
				cursor = page.nextCursor;
			}

			const fetchedVaultKeys = await this.fetchVaultKeysFromServer(client);
			refreshedVaultKeys = fetchedVaultKeys
				? travelMode.filterVaultKeys(this.accountId, fetchedVaultKeys)
				: null;
			await staging.promote({
				lastFullSyncAt: Date.now(),
				cacheVersion: 1,
			});
		} catch (error) {
			await staging.discard();
			throw error;
		}

		const [promotedItems, cachedVaults] = await Promise.all([
			this.itemCache.getCachedItems(this.accountId),
			this.itemCache.getCachedVaults(this.accountId),
		]);
		const cachedItems = [...(promotedItems ?? [])];
		const promotedIds = new Set(cachedItems.map((item) => item.id));
		for (const [itemId, conflictBase] of conflictBases) {
			if (!promotedIds.has(itemId)) {
				cachedItems.push(conflictBase);
				await this.persistItem(conflictBase);
			}
		}
		const vaultKeys =
			refreshedVaultKeys ?? (await this.storage.getVaultKeys(this.accountId));

		this.vaults.clear();
		for (const vault of cachedVaults ?? []) {
			this.vaults.set(vault.id, vault);
		}

		if (refreshedVaultKeys) {
			await this.storage.storeVaultKeys(refreshedVaultKeys, this.accountId);
		}
		this.mergeVaultKeyEntries(vaultKeys);

		this.items.clear();
		this.authoritativeItems.clear();
		this.legacyEncryptionAuthorsByVaultId.clear();
		for (const outcome of await this.decryptItemBatch(cachedItems)) {
			if ("decrypted" in outcome) {
				this.items.set(outcome.item.id, outcome.decrypted);
				this.authoritativeItems.set(
					outcome.item.id,
					this.toCachedItem(outcome.decrypted),
				);
			} else {
				this.authoritativeItems.set(outcome.item.id, outcome.item);
				console.error(
					`[VaultRepository] Failed to decrypt bootstrap ${await this.describeUndecryptableItem(outcome.item)}:`,
					outcome.error,
				);
			}
		}
		for (const itemId of new Set(
			Array.from(this.pendingCommands.values(), (command) => command.entityId),
		)) {
			await this.rebuildItemProjection(itemId);
		}

		this.hasCacheSnapshotFlag = true;
		this.hydrated = true;
		this.emit();
	}

	clear(): void {
		this.items.clear();
		this.authoritativeItems.clear();
		this.vaults.clear();
		this.vaultKeyEntries.clear();
		this.legacyEncryptionAuthorsByVaultId.clear();
		this.hydrated = false;
		this.hydrating = false;
		this.hasCacheSnapshotFlag = false;
		this.emit();
	}

	// --- SyncItemCache surface (packages/sync/src/types.ts) ---
	async upsertCachedItem(
		item: CachedEncryptedItem,
		accountId: string,
	): Promise<void> {
		await this.upsertEncrypted(item, accountId);
	}

	async removeCachedItem(itemId: string, accountId: string): Promise<void> {
		if (!this.isForThisAccount(accountId)) {
			return;
		}
		if (this.hasPendingEncryptedCommand(itemId)) {
			await this.rebuildItemProjection(itemId);
			return;
		}
		this.authoritativeItems.delete(itemId);
		await this.itemCache.removeCachedItem(itemId, this.accountId);
		await this.rebuildItemProjection(itemId);
	}

	async upsertCachedVault(
		vault: CachedVaultMetadata,
		accountId: string,
	): Promise<void> {
		if (!this.isForThisAccount(accountId)) {
			return;
		}
		this.vaults.set(vault.id, {
			...vault,
			accountId: vault.accountId ?? this.accountId,
			accountEmail: vault.accountEmail ?? this.accountEmail,
			serverUrl: vault.serverUrl ?? this.serverUrl ?? this.fallbackServerUrl,
		});
		const existingVaultKey = this.vaultKeyEntries.get(vault.id);
		if (existingVaultKey) {
			this.vaultKeyEntries.set(vault.id, {
				...existingVaultKey,
				vaultName: vault.name,
				vaultType: decodeVaultType(vault.type),
				vaultIcon: vault.icon,
				vaultImageUrl: vault.imageUrl,
			});
		}
		await this.itemCache.upsertCachedVault(vault, this.accountId);
		this.emit();
	}

	async syncVaultKeys(
		vaultKeys: VaultKeyData[],
		accountId: string,
	): Promise<void> {
		if (!this.isForThisAccount(accountId)) {
			return;
		}

		const filteredVaultKeys = getTravelModeEnforcer(
			this.storage,
			this.itemCache,
		).filterVaultKeys(this.accountId, vaultKeys);

		this.mergeVaultKeyEntries(filteredVaultKeys);
		await this.storage.storeVaultKeys(filteredVaultKeys, this.accountId);
		this.emit();
	}

	async removeCachedVault(vaultId: string, accountId: string): Promise<void> {
		if (!this.isForThisAccount(accountId)) {
			return;
		}
		this.vaults.delete(vaultId);
		this.vaultKeyEntries.delete(vaultId);
		for (const [itemId, item] of this.items.entries()) {
			if (item.vaultId === vaultId) {
				this.items.delete(itemId);
				this.authoritativeItems.delete(itemId);
			}
		}
		for (const [itemId, item] of this.authoritativeItems) {
			if (item.vaultId === vaultId) {
				this.authoritativeItems.delete(itemId);
			}
		}
		await this.itemCache.removeCachedVault(vaultId, this.accountId);
		this.emit();
	}

	async clearItemCache(accountId: string): Promise<void> {
		if (!this.isForThisAccount(accountId)) {
			return;
		}
		await this.itemCache.clearItemCache(this.accountId);
		this.clear();
	}

	async encryptWithVaultKey(
		vaultId: string,
		data: DecryptedItemData,
		options?: {
			itemId?: string;
			version?: number;
			userId?: string;
		},
	): Promise<EncryptedPayload> {
		const vaultKey = await this.decryptVaultKey(vaultId);
		try {
			if (!options?.itemId) {
				return this.crypto.encrypt(JSON.stringify(data), vaultKey, null);
			}
			const encryptionVersion = options.version ?? 1;
			const encryptedByUserId = options.userId ?? (await this.resolveUserId());
			const encrypted = await this.vaultCrypto.encryptItem(
				JSON.stringify(data),
				vaultKey,
				{
					vaultId,
					itemId: options.itemId,
					version: encryptionVersion,
					userId: encryptedByUserId,
				},
			);
			return { ...encrypted, encryptionVersion, encryptedByUserId };
		} finally {
			await this.crypto.destroyKey(vaultKey);
		}
	}
}
