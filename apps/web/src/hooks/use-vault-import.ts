import { getClientForAccount } from "@bittery/core";
import { useAllVaultKeys, useCoreContext } from "@bittery/core/hooks";
import {
	getDecryptedVaultKey,
	getImportProvider,
	type ImportErrorCode,
	type ImportMessageParams,
	type ImportPreview,
	ImportProviderError,
	type ImportProviderId,
	type ImportSourceItem,
	type ImportSourceVault,
	type ImportSourceVaultNameCode,
	type VaultKeyCryptoProvider,
} from "@bittery/shared";
import { useRPCClient } from "@bittery/shared/rpc";
import { resolveAccountScopeId } from "@bittery/storage/account-id";
import { useCallback, useMemo, useState } from "react";
import { storage } from "@/lib/storage";
import { decrypt, encrypt, rsaDecrypt } from "@/lib/wasm-crypto";
import { useI18n } from "@/providers/i18n-provider";
import { useClientId, useQueryInvalidator } from "@/providers/sync-provider";

const IMPORT_BATCH_SIZE = 200;
const DEFAULT_CREATED_VAULT_ICON = "lock";

const vaultKeyCrypto: VaultKeyCryptoProvider = {
	decrypt,
	rsaDecrypt,
};

export type ImportMappingMode = "create" | "existing";

export interface ImportVaultMapping {
	sourceVaultId: string;
	mode: ImportMappingMode;
	targetVaultName: string;
	targetVaultId: string | null;
}

export type ImportExecutionStage =
	| "idle"
	| "parsing"
	| "mapping"
	| "encrypting"
	| "uploading"
	| "finalizing"
	| "completed"
	| "error";

export interface ImportExecutionProgress {
	stage: ImportExecutionStage;
	totalItems: number;
	processedItems: number;
	totalVaults: number;
	processedVaults: number;
	currentVaultName?: string;
}

type HookImportErrorCode =
	| "provider-unavailable"
	| "file-incompatible"
	| "no-importable-items"
	| "import-not-ready"
	| "mapping-missing"
	| "target-vault-required"
	| "target-vault-name-required"
	| "target-vault-missing"
	| "target-vault-read-only"
	| "create-vault-account-required"
	| "missing-target-mapping"
	| "target-vault-key-decrypt-failed"
	| "vault-import-failed"
	| "parse-failed"
	| "execution-failed";

export type VaultImportErrorCode = HookImportErrorCode | ImportErrorCode;

export interface ImportMessageDescriptor {
	code: VaultImportErrorCode;
	params?: ImportMessageParams;
}

export interface ImportFailedVault {
	sourceVaultId: string;
	sourceVaultName: string;
	itemCount: number;
	reason: ImportMessageDescriptor;
}

export interface ImportExecutionSummary {
	providerId: ImportProviderId;
	importedCount: number;
	skippedCount: number;
	warningCount: number;
	createdVaultCount: number;
	failedVaultCount: number;
	failedVaults: ImportFailedVault[];
}

interface ResolvedTargetVault {
	vaultId: string;
	vaultName: string;
	accountId?: string;
	accountEmail?: string;
}

class VaultImportError extends Error {
	readonly code: VaultImportErrorCode;
	readonly params?: ImportMessageParams;

	constructor(code: VaultImportErrorCode, params?: ImportMessageParams) {
		super(code);
		this.name = "VaultImportError";
		this.code = code;
		this.params = params;
	}
}

function createEmptyProgress(): ImportExecutionProgress {
	return {
		stage: "idle",
		totalItems: 0,
		processedItems: 0,
		totalVaults: 0,
		processedVaults: 0,
	};
}

function buildDefaultMappings(
	sourceVaults: ImportSourceVault[],
): Record<string, ImportVaultMapping> {
	return sourceVaults.reduce<Record<string, ImportVaultMapping>>(
		(acc, source) => {
			acc[source.id] = {
				sourceVaultId: source.id,
				mode: "create",
				targetVaultName: source.name,
				targetVaultId: null,
			};
			return acc;
		},
		{},
	);
}

/**
 * Providers live in `@bittery/shared` and cannot translate. A source vault they
 * synthesize (Bitwarden's unfoldered bucket) carries a `nameCode` instead, which
 * is resolved here — before mappings are built, so the prefilled target vault
 * name is localized too.
 */
