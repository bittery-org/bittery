import { RuntimeRequestError } from "@bittery/client-runtime/client";
import type { ItemDraft } from "@bittery/client-runtime/protocol";
import {
	useRuntimeClient,
	useRuntimeOperations,
	useRuntimeSession,
	useRuntimeWritableVaults,
} from "@bittery/client-runtime/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	getImportProvider,
	type ImportErrorCode,
	type ImportMessageParams,
	type ImportPreview,
	ImportProviderError,
	type ImportProviderId,
	type ImportSourceItem,
	type ImportSourceVault,
	type ImportSourceVaultNameCode,
} from "@/lib/import";
import { waitForRuntimeOperation } from "@/lib/runtime-import-progress";
import { useI18n } from "@/providers/i18n-provider";

const IMPORT_BATCH_SIZE = 200;
const DEFAULT_CREATED_VAULT_ICON = "lock";

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
	accountId: string;
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

class StaleImportOperation extends Error {
	constructor() {
		super("stale-import-operation");
		this.name = "StaleImportOperation";
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
	const runtimeClient = useRuntimeClient();
	const writableVaults = useRuntimeWritableVaults();
	const session = useRuntimeSession();
	const activeAccount = session.state === "unlocked" ? session.accountId : null;
	const operations = useRuntimeOperations(activeAccount);
	const waiting = useRef<AbortController | null>(null);
	const asyncFence = useRef({ accountId: activeAccount, epoch: 0 });
	if (asyncFence.current.accountId !== activeAccount) {
		waiting.current?.abort();
		asyncFence.current = {
			accountId: activeAccount,
			epoch: asyncFence.current.epoch + 1,
		};
	}
	const beginAsyncOperation = useCallback(() => {
		waiting.current?.abort();
		waiting.current = new AbortController();
		const fence = asyncFence.current;
		fence.epoch += 1;
		return { accountId: fence.accountId, epoch: fence.epoch };
	}, []);
	const operationIsCurrent = useCallback(
		(operation: { accountId: string | null; epoch: number }) =>
			asyncFence.current.accountId === operation.accountId &&
			asyncFence.current.epoch === operation.epoch,
		[],
	);
	const cancelAsyncOperations = useCallback(() => {
		waiting.current?.abort();
		asyncFence.current.epoch += 1;
	}, []);

	const [presentationAccountId, setPresentationAccountId] =
		useState(activeAccount);
	const [localProviderId, setProviderId] = useState<ImportProviderId | null>(
		null,
	);
	const [localPreview, setPreview] = useState<ImportPreview | null>(null);
	const [localMappings, setMappings] = useState<
		Record<string, ImportVaultMapping>
	>({});
	const [localProgress, setProgress] = useState<ImportExecutionProgress>(
		createEmptyProgress(),
	);
	const [localSummary, setSummary] = useState<ImportExecutionSummary | null>(
		null,
	);
	const [localError, setError] = useState<ImportMessageDescriptor | null>(null);
	const [localIsBusy, setIsBusy] = useState(false);
	const [localSkippedEmptyVaultCount, setSkippedEmptyVaultCount] = useState(0);
	const localPresentationIsActive =
		activeAccount !== null && presentationAccountId === activeAccount;
	// Hide Account-scoped plaintext in the switching render, before cleanup runs.
	const providerId = localPresentationIsActive ? localProviderId : null;
	const preview = localPresentationIsActive ? localPreview : null;
	const mappings = localPresentationIsActive ? localMappings : {};
	const pendingImport =
		operations.state === "ready" &&
		operations.value.operations.some(
			(entry) => entry.kind === "importItems" && entry.resolution === "pending",
		);
	const progress = localPresentationIsActive
		? localProgress
		: createEmptyProgress();
	const summary = localPresentationIsActive ? localSummary : null;
	const error = localPresentationIsActive ? localError : null;
	const isBusy = localPresentationIsActive ? localIsBusy : false;
	const skippedEmptyVaultCount = localPresentationIsActive
		? localSkippedEmptyVaultCount
		: 0;
	const clearPresentation = useCallback(() => {
		setProviderId(null);
		setPreview(null);
		setMappings({});
		setProgress(createEmptyProgress());
		setSummary(null);
		setError(null);
		setIsBusy(false);
		setSkippedEmptyVaultCount(0);
	}, []);
	useEffect(() => () => cancelAsyncOperations(), [cancelAsyncOperations]);

	useEffect(() => {
		setPresentationAccountId(activeAccount);
		clearPresentation();
	}, [activeAccount, clearPresentation]);

	const resolveSourceVaultName = useCallback(
		(nameCode: ImportSourceVaultNameCode) => {
			switch (nameCode) {
				case "no-folder":
					return m.vaults_import_source_vault_no_folder();
				case "chrome-passwords":
					return m.vaults_import_source_vault_chrome_passwords();
				case "no-group":
					return m.vaults_import_source_vault_no_group();
				default:
					return nameCode;
			}
		},
		[m],
	);

	const existingVaults = useMemo(
		() =>
			(writableVaults.state === "ready" ? writableVaults.value.vaults : [])
				.map((vault) => ({ ...vault, vaultName: vault.name }))
				.sort((a, b) =>
					a.vaultName.localeCompare(b.vaultName, undefined, {
						sensitivity: "base",
					}),
				),
		[writableVaults],
	);

	const existingVaultById = useMemo(() => {
		return new Map(existingVaults.map((vault) => [vault.vaultId, vault]));
	}, [existingVaults]);

	const reset = useCallback(() => {
		cancelAsyncOperations();
		clearPresentation();
	}, [cancelAsyncOperations, clearPresentation]);

	const parseFile = useCallback(
		async (file: File, selectedProviderId: ImportProviderId) => {
			const operation = beginAsyncOperation();
			setPresentationAccountId(activeAccount);
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
				if (!operationIsCurrent(operation)) return;
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
				if (!operationIsCurrent(operation)) return;
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
				if (operationIsCurrent(operation)) setIsBusy(false);
			}
		},
		[
			activeAccount,
			beginAsyncOperation,
			operationIsCurrent,
			resolveSourceVaultName,
		],
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
		useCallback(async (): Promise<ImportExecutionSummary | null> => {
			const operation = beginAsyncOperation();
			const assertOperationIsCurrent = () => {
				if (!operationIsCurrent(operation)) throw new StaleImportOperation();
			};
			if (!preview || !providerId) {
				throw new VaultImportError("import-not-ready");
			}

			const provider = getImportProvider(providerId);
			if (!provider) {
				throw new VaultImportError("provider-unavailable");
			}
			const signal = waiting.current?.signal;
			if (!signal) throw new StaleImportOperation();
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
						accountId: targetVault.accountId,
					});
				}

