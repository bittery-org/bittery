import { useAllVaultKeys, useCoreContext } from "@bittery/core/hooks";
import {
	getDecryptedVaultKey,
	getImportProvider,
	type ImportPreview,
	type ImportProviderId,
	type ImportSourceItem,
	type ImportSourceVault,
	type VaultKeyCryptoProvider,
} from "@bittery/shared";
import { useTRPCClient } from "@bittery/shared/trpc";
import { useCallback, useMemo, useState } from "react";
import { storage } from "@/lib/storage";
import { decrypt, encrypt, rsaDecrypt } from "@/lib/wasm-crypto";
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
	message: string;
	totalItems: number;
	processedItems: number;
	totalVaults: number;
	processedVaults: number;
	currentVaultName?: string;
}

export interface ImportFailedVault {
	sourceVaultId: string;
	sourceVaultName: string;
	itemCount: number;
	message: string;
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
	accountEmail?: string;
}

function createEmptyProgress(): ImportExecutionProgress {
	return {
		stage: "idle",
		message: "",
		totalItems: 0,
		processedItems: 0,
		totalVaults: 0,
		processedVaults: 0,
	};
}

function normalizeCreatedVaultName(name: string): string {
	const trimmed = name.trim();
	return trimmed.length > 0 ? trimmed : "Imported Vault";
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

function getImportErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return "Import failed due to an unexpected error.";
}

function getProgressMessage(
	stage: ImportExecutionStage,
	currentVaultName?: string,
): string {
	switch (stage) {
		case "parsing":
			return "Parsing import file...";
		case "mapping":
			return currentVaultName
				? `Preparing vault "${currentVaultName}"...`
				: "Preparing vault mappings...";
		case "encrypting":
			return currentVaultName
				? `Encrypting items for "${currentVaultName}"...`
				: "Encrypting imported items...";
		case "uploading":
			return currentVaultName
				? `Uploading items to "${currentVaultName}"...`
				: "Uploading encrypted batches...";
		case "finalizing":
			return "Finalizing import...";
		case "completed":
			return "Import completed.";
		case "error":
			return "Import failed.";
		default:
			return "";
	}
}