function localizeSourceVaultNames(
	preview: ImportPreview,
	resolveName: (nameCode: ImportSourceVaultNameCode) => string,
): ImportPreview {
	if (!preview.sourceVaults.some((sourceVault) => sourceVault.nameCode)) {
		return preview;
	}

	return {
		...preview,
		sourceVaults: preview.sourceVaults.map((sourceVault) =>
			sourceVault.nameCode
				? { ...sourceVault, name: resolveName(sourceVault.nameCode) }
				: sourceVault,
		),
	};
}

function filterImportablePreview(preview: ImportPreview): ImportPreview {
	const importableVaultIds = new Set(
		preview.sourceVaults
			.filter((sourceVault) => sourceVault.itemCount > 0)
			.map((sourceVault) => sourceVault.id),
	);

	const sourceVaults = preview.sourceVaults.filter((sourceVault) =>
		importableVaultIds.has(sourceVault.id),
	);
	const sourceItems = preview.sourceItems.filter((sourceItem) =>
		importableVaultIds.has(sourceItem.sourceVaultId),
	);

	return {
		...preview,
		sourceVaults,
		sourceItems,
		summary: {
			...preview.summary,
			vaultCount: sourceVaults.length,
			itemCount: sourceItems.length,
		},
	};
}

function groupItemsBySourceVault(
	items: ImportSourceItem[],
): Map<string, ImportSourceItem[]> {
	const groups = new Map<string, ImportSourceItem[]>();
	for (const item of items) {
		const existing = groups.get(item.sourceVaultId);
		if (existing) {
			existing.push(item);
			continue;
		}
		groups.set(item.sourceVaultId, [item]);
	}
	return groups;
}

function toImportMessageDescriptor(
	error: VaultImportError,
): ImportMessageDescriptor {
	return {
		code: error.code,
		...(error.params ? { params: error.params } : {}),
	};
}

function normalizeImportError(
	error: unknown,
	fallbackCode: HookImportErrorCode,
): VaultImportError {
	if (error instanceof VaultImportError) {
		return error;
	}
	if (error instanceof ImportProviderError) {
		return new VaultImportError(error.code, error.params);
	}
	return new VaultImportError(fallbackCode);
}