				const defaultAccountId = operation.accountId ?? undefined;

				// A default account is only required to create new vaults. Existing
				// mappings carry the accountId from the Runtime's writable-Vault catalog.
				const requiresVaultCreation = sourceVaults.some(
					(sourceVault) => mappings[sourceVault.id]?.mode === "create",
				);
				if (requiresVaultCreation && !defaultAccountId) {
					throw new VaultImportError("create-vault-account-required");
				}

				for (const sourceVault of sourceVaults) {
					const mapping = mappings[sourceVault.id];
					if (mapping?.mode !== "create") {
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

					const createdVault = await runtimeClient.createVault({
						name: targetVaultName,
						vaultType: "personal",
						icon: DEFAULT_CREATED_VAULT_ICON,
						accountId: defaultAccountId,
					});

					const resolvedTarget: ResolvedTargetVault = {
						vaultId: createdVault.vaultId,
						vaultName: targetVaultName,
						accountId: defaultAccountId,
					};

					createdVaults.push(resolvedTarget);
					resolvedTargets.set(sourceVault.id, resolvedTarget);
					assertOperationIsCurrent();
					// Reuse the accepted target if presentation is retried after a later failure.
					setMappings((current) => ({
						...current,
						[sourceVault.id]: {
							...mapping,
							mode: "existing",
							targetVaultId: createdVault.vaultId,
						},
					}));
					await waitForRuntimeOperation(
						runtimeClient,
						defaultAccountId,
						createdVault.operationId,
						signal,
					);
					assertOperationIsCurrent();
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

					let importedItemsInVault = 0;
					let refusedItems = 0;
					try {
						const drafts = sourceItems.map((sourceItem) => {
							const item = provider.toDecryptedItemData(sourceItem);
							return {
								draft: {
									category:
										item.category === "totp" ? "authenticator" : item.category,
									data: item.data,
								} as ItemDraft,
								favorite: item.favorite,
							};
						});
						const submit = async (items: typeof drafts): Promise<void> => {
							assertOperationIsCurrent();
							let accepted: Awaited<
								ReturnType<typeof runtimeClient.importItems>
							>;
							try {
								accepted = await runtimeClient.importItems({
									accountId: resolvedTarget.accountId,
									vaultId: resolvedTarget.vaultId,
									items,
								});
							} catch (error) {
								assertOperationIsCurrent();
								if (
									!(error instanceof RuntimeRequestError) ||
									error.code !== "SIZE_REJECTED"
								)
									throw error;
								// Only Rust knows the exact encrypted size. A refused batch has no Operation;
								// bisect it so an oversized Item cannot discard its valid siblings.
								if (items.length === 1) {
									refusedItems += 1;
									return;
								}
								const middle = Math.floor(items.length / 2);
								await submit(items.slice(0, middle));
								await submit(items.slice(middle));
								return;
							}
							assertOperationIsCurrent();
							setProgress((current) => ({ ...current, stage: "uploading" }));
							const result = await waitForRuntimeOperation(
								runtimeClient,
								resolvedTarget.accountId,
								accepted.operationId,
								signal,
							);
							assertOperationIsCurrent();
							if (result.importedCount !== items.length)
								throw new VaultImportError("vault-import-failed");
							importedItemsInVault += result.importedCount;
							importedCount += result.importedCount;
							setProgress((current) => ({
								...current,
								processedItems: processedItems + importedItemsInVault,
							}));
						};
						for (
							let index = 0;
							index < drafts.length;
							index += IMPORT_BATCH_SIZE
						) {
							await submit(drafts.slice(index, index + IMPORT_BATCH_SIZE));
						}
						if (refusedItems > 0)
							throw new VaultImportError("vault-import-failed");
					} catch (vaultError) {
						assertOperationIsCurrent();
						const skippedItemsInVault =
							sourceItems.length - importedItemsInVault;
						skippedCount += skippedItemsInVault;
						failedVaults.push({
							sourceVaultId: sourceVault.id,
							sourceVaultName: sourceVault.name,
							itemCount: skippedItemsInVault,
							reason: toImportMessageDescriptor(
								normalizeImportError(vaultError, "vault-import-failed"),
							),
						});
					}
					processedItems += sourceItems.length;

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
				if (
					!operationIsCurrent(operation) ||
					executionError instanceof StaleImportOperation
				) {
					return null;
				}
				const normalizedError = normalizeImportError(
					executionError,
					"execution-failed",
				);
				if (operationIsCurrent(operation)) {
					setError(toImportMessageDescriptor(normalizedError));
				}
				if (operationIsCurrent(operation)) {
					setProgress((current) => ({
						...current,
						stage: "error",
					}));
				}
				throw normalizedError;
			} finally {
				if (operationIsCurrent(operation)) setIsBusy(false);
			}
		}, [
			preview,
			providerId,
			mappings,
			beginAsyncOperation,
			existingVaultById,
			operationIsCurrent,
			runtimeClient,
		]);

	return {
		providerId,
		preview,
		mappings,
		existingVaults,
		progress,
		pendingImport,
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