export function useVaultImport() {
	const core = useCoreContext();
	const trpcClient = useTRPCClient();
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
	const [error, setError] = useState<string | null>(null);
	const [isBusy, setIsBusy] = useState(false);
	const [skippedEmptyVaultCount, setSkippedEmptyVaultCount] = useState(0);

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
				message: getProgressMessage("parsing"),
				totalItems: 0,
				processedItems: 0,
				totalVaults: 0,
				processedVaults: 0,
			});

			try {
				const provider = getImportProvider(selectedProviderId);
				if (!provider) {
					throw new Error("Selected import provider is unavailable.");
				}

				if (!provider.canParse(file)) {
					throw new Error(
						`This file is not compatible with ${provider.title}. Please upload a valid export file.`,
					);
				}

				const parsedPreview = await provider.parse(file);
				const emptyVaultCount = parsedPreview.sourceVaults.filter(
					(sourceVault) => sourceVault.itemCount === 0,
				).length;
				setSkippedEmptyVaultCount(emptyVaultCount);
				const importablePreview = filterImportablePreview(parsedPreview);
				if (importablePreview.sourceVaults.length === 0) {
					throw new Error(
						"No importable items were found. This export only contains empty vaults.",
					);
				}

				setProviderId(provider.id);
				setPreview(importablePreview);
				setMappings(buildDefaultMappings(importablePreview.sourceVaults));
				setProgress({
					stage: "mapping",
					message: getProgressMessage("mapping"),
					totalItems: importablePreview.sourceItems.length,
					processedItems: 0,
					totalVaults: importablePreview.sourceVaults.length,
					processedVaults: 0,
				});
			} catch (parseError) {
				const message = getImportErrorMessage(parseError);
				setError(message);
				setProviderId(null);
				setPreview(null);
				setMappings({});
				setSkippedEmptyVaultCount(0);
				setProgress({
					stage: "error",
					message,
					totalItems: 0,
					processedItems: 0,
					totalVaults: 0,
					processedVaults: 0,
				});
				throw parseError;
			} finally {
				setIsBusy(false);
			}
		},
		[],
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
				throw new Error(
					"Upload and parse an export file before starting import.",
				);
			}

			const provider = getImportProvider(providerId);
			if (!provider) {
				throw new Error("Import provider is unavailable.");
			}

			const sourceVaults = preview.sourceVaults;
			const sourceItemsByVault = groupItemsBySourceVault(preview.sourceItems);
			const resolvedTargets = new Map<string, ResolvedTargetVault>();
			const failedVaults: ImportFailedVault[] = [];
			const createdVaults: ResolvedTargetVault[] = [];

			setIsBusy(true);
			setError(null);
			setSummary(null);

			let importedCount = 0;
			let skippedCount = preview.summary.skippedCount;
			let processedItems = 0;
			let processedVaults = 0;

			setProgress({
				stage: "mapping",
				message: getProgressMessage("mapping"),
				totalItems: preview.sourceItems.length,
				processedItems: 0,
				totalVaults: sourceVaults.length,
				processedVaults: 0,
			});

			try {
				for (const sourceVault of sourceVaults) {
					const mapping = mappings[sourceVault.id];
					if (!mapping) {
						throw new Error(
							`Missing mapping for source vault "${sourceVault.name}".`,
						);
					}

					if (mapping.mode === "existing") {
						if (!mapping.targetVaultId) {
							throw new Error(
								`Select a target vault for "${sourceVault.name}" or choose create new.`,
							);
						}

						const targetVault = existingVaultById.get(mapping.targetVaultId);
						if (!targetVault) {
							throw new Error(
								`Selected target vault for "${sourceVault.name}" is no longer available.`,
							);
						}

						if (targetVault.role === "read-only") {
							throw new Error(
								`"${targetVault.vaultName}" is read-only. Choose another vault or create a new one.`,
							);
						}

						resolvedTargets.set(sourceVault.id, {
							vaultId: targetVault.vaultId,
							vaultName: targetVault.vaultName,
							accountEmail: targetVault.accountEmail,
						});
					}
				}

				const activeAccount = await storage.getActiveAccount();
				const defaultAccountEmail =
					activeAccount?.type === "single" ? activeAccount.email : undefined;

				for (const sourceVault of sourceVaults) {
					const mapping = mappings[sourceVault.id];
					if (!mapping || mapping.mode !== "create") {
						continue;
					}

					const targetVaultName = normalizeCreatedVaultName(
						mapping.targetVaultName,
					);
					setProgress((current) => ({
						...current,
						stage: "mapping",
						message: getProgressMessage("mapping", targetVaultName),
						currentVaultName: targetVaultName,
					}));

					const createdVault = await core.vaults.createVault(
						{
							name: targetVaultName,
							type: "personal",
							icon: DEFAULT_CREATED_VAULT_ICON,
							accountEmail: defaultAccountEmail,
						},
						trpcClient,
					);

					const resolvedTarget: ResolvedTargetVault = {
						vaultId: createdVault.vaultId,
						vaultName: targetVaultName,
						accountEmail: defaultAccountEmail,
					};

					createdVaults.push(resolvedTarget);
					resolvedTargets.set(sourceVault.id, resolvedTarget);
				}

				if (createdVaults.length > 0) {
					await core.vaults.refreshVaultKeys(
						trpcClient,
						createdVaults[0].accountEmail,
					);
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
							message: "No target vault mapping found.",
						});
						skippedCount += sourceItems.length;
						processedItems += sourceItems.length;
						processedVaults += 1;
						continue;
					}

					setProgress((current) => ({
						...current,
						stage: "encrypting",
						message: getProgressMessage("encrypting", sourceVault.name),
						currentVaultName: sourceVault.name,
						processedVaults,
						processedItems,
					}));

					let encryptedItemsInVault = 0;
					let importedItemsInVault = 0;

					try {
						const vaultKey = await getDecryptedVaultKey({
							vaultId: resolvedTarget.vaultId,
							email: resolvedTarget.accountEmail,
							storage,
							crypto: vaultKeyCrypto,
						});

						if (!vaultKey) {
							throw new Error(
								`Could not decrypt target vault key for "${resolvedTarget.vaultName}".`,
							);
						}

						const encryptedItems = [];
						for (const sourceItem of sourceItems) {
							const decryptedItem = provider.toDecryptedItemData(sourceItem);
							const encryptedData = await encrypt(
								JSON.stringify(decryptedItem.data),
								vaultKey,
							);

							encryptedItems.push({
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
								message: getProgressMessage("encrypting", sourceVault.name),
								currentVaultName: sourceVault.name,
								processedItems,
							}));
						}

						setProgress((current) => ({
							...current,
							stage: "uploading",
							message: getProgressMessage("uploading", sourceVault.name),
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
							const result = await trpcClient.vault.bulkImportItems.mutate({
								vaultId: resolvedTarget.vaultId,
								clientId: clientId || undefined,
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
						failedVaults.push({
							sourceVaultId: sourceVault.id,
							sourceVaultName: sourceVault.name,
							itemCount: skippedItemsInVault,
							message: getImportErrorMessage(vaultError),
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
					message: getProgressMessage("finalizing"),
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
					message: getProgressMessage("completed"),
					totalItems: preview.sourceItems.length,
					processedItems,
					totalVaults: sourceVaults.length,
					processedVaults,
				});
				return resultSummary;
			} catch (executionError) {
				const message = getImportErrorMessage(executionError);
				setError(message);
				setProgress((current) => ({
					...current,
					stage: "error",
					message,
				}));
				throw executionError;
			} finally {
				setIsBusy(false);
			}
		}, [
			preview,
			providerId,
			mappings,
			existingVaultById,
			core.vaults,
			core.accounts,
			core.vaultCoordinator,
			trpcClient,
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