export function useVaultImport() {
	const { m } = useI18n();
	const core = useCoreContext();
	const rpcClient = useRPCClient();
	const invalidator = useQueryInvalidator();
	const clientId = useClientId();
	const { vaultKeys } = useAllVaultKeys();

	const [providerId, setProviderId] = useState<ImportProviderId | null>(null);
	const [preview, setPreview] = useState<ImportPreview | null>(null);
	const [mappings, setMappings] = useState<Record<string, ImportVaultMapping>>(
		{},
	);
	const [progress, setProgress] = useState<ImportExecutionProgress>(
		createEmptyProgress(),
	);
	const [summary, setSummary] = useState<ImportExecutionSummary | null>(null);
	const [error, setError] = useState<ImportMessageDescriptor | null>(null);
	const [isBusy, setIsBusy] = useState(false);
	const [skippedEmptyVaultCount, setSkippedEmptyVaultCount] = useState(0);

	const resolveSourceVaultName = useCallback(
		(nameCode: ImportSourceVaultNameCode) => {
			switch (nameCode) {
				case "no-folder":
					return m.vaults_import_source_vault_no_folder();
				case "chrome-passwords":
					return m.vaults_import_source_vault_chrome_passwords();
				default:
					return nameCode;
			}
		},
		[m],
	);

	const existingVaults = useMemo(
		() =>
			[...vaultKeys].sort((a, b) =>
				a.vaultName.localeCompare(b.vaultName, undefined, {
					sensitivity: "base",
				}),
			),
		[vaultKeys],
	);

	const existingVaultById = useMemo(() => {
		return new Map(existingVaults.map((vault) => [vault.vaultId, vault]));
	}, [existingVaults]);

	const reset = useCallback(() => {
		setProviderId(null);
		setPreview(null);
		setMappings({});
		setProgress(createEmptyProgress());
		setSummary(null);
		setError(null);
		setIsBusy(false);
		setSkippedEmptyVaultCount(0);
	}, []);

	const parseFile = useCallback(
		async (file: File, selectedProviderId: ImportProviderId) => {
			setIsBusy(true);
			setError(null);
			setSummary(null);
			setProgress({
				stage: "parsing",
				totalItems: 0,
				processedItems: 0,
				totalVaults: 0,
				processedVaults: 0,
			});

			try {
				const provider = getImportProvider(selectedProviderId);
				if (!provider) {
					throw new VaultImportError("provider-unavailable");
				}

				if (!provider.canParse(file)) {
					throw new VaultImportError("file-incompatible", {
						providerTitle: provider.title,
					});
				}

				const parsedPreview = localizeSourceVaultNames(
					await provider.parse(file),
					resolveSourceVaultName,
				);
				const emptyVaultCount = parsedPreview.sourceVaults.filter(
					(sourceVault) => sourceVault.itemCount === 0,
				).length;
				setSkippedEmptyVaultCount(emptyVaultCount);
				const importablePreview = filterImportablePreview(parsedPreview);
				if (importablePreview.sourceVaults.length === 0) {
					throw new VaultImportError("no-importable-items");
				}

				setProviderId(provider.id);
				setPreview(importablePreview);
				setMappings(buildDefaultMappings(importablePreview.sourceVaults));
				setProgress({
					stage: "mapping",
					totalItems: importablePreview.sourceItems.length,
					processedItems: 0,
					totalVaults: importablePreview.sourceVaults.length,
					processedVaults: 0,
				});
			} catch (parseError) {
				const normalizedError = normalizeImportError(
					parseError,
					"parse-failed",
				);
				setError(toImportMessageDescriptor(normalizedError));
				setProviderId(null);
				setPreview(null);
				setMappings({});
				setSkippedEmptyVaultCount(0);
				setProgress({
					stage: "error",
					totalItems: 0,
					processedItems: 0,
					totalVaults: 0,
					processedVaults: 0,
				});
				throw normalizedError;
			} finally {
				setIsBusy(false);
			}
		},
		[resolveSourceVaultName],
	);

	const updateVaultMapping = useCallback(
		(
			sourceVaultId: string,
			updater: (current: ImportVaultMapping) => ImportVaultMapping,
		) => {
			setMappings((current) => {
				const existing = current[sourceVaultId];
				if (!existing) {
					return current;
				}
				return {
					...current,
					[sourceVaultId]: updater(existing),
				};
			});
		},
		[],
	);

	const setMappingMode = useCallback(
		(sourceVaultId: string, mode: ImportMappingMode) => {
			updateVaultMapping(sourceVaultId, (current) => ({
				...current,
				mode,
				targetVaultId: mode === "existing" ? current.targetVaultId : null,
			}));
		},
		[updateVaultMapping],
	);

	const setMappingTargetVaultId = useCallback(
		(sourceVaultId: string, targetVaultId: string) => {
			updateVaultMapping(sourceVaultId, (current) => ({
				...current,
				mode: "existing",
				targetVaultId,
			}));
		},
		[updateVaultMapping],
	);

	const setMappingTargetVaultName = useCallback(
		(sourceVaultId: string, targetVaultName: string) => {
			updateVaultMapping(sourceVaultId, (current) => ({
				...current,
				mode: "create",
				targetVaultName,
			}));
		},
		[updateVaultMapping],
	);

	const executeImport =
		useCallback(async (): Promise<ImportExecutionSummary> => {
			if (!preview || !providerId) {
				throw new VaultImportError("import-not-ready");
			}

			const provider = getImportProvider(providerId);
			if (!provider) {
				throw new VaultImportError("provider-unavailable");
			}

			const sourceVaults = preview.sourceVaults;
			const sourceItemsByVault = groupItemsBySourceVault(preview.sourceItems);
			const resolvedTargets = new Map<string, ResolvedTargetVault>();
			const failedVaults: ImportFailedVault[] = [];
			const createdVaults: ResolvedTargetVault[] = [];
			const userIdByAccount = new Map<string, string>();

			const resolveUserIdForContext = async (
				accountId: string,
			): Promise<string> => {
				const cachedUserId = userIdByAccount.get(accountId);
				if (cachedUserId) {
					return cachedUserId;
				}

				const sessionData = await storage.getStoredSessionData?.(accountId);
				const userId =
					sessionData?.userId ?? (await storage.getActiveAccountUserId());
				if (!userId) {
					throw new Error("User ID not available for encryption context");
				}

				userIdByAccount.set(accountId, userId);
				return userId;
			};

			setIsBusy(true);
			setError(null);
			setSummary(null);

			let importedCount = 0;
			let skippedCount = preview.summary.skippedCount;
			let processedItems = 0;
			let processedVaults = 0;

			setProgress({
				stage: "mapping",
				totalItems: preview.sourceItems.length,
				processedItems: 0,
				totalVaults: sourceVaults.length,
				processedVaults: 0,
			});

			try {
				for (const sourceVault of sourceVaults) {
					const mapping = mappings[sourceVault.id];
					if (!mapping) {
						throw new VaultImportError("mapping-missing", {
							sourceVaultName: sourceVault.name,
						});
					}

					if (mapping.mode === "create") {
						if (!mapping.targetVaultName.trim()) {
							throw new VaultImportError("target-vault-name-required", {
								sourceVaultName: sourceVault.name,
							});
						}
						continue;
					}

					if (!mapping.targetVaultId) {
						throw new VaultImportError("target-vault-required", {
							sourceVaultName: sourceVault.name,
						});
					}

					const targetVault = existingVaultById.get(mapping.targetVaultId);
					if (!targetVault) {
						throw new VaultImportError("target-vault-missing", {
							sourceVaultName: sourceVault.name,
						});
					}

					if (targetVault.role === "read-only") {
						throw new VaultImportError("target-vault-read-only", {
							targetVaultName: targetVault.vaultName,
						});
					}

					resolvedTargets.set(sourceVault.id, {
						vaultId: targetVault.vaultId,
						vaultName: targetVault.vaultName,
						accountEmail: targetVault.accountEmail,
					});
				}

				const activeAccount = await storage.getActiveAccount();
				const defaultAccountId =
					activeAccount?.type === "single"
						? activeAccount.accountId
						: undefined;
				const defaultAccountEmail = defaultAccountId
					? (await storage.getAccountsList()).find(
							(a) => a.accountId === defaultAccountId,
						)?.email
					: undefined;

				// A default account is only required to CREATE new vaults.
				// Existing-vault mappings resolve their own account later via
				// resolveAccountScopeId, so imports that only reuse existing
				// vaults must be allowed to proceed in "All Accounts" mode.
				const requiresVaultCreation = sourceVaults.some(
					(sourceVault) => mappings[sourceVault.id]?.mode === "create",
				);
				if (requiresVaultCreation && !defaultAccountId) {
					throw new VaultImportError("create-vault-account-required");
				}

				for (const sourceVault of sourceVaults) {
					const mapping = mappings[sourceVault.id];
					if (!mapping || mapping.mode !== "create") {
						continue;
					}

					if (!defaultAccountId) {
						throw new VaultImportError("create-vault-account-required");
					}

					const targetVaultName = mapping.targetVaultName.trim();
					setProgress((current) => ({
						...current,
						stage: "mapping",
						currentVaultName: targetVaultName,
					}));

					const createdVault = await core.vaults.createVault(
						{
							name: targetVaultName,
							type: "personal",
							icon: DEFAULT_CREATED_VAULT_ICON,
							accountId: defaultAccountId,
						},
						rpcClient,
					);

					const resolvedTarget: ResolvedTargetVault = {
						vaultId: createdVault.vaultId,
						vaultName: targetVaultName,
						accountId: defaultAccountId,
						accountEmail: defaultAccountEmail,
					};

					createdVaults.push(resolvedTarget);
					resolvedTargets.set(sourceVault.id, resolvedTarget);
				}

				const refreshAccountId =
					createdVaults[0]?.accountId ?? defaultAccountId;
				if (createdVaults.length > 0 && refreshAccountId) {
					await core.vaults.refreshVaultKeys(rpcClient, refreshAccountId);
					await invalidator.invalidateVaultKeys();
				}

				for (const sourceVault of sourceVaults) {
					const sourceItems = sourceItemsByVault.get(sourceVault.id) ?? [];
					const resolvedTarget = resolvedTargets.get(sourceVault.id);

					if (!resolvedTarget) {
						failedVaults.push({
							sourceVaultId: sourceVault.id,
							sourceVaultName: sourceVault.name,
							itemCount: sourceItems.length,
							reason: { code: "missing-target-mapping" },
						});
						skippedCount += sourceItems.length;
						processedItems += sourceItems.length;
						processedVaults += 1;
						continue;
					}

					setProgress((current) => ({
						...current,
						stage: "encrypting",
						currentVaultName: sourceVault.name,
						processedVaults,
						processedItems,
					}));

					let encryptedItemsInVault = 0;
					let importedItemsInVault = 0;

					try {
						const accountId = await resolveAccountScopeId(
							storage,
							resolvedTarget.accountEmail,
						);
						if (!accountId) {
							throw new VaultImportError("vault-import-failed", {
								targetVaultName: resolvedTarget.vaultName,
							});
						}
						const vaultRpcClient = await getClientForAccount(
							storage,
							rpcClient,
							accountId,
						);
						const userId = await resolveUserIdForContext(accountId);
						const vaultKey = await getDecryptedVaultKey({
							vaultId: resolvedTarget.vaultId,
							accountId,
							storage,
							crypto: vaultKeyCrypto,
						});

						if (!vaultKey) {
							throw new VaultImportError("target-vault-key-decrypt-failed", {
								targetVaultName: resolvedTarget.vaultName,
							});
						}

						const encryptedItems = [];
						for (const sourceItem of sourceItems) {
							const decryptedItem = provider.toDecryptedItemData(sourceItem);
							const itemId = await core.items.generateItemId();
							const encryptedData = await encrypt(
								JSON.stringify(decryptedItem.data),
								vaultKey,
								{
									vaultId: resolvedTarget.vaultId,
									entityId: itemId,
									entityType: "item",
									version: 1,
									userId,
								},
							);

							encryptedItems.push({
								itemId,
								category: decryptedItem.category,
								favorite: decryptedItem.favorite,
								encryptedData: encryptedData.ciphertext,
								encryptionIv: encryptedData.iv,
								encryptionAlgorithm: encryptedData.algorithm,
							});

							encryptedItemsInVault += 1;
							processedItems += 1;

							setProgress((current) => ({
								...current,
								stage: "encrypting",
								currentVaultName: sourceVault.name,
								processedItems,
							}));
						}

						setProgress((current) => ({
							...current,
							stage: "uploading",
							currentVaultName: sourceVault.name,
						}));

						for (
							let index = 0;
							index < encryptedItems.length;
							index += IMPORT_BATCH_SIZE
						) {
							const batch = encryptedItems.slice(
								index,
								index + IMPORT_BATCH_SIZE,
							);
							const result = await vaultRpcClient.vault.bulkImportItems.mutate({
								vaultId: resolvedTarget.vaultId,
								clientId: clientId ?? null,
								items: batch,
							});
							importedItemsInVault += result.importedCount;
							importedCount += result.importedCount;
						}

						await invalidator.invalidateVaultList(resolvedTarget.vaultId);
					} catch (vaultError) {
						const remainingItems = Math.max(
							0,
							sourceItems.length - encryptedItemsInVault,
						);
						processedItems += remainingItems;
						const skippedItemsInVault = Math.max(
							0,
							sourceItems.length - importedItemsInVault,
						);
						skippedCount += skippedItemsInVault;
						const normalizedVaultError = normalizeImportError(
							vaultError,
							"vault-import-failed",
						);
						failedVaults.push({
							sourceVaultId: sourceVault.id,
							sourceVaultName: sourceVault.name,
							itemCount: skippedItemsInVault,
							reason: toImportMessageDescriptor(normalizedVaultError),
						});
					}

					processedVaults += 1;
					setProgress((current) => ({
						...current,
						processedVaults,
						processedItems,
					}));
				}

				setProgress((current) => ({
					...current,
					stage: "finalizing",
					currentVaultName: undefined,
				}));

				if (storage.clearItemCache) {
					await storage.clearItemCache();
				}

				const { accountsInfo } = await core.accounts.resolveAccounts();
				if (accountsInfo.length > 0) {
					await core.vaultCoordinator.refreshFromServer(accountsInfo);
				}

				if (createdVaults.length > 0) {
					await invalidator.invalidateVaultKeys();
				}

				const resultSummary: ImportExecutionSummary = {
					providerId,
					importedCount,
					skippedCount,
					warningCount: preview.warnings.length,
					createdVaultCount: createdVaults.length,
					failedVaultCount: failedVaults.length,
					failedVaults,
				};

				setSummary(resultSummary);
				setProgress({
					stage: "completed",
					totalItems: preview.sourceItems.length,
					processedItems,
					totalVaults: sourceVaults.length,
					processedVaults,
				});
				return resultSummary;
			} catch (executionError) {
				const normalizedError = normalizeImportError(
					executionError,
					"execution-failed",
				);
				setError(toImportMessageDescriptor(normalizedError));
				setProgress((current) => ({
					...current,
					stage: "error",
				}));
				throw normalizedError;
			} finally {
				setIsBusy(false);
			}
		}, [
			preview,
			providerId,
			mappings,
			existingVaultById,
			core.items,
			core.vaults,
			core.accounts,
			core.vaultCoordinator,
			rpcClient,
			invalidator,
			clientId,
		]);

	return {
		providerId,
		preview,
		mappings,
		existingVaults,
		progress,
		summary,
		error,
		isBusy,
		skippedEmptyVaultCount,
		reset,
		parseFile,
		executeImport,
		setMappingMode,
		setMappingTargetVaultId,
		setMappingTargetVaultName,
	};
}
