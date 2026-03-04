import {
	getImportProvider,
	getImportProviders,
	type ImportMessageParams,
	type ImportProvider,
	type ImportProviderId,
	type ImportWarning,
} from "@bittery/shared";
import {
	Badge,
	Button,
	cn,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	Input,
	Label,
	Progress,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Separator,
	toast,
} from "@bittery/ui";
import {
	IconCircleWarningOutlineDuo18 as AlertCircle,
	IconCircleCheck2OutlineDuo18 as CheckCircle,
	IconLoader2OutlineDuo18 as Loader2,
	IconUpload4OutlineDuo18 as Upload,
} from "@bittery/ui/icons";
import { useNavigate } from "@tanstack/react-router";
import {
	type ChangeEvent,
	type DragEvent,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import {
	type ImportExecutionProgress,
	type ImportExecutionSummary,
	type ImportMessageDescriptor,
	useVaultImport,
	type VaultImportErrorCode,
} from "@/hooks/use-vault-import";
import { useI18n } from "@/providers/i18n-provider";

type ImportDialogStep = "manager" | "upload";
type ImportMessageCatalog = ReturnType<typeof useI18n>["m"];

interface VaultImportDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onImportCompleted?: (summary: ImportExecutionSummary) => void;
}

interface ImportErrorLike {
	code: string;
	params?: ImportMessageParams;
}

function getStringParam(
	params: ImportMessageParams | undefined,
	key: string,
	fallback = "",
): string {
	const value = params?.[key];
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number") {
		return String(value);
	}
	return fallback;
}

function getNumberParam(
	params: ImportMessageParams | undefined,
	key: string,
	fallback = 0,
): number {
	const value = params?.[key];
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return fallback;
}

function isImportErrorLike(value: unknown): value is ImportErrorLike {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as Partial<ImportErrorLike>;
	return typeof candidate.code === "string";
}

function toImportErrorDescriptor(
	error: unknown,
	fallbackCode: VaultImportErrorCode,
): ImportMessageDescriptor {
	if (!isImportErrorLike(error)) {
		return { code: fallbackCode };
	}

	return {
		code: error.code as VaultImportErrorCode,
		...(error.params ? { params: error.params } : {}),
	};
}

function getProviderDescription(
	provider: ImportProvider,
	m: ImportMessageCatalog,
): string {
	switch (provider.id) {
		case "1password-1pux":
			return m["vaults.import.provider.1password_1pux.description"]();
		default:
			return m["vaults.import.provider.generic.description"]();
	}
}

function getProviderImageDescription(
	provider: ImportProvider,
	m: ImportMessageCatalog,
): string {
	switch (provider.id) {
		case "1password-1pux":
			return m["vaults.import.provider.1password_1pux.image_description"]();
		default:
			return m["vaults.import.provider.generic.image_description"]();
	}
}

function getImportProgressMessage(
	progress: ImportExecutionProgress,
	m: ImportMessageCatalog,
): string {
	switch (progress.stage) {
		case "parsing":
			return m["vaults.import.progress.parsing"]();
		case "mapping":
			return progress.currentVaultName
				? m["vaults.import.progress.mapping.named"]({
						vaultName: progress.currentVaultName,
					})
				: m["vaults.import.progress.mapping.default"]();
		case "encrypting":
			return progress.currentVaultName
				? m["vaults.import.progress.encrypting.named"]({
						vaultName: progress.currentVaultName,
					})
				: m["vaults.import.progress.encrypting.default"]();
		case "uploading":
			return progress.currentVaultName
				? m["vaults.import.progress.uploading.named"]({
						vaultName: progress.currentVaultName,
					})
				: m["vaults.import.progress.uploading.default"]();
		case "finalizing":
			return m["vaults.import.progress.finalizing"]();
		case "completed":
			return m["vaults.import.progress.completed"]();
		case "error":
			return m["vaults.import.progress.error"]();
		default:
			return "";
	}
}

function getImportWarningMessage(
	warning: ImportWarning,
	m: ImportMessageCatalog,
): string {
	switch (warning.code) {
		case "item-parse-failed":
			return m["vaults.import.warning.item_parse_failed"]({
				itemNumber: getNumberParam(warning.params, "itemNumber", 0),
				vaultName: getStringParam(warning.params, "vaultName"),
			});
		case "invalid-item":
			return m["vaults.import.warning.invalid_item"]({
				itemNumber: getNumberParam(warning.params, "itemNumber", 0),
				vaultName: getStringParam(warning.params, "vaultName"),
			});
		case "archived-skipped":
			return m["vaults.import.warning.archived_skipped"]({
				title: getStringParam(warning.params, "title"),
			});
		case "missing-title":
			return m["vaults.import.warning.missing_title"]({
				itemNumber: getNumberParam(warning.params, "itemNumber", 0),
				vaultName: getStringParam(warning.params, "vaultName"),
				title: getStringParam(warning.params, "title"),
			});
		case "documents-skipped":
			return m["vaults.import.warning.documents_skipped"]({
				title: getStringParam(warning.params, "title"),
			});
		case "attachments-skipped":
			return m["vaults.import.warning.attachments_skipped"]({
				title: getStringParam(warning.params, "title"),
			});
		case "category-fallback": {
			const sourceCategory = getStringParam(warning.params, "sourceCategory");
			return m["vaults.import.warning.category_fallback"]({
				title: getStringParam(warning.params, "title"),
				sourceCategory:
					sourceCategory ||
					m["vaults.import.warning.fallback.unknown_source_category"](),
			});
		}
		case "totp-secret-missing":
			return m["vaults.import.warning.totp_secret_missing"]({
				title: getStringParam(warning.params, "title"),
			});
		default:
			return m["vaults.import.warning.unknown"]();
	}
}

function getImportErrorMessage(
	error: ImportMessageDescriptor,
	m: ImportMessageCatalog,
): string {
	switch (error.code) {
		case "provider-unavailable":
			return m["vaults.import.error.provider_unavailable"]();
		case "file-incompatible":
			return m["vaults.import.error.file_incompatible"]({
				providerTitle: getStringParam(error.params, "providerTitle"),
			});
		case "no-importable-items":
			return m["vaults.import.error.no_importable_items"]();
		case "import-not-ready":
			return m["vaults.import.error.import_not_ready"]();
		case "mapping-missing":
			return m["vaults.import.error.mapping_missing"]({
				sourceVaultName: getStringParam(error.params, "sourceVaultName"),
			});
		case "target-vault-required":
			return m["vaults.import.error.target_vault_required"]({
				sourceVaultName: getStringParam(error.params, "sourceVaultName"),
			});
		case "target-vault-name-required":
			return m["vaults.import.error.target_vault_name_required"]({
				sourceVaultName: getStringParam(error.params, "sourceVaultName"),
			});
		case "target-vault-missing":
			return m["vaults.import.error.target_vault_missing"]({
				sourceVaultName: getStringParam(error.params, "sourceVaultName"),
			});
		case "target-vault-read-only":
			return m["vaults.import.error.target_vault_read_only"]({
				targetVaultName: getStringParam(error.params, "targetVaultName"),
			});
		case "missing-target-mapping":
			return m["vaults.import.error.missing_target_mapping"]();
		case "target-vault-key-decrypt-failed":
			return m["vaults.import.error.target_vault_key_decrypt_failed"]({
				targetVaultName: getStringParam(error.params, "targetVaultName"),
			});
		case "vault-import-failed":
			return m["vaults.import.error.vault_import_failed"]();
		case "parse-failed":
			return m["vaults.import.error.parse_failed"]();
		case "execution-failed":
			return m["vaults.import.error.execution_failed"]();
		case "unsupported-file-type":
			return m["vaults.import.error.unsupported_file_type"]();
		case "archive-read-failed":
			return m["vaults.import.error.archive_read_failed"]();
		case "missing-export-data":
			return m["vaults.import.error.missing_export_data"]();
		case "read-export-data-failed":
			return m["vaults.import.error.read_export_data_failed"]();
		case "invalid-export-data-json":
			return m["vaults.import.error.invalid_export_data_json"]();
		case "no-vaults-found":
			return m["vaults.import.error.no_vaults_found"]();
		case "unsupported-item-provider":
			return m["vaults.import.error.unsupported_item_provider"]({
				providerId: getStringParam(error.params, "providerId"),
			});
		default:
			return m["vaults.import.error.execution_failed"]();
	}
}

function ImportProviderLogo({
	provider,
	title,
}: {
	provider: ImportProvider;
	title: string;
}) {
	const shortLabel = provider.title
		.replace(/[^a-z0-9]/gi, "")
		.slice(0, 2)
		.toUpperCase();
	const accent = provider.accentColor || "#64748B";

	return (
		<div
			className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border/40 font-semibold text-xs"
			style={{
				background: `linear-gradient(135deg, ${accent}2A 0%, ${accent}14 100%)`,
				color: accent,
			}}
			title={title}
		>
			{shortLabel || "PM"}
		</div>
	);
}

export function VaultImportDialog({
	open,
	onOpenChange,
	onImportCompleted,
}: VaultImportDialogProps) {
	const navigate = useNavigate();
	const { m } = useI18n();
	const importProviders = useMemo(() => getImportProviders(), []);
	const [selectedFileName, setSelectedFileName] = useState("");
	const [dialogStep, setDialogStep] = useState<ImportDialogStep>("manager");
	const [selectedProviderId, setSelectedProviderId] =
		useState<ImportProviderId | null>(null);
	const [isDropzoneActive, setIsDropzoneActive] = useState(false);
	const {
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
	} = useVaultImport();

	useEffect(() => {
		if (!open) {
			setSelectedFileName("");
			setDialogStep("manager");
			setSelectedProviderId(null);
			reset();
		}
	}, [open, reset]);

	const progressPercent = useMemo(() => {
		if (progress.totalItems === 0) {
			return 0;
		}
		return Math.min(
			100,
			Math.round((progress.processedItems / progress.totalItems) * 100),
		);
	}, [progress.totalItems, progress.processedItems]);

	const selectedProvider = useMemo(
		() =>
			importProviders.find((provider) => provider.id === selectedProviderId) ??
			null,
		[importProviders, selectedProviderId],
	);

	const activeProvider = useMemo(
		() =>
			preview?.providerId
				? getImportProvider(preview.providerId)
				: selectedProvider,
		[preview?.providerId, selectedProvider],
	);

	const canStartImport = useMemo(() => {
		if (!preview || isBusy) {
			return false;
		}

		return preview.sourceVaults.every((sourceVault) => {
			const mapping = mappings[sourceVault.id];
			if (!mapping) {
				return false;
			}
			if (mapping.mode === "create") {
				return mapping.targetVaultName.trim().length > 0;
			}
			return !!mapping.targetVaultId;
		});
	}, [preview, mappings, isBusy]);

	const displayError = useMemo(() => {
		if (!error) {
			return null;
		}
		return getImportErrorMessage(error, m);
	}, [error, m]);

	const handleSelectedFile = useCallback(
		async (file: File) => {
			if (!selectedProviderId) {
				toast.error(m["vaults.import.toast.select_provider_before_upload"]());
				return;
			}

			setSelectedFileName(file.name);

			try {
				await parseFile(file, selectedProviderId);
			} catch (parseError) {
				const descriptor = toImportErrorDescriptor(parseError, "parse-failed");
				toast.error(getImportErrorMessage(descriptor, m));
			}
		},
		[m, parseFile, selectedProviderId],
	);

	const handleFileChange = useCallback(
		async (event: ChangeEvent<HTMLInputElement>) => {
			const file = event.currentTarget.files?.[0];
			event.currentTarget.value = "";
			if (!file) {
				return;
			}
			await handleSelectedFile(file);
		},
		[handleSelectedFile],
	);

	const handleDropzoneDragOver = useCallback(
		(event: DragEvent<HTMLLabelElement>) => {
			if (isBusy || !selectedProvider) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			setIsDropzoneActive(true);
		},
		[isBusy, selectedProvider],
	);

	const handleDropzoneDragLeave = useCallback(
		(event: DragEvent<HTMLLabelElement>) => {
			event.preventDefault();
			event.stopPropagation();
			setIsDropzoneActive(false);
		},
		[],
	);

	const handleDropzoneDrop = useCallback(
		async (event: DragEvent<HTMLLabelElement>) => {
			event.preventDefault();
			event.stopPropagation();
			setIsDropzoneActive(false);

			if (isBusy || !selectedProvider) {
				return;
			}

			const file = event.dataTransfer.files?.[0];
			if (!file) {
				return;
			}

			await handleSelectedFile(file);
		},
		[handleSelectedFile, isBusy, selectedProvider],
	);

	const handleStartImport = useCallback(async () => {
		try {
			const result = await executeImport();
			onImportCompleted?.(result);

			if (result.failedVaultCount > 0) {
				toast.warning(
					result.failedVaultCount === 1
						? m["vaults.import.toast.completed_with_vault_issues.single"]({
								count: result.failedVaultCount,
							})
						: m["vaults.import.toast.completed_with_vault_issues.plural"]({
								count: result.failedVaultCount,
							}),
				);
				return;
			}

			toast.success(m["vaults.import.toast.completed_successfully"]());
		} catch (executionError) {
			const descriptor = toImportErrorDescriptor(
				executionError,
				"execution-failed",
			);
			toast.error(getImportErrorMessage(descriptor, m));
		}
	}, [executeImport, m, onImportCompleted]);

	const handleDialogOpenChange = useCallback(
		(nextOpen: boolean) => {
			if (!nextOpen && isBusy) {
				return;
			}
			onOpenChange(nextOpen);
		},
		[isBusy, onOpenChange],
	);

	const handleContinueToUpload = useCallback(() => {
		if (!selectedProviderId) {
			toast.error(m["vaults.import.toast.select_provider_to_continue"]());
			return;
		}
		setDialogStep("upload");
	}, [m, selectedProviderId]);

	const handleChooseAnotherFile = useCallback(() => {
		if (isBusy) {
			return;
		}
		reset();
		setSelectedFileName("");
		setDialogStep("upload");
	}, [isBusy, reset]);

	const showSummaryStep = !!summary;
	const showPreviewStep = !!preview && !summary;
	const showManagerStep = !preview && !summary && dialogStep === "manager";
	const showUploadStep = !preview && !summary && dialogStep === "upload";

	const currentStep = showSummaryStep
		? 3
		: showPreviewStep
			? 3
			: showUploadStep
				? 2
				: 1;

	const stepItems = [
		{
			label: m["vaults.import.step.select_provider"](),
			step: 1,
		},
		{
			label: m["vaults.import.step.upload_file"](),
			step: 2,
		},
		{
			label: m["vaults.import.step.map_import"](),
			step: 3,
		},
	];

	return (
		<Dialog open={open} onOpenChange={handleDialogOpenChange}>
			<DialogContent className="flex max-h-[92vh] max-w-[calc(100%-1rem)] flex-col overflow-hidden p-0 sm:max-w-4xl">
				<DialogHeader className="space-y-4 border-b px-6 py-5">
					<div className="space-y-1">
						<DialogTitle>{m["vaults.import.dialog.title"]()}</DialogTitle>
						<DialogDescription>
							{m["vaults.import.dialog.description"]()}
						</DialogDescription>
					</div>
					{!showSummaryStep && (
						<div className="grid gap-2 sm:grid-cols-3">
							{stepItems.map((stepItem) => {
								const isActive = currentStep === stepItem.step;
								const isDone = currentStep > stepItem.step;
								return (
									<div
										key={stepItem.step}
										className={cn(
											"flex",
											"items-center",
											"rounded-lg",
											"border",
											"px-3",
											"py-2",
											isDone
												? "border-primary/35 bg-primary/5"
												: isActive
													? "border-foreground/20 bg-muted/40"
													: "bg-background",
										)}
									>
										<div className="flex items-center gap-2">
											{isDone ? (
												<CheckCircle className="h-4 w-4 text-primary" />
											) : (
												<span
													className={cn(
														"inline-flex",
														"h-5",
														"w-5",
														"items-center",
														"justify-center",
														"rounded-full",
														"border",
														"font-medium",
														"text-[11px]",
														isActive
															? "border-primary/50 text-primary"
															: "border-border text-muted-foreground",
													)}
												>
													{stepItem.step}
												</span>
											)}
											<span
												className={cn(
													"font-medium",
													"text-xs",
													isActive
														? "text-foreground"
														: "text-muted-foreground",
												)}
											>
												{stepItem.label}
											</span>
										</div>
									</div>
								);
							})}
						</div>
					)}
				</DialogHeader>

				<div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
					{showManagerStep && (
						<div className="space-y-4">
							<div className="rounded-xl border bg-muted/20 p-4">
								<h3 className="font-medium text-sm">
									{m["vaults.import.manager.title"]()}
								</h3>
								<p className="text-muted-foreground text-sm">
									{m["vaults.import.manager.description"]()}
								</p>
							</div>

							{importProviders.length === 0 ? (
								<div className="rounded-xl border border-dashed p-4 text-muted-foreground text-sm">
									{m["vaults.import.manager.empty_providers"]()}
								</div>
							) : (
								<div className="grid gap-3 sm:grid-cols-2">
									{importProviders.map((provider) => {
										const isSelected = selectedProviderId === provider.id;
										return (
											<button
												key={provider.id}
												type="button"
												onClick={() => {
													setSelectedProviderId(provider.id);
													setSelectedFileName("");
													reset();
												}}
												className={cn(
													"flex",
													"w-full",
													"items-center",
													"gap-3",
													"rounded-xl",
													"border",
													"px-4",
													"py-3",
													"text-left",
													"transition",
													isSelected
														? "border-primary/45 bg-primary/5"
														: "border-border bg-card hover:border-foreground/30 hover:bg-accent/30",
												)}
												aria-pressed={isSelected}
											>
												<ImportProviderLogo
													provider={provider}
													title={getProviderImageDescription(provider, m)}
												/>
												<div className="flex-1 space-y-0.5">
													<p className="font-medium text-sm">
														{provider.title}
													</p>
													<p className="text-muted-foreground text-xs">
														{getProviderDescription(provider, m)}
													</p>
												</div>
												<Badge variant={isSelected ? "default" : "secondary"}>
													{isSelected
														? m[
																"vaults.import.manager.provider_card.selected"
															]()
														: m["vaults.import.manager.provider_card.select"]()}
												</Badge>
											</button>
										);
									})}
								</div>
							)}
						</div>
					)}

					{showUploadStep && (
						<div className="space-y-4">
							<div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/20 p-4">
								<div className="space-y-1">
									<p className="text-muted-foreground text-xs uppercase tracking-[0.1em]">
										{m["vaults.import.upload.selected_provider.label"]()}
									</p>
									<p className="font-medium text-sm">
										{selectedProvider?.title ??
											m["vaults.import.upload.selected_provider.fallback"]()}
									</p>
								</div>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => setDialogStep("manager")}
									disabled={isBusy}
								>
									{m["vaults.import.upload.change_provider"]()}
								</Button>
							</div>

							<div className="space-y-4 rounded-xl border border-dashed p-5">
								<div className="space-y-1">
									<Label htmlFor="vault-import-file">
										{m["vaults.import.upload.file_label"]()}
									</Label>
									<p className="text-muted-foreground text-sm">
										{m["vaults.import.upload.file_description"]({
											providerTitle:
												selectedProvider?.title ??
												m[
													"vaults.import.upload.file_description.fallback_provider"
												](),
										})}
									</p>
									<p className="text-muted-foreground text-xs">
										{m["vaults.import.upload.accepted_formats"]({
											format:
												selectedProvider?.fileTypeLabel ??
												m["vaults.import.upload.accepted_formats.fallback"](),
										})}
									</p>
								</div>

								<label
									htmlFor="vault-import-file"
									className={cn(
										"block",
										"space-y-3",
										"rounded-lg",
										"border",
										"border-dashed",
										"p-4",
										"transition",
										isDropzoneActive
											? "border-primary/45 bg-primary/5"
											: "border-border bg-background/40",
										isBusy || !selectedProvider
											? "cursor-not-allowed opacity-70"
											: "cursor-pointer",
									)}
									onDragOver={handleDropzoneDragOver}
									onDragLeave={handleDropzoneDragLeave}
									onDrop={handleDropzoneDrop}
								>
									<div className="text-muted-foreground text-sm">
										{m["vaults.import.upload.dropzone_hint"]()}
									</div>

									<div className="flex flex-wrap items-center gap-2">
										<span className="inline-flex items-center rounded-md border border-input bg-background px-3 py-1.5 text-sm shadow-xs">
											<Upload className="mr-2 h-4 w-4" />
											{selectedFileName ||
												m["vaults.import.upload.choose_file"]()}
										</span>

										{selectedFileName && (
											<Badge
												variant="secondary"
												className="max-w-full truncate"
											>
												{selectedFileName}
											</Badge>
										)}
									</div>
								</label>

								<input
									id="vault-import-file"
									type="file"
									accept={selectedProvider?.fileAccept}
									className="hidden"
									onChange={handleFileChange}
									disabled={isBusy || !selectedProvider}
								/>
							</div>
						</div>
					)}

					{showPreviewStep && (
						<div className="space-y-5">
							<div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/20 p-4">
								<div>
									<p className="font-medium text-sm">
										{m["vaults.import.preview.ready.title"]()}
									</p>
									<p className="text-muted-foreground text-xs">
										{m["vaults.import.preview.ready.description"]()}
									</p>
								</div>
								<div className="flex items-center gap-2">
									{activeProvider && (
										<Badge variant="secondary">{activeProvider.title}</Badge>
									)}
									<Button
										type="button"
										variant="ghost"
										size="sm"
										onClick={handleChooseAnotherFile}
										disabled={isBusy}
									>
										{m["vaults.import.preview.choose_another_file"]()}
									</Button>
								</div>
							</div>

							<div className="grid gap-2 sm:grid-cols-4">
								<div className="rounded-lg border bg-card p-3">
									<div className="text-muted-foreground text-xs">
										{m["vaults.import.preview.stat.vaults"]()}
									</div>
									<div className="font-semibold text-lg">
										{preview.summary.vaultCount}
									</div>
								</div>
								<div className="rounded-lg border bg-card p-3">
									<div className="text-muted-foreground text-xs">
										{m["vaults.import.preview.stat.items"]()}
									</div>
									<div className="font-semibold text-lg">
										{preview.summary.itemCount}
									</div>
								</div>
								<div className="rounded-lg border bg-card p-3">
									<div className="text-muted-foreground text-xs">
										{m["vaults.import.preview.stat.skipped"]()}
									</div>
									<div className="font-semibold text-lg">
										{preview.summary.skippedCount}
									</div>
								</div>
								<div className="rounded-lg border bg-card p-3">
									<div className="text-muted-foreground text-xs">
										{m["vaults.import.preview.stat.warnings"]()}
									</div>
									<div className="font-semibold text-lg">
										{preview.summary.warningCount}
									</div>
								</div>
							</div>

							{preview.warnings.length > 0 && (
								<div className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
									<div className="flex items-center gap-2 text-amber-700 text-sm dark:text-amber-300">
										<AlertCircle className="h-4 w-4" />
										<span className="font-medium">
											{m["vaults.import.preview.warnings.title"]({
												count: preview.warnings.length,
											})}
										</span>
									</div>
									<div className="max-h-32 space-y-1 overflow-y-auto pr-1">
										{preview.warnings.slice(0, 8).map((warning, index) => (
											<p
												key={`${warning.code}-${warning.sourceItemId ?? warning.sourceVaultId ?? index}`}
												className="text-muted-foreground text-xs"
											>
												{getImportWarningMessage(warning, m)}
											</p>
										))}
									</div>
								</div>
							)}

							<div className="space-y-3 rounded-xl border p-4">
								<div>
									<h3 className="font-medium text-sm">
										{m["vaults.import.mapping.title"]()}
									</h3>
									<p className="text-muted-foreground text-sm">
										{m["vaults.import.mapping.description"]()}
									</p>
									{skippedEmptyVaultCount > 0 && (
										<p className="mt-1 text-muted-foreground text-xs">
											{skippedEmptyVaultCount === 1
												? m[
														"vaults.import.mapping.skipped_empty_vaults.single"
													]({ count: skippedEmptyVaultCount })
												: m[
														"vaults.import.mapping.skipped_empty_vaults.plural"
													]({ count: skippedEmptyVaultCount })}
										</p>
									)}
								</div>
								<div className="space-y-3">
									{preview.sourceVaults.map((sourceVault) => {
										const mapping = mappings[sourceVault.id];
										if (!mapping) {
											return null;
										}

										const selectedVault = mapping.targetVaultId
											? existingVaults.find(
													(vault) => vault.vaultId === mapping.targetVaultId,
												)
											: null;

										return (
											<div
												key={sourceVault.id}
												className="space-y-2 rounded-lg border bg-muted/15 p-3"
											>
												<div className="flex flex-wrap items-center justify-between gap-2">
													<div>
														<p className="font-medium text-sm">
															{sourceVault.name}
														</p>
														<p className="text-muted-foreground text-xs">
															{sourceVault.itemCount === 1
																? m[
																		"vaults.import.mapping.source_item_count.single"
																	]({
																		count: sourceVault.itemCount,
																	})
																: m[
																		"vaults.import.mapping.source_item_count.plural"
																	]({
																		count: sourceVault.itemCount,
																	})}
														</p>
													</div>
													<Badge variant="secondary">
														{m["vaults.import.mapping.badge.source"]()}
													</Badge>
												</div>

												<div className="grid gap-2 sm:grid-cols-[170px_1fr]">
													<Select
														value={mapping.mode}
														onValueChange={(value: "create" | "existing") =>
															setMappingMode(sourceVault.id, value)
														}
														disabled={isBusy}
													>
														<SelectTrigger>
															<SelectValue />
														</SelectTrigger>
														<SelectContent>
															<SelectItem value="create">
																{m["vaults.import.mapping.mode.create"]()}
															</SelectItem>
															<SelectItem value="existing">
																{m["vaults.import.mapping.mode.existing"]()}
															</SelectItem>
														</SelectContent>
													</Select>

													{mapping.mode === "create" ? (
														<Input
															value={mapping.targetVaultName}
															onChange={(event) =>
																setMappingTargetVaultName(
																	sourceVault.id,
																	event.currentTarget.value,
																)
															}
															placeholder={m[
																"vaults.import.mapping.placeholder.new_vault_name"
															]()}
															disabled={isBusy}
														/>
													) : (
														<Select
															value={mapping.targetVaultId ?? ""}
															onValueChange={(value) =>
																setMappingTargetVaultId(sourceVault.id, value)
															}
															disabled={isBusy}
														>
															<SelectTrigger>
																<SelectValue
																	placeholder={m[
																		"vaults.import.mapping.placeholder.select_vault"
																	]()}
																/>
															</SelectTrigger>
															<SelectContent>
																{existingVaults.length === 0 ? (
																	<SelectItem value="__none" disabled>
																		{m[
																			"vaults.import.mapping.empty.no_existing_vaults"
																		]()}
																	</SelectItem>
																) : (
																	existingVaults.map((vault) => (
																		<SelectItem
																			key={vault.vaultId}
																			value={vault.vaultId}
																			disabled={vault.role === "read-only"}
																		>
																			{vault.role === "read-only"
																				? m[
																						"vaults.import.mapping.target_vault.read_only"
																					]({ vaultName: vault.vaultName })
																				: vault.vaultName}
																		</SelectItem>
																	))
																)}
															</SelectContent>
														</Select>
													)}
												</div>

												{selectedVault?.role === "read-only" && (
													<p className="text-amber-700 text-xs dark:text-amber-300">
														{m["vaults.import.mapping.read_only_notice"]()}
													</p>
												)}
											</div>
										);
									})}
								</div>
							</div>

							{(progress.stage === "encrypting" ||
								progress.stage === "uploading" ||
								progress.stage === "finalizing") && (
								<div className="space-y-2 rounded-xl border bg-muted/20 p-4">
									<div className="flex items-center justify-between text-sm">
										<div className="inline-flex items-center gap-2">
											<Loader2 className="h-4 w-4 animate-spin" />
											<span>{getImportProgressMessage(progress, m)}</span>
										</div>
										<span className="text-muted-foreground">
											{progress.processedItems}/{progress.totalItems}
										</span>
									</div>
									<Progress value={progressPercent} className="h-2" />
								</div>
							)}
						</div>
					)}

					{showSummaryStep && summary && (
						<div className="space-y-4 rounded-xl border p-4">
							<div className="flex items-center gap-3">
								<div className="rounded-full bg-emerald-500/10 p-1.5">
									<CheckCircle className="h-5 w-5 text-emerald-500" />
								</div>
								<div>
									<h3 className="font-medium">
										{m["vaults.import.summary.title"]()}
									</h3>
									<p className="text-muted-foreground text-sm">
										{m["vaults.import.summary.description"]()}
									</p>
								</div>
							</div>

							<div className="grid gap-2 sm:grid-cols-4">
								<div className="rounded-lg border p-3">
									<div className="text-muted-foreground text-xs">
										{m["vaults.import.summary.stat.imported"]()}
									</div>
									<div className="font-semibold text-lg">
										{summary.importedCount}
									</div>
								</div>
								<div className="rounded-lg border p-3">
									<div className="text-muted-foreground text-xs">
										{m["vaults.import.summary.stat.skipped"]()}
									</div>
									<div className="font-semibold text-lg">
										{summary.skippedCount}
									</div>
								</div>
								<div className="rounded-lg border p-3">
									<div className="text-muted-foreground text-xs">
										{m["vaults.import.summary.stat.warnings"]()}
									</div>
									<div className="font-semibold text-lg">
										{summary.warningCount}
									</div>
								</div>
								<div className="rounded-lg border p-3">
									<div className="text-muted-foreground text-xs">
										{m["vaults.import.summary.stat.new_vaults"]()}
									</div>
									<div className="font-semibold text-lg">
										{summary.createdVaultCount}
									</div>
								</div>
							</div>

							{summary.failedVaultCount > 0 && (
								<div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
									<p className="font-medium text-amber-700 text-sm dark:text-amber-300">
										{m["vaults.import.summary.failed_vaults.title"]()}
									</p>
									<div className="space-y-1">
										{summary.failedVaults.map((failedVault, index) => (
											<p
												key={`${failedVault.sourceVaultId}-${failedVault.reason.code}-${index}`}
												className="text-muted-foreground text-xs"
											>
												{failedVault.sourceVaultName}:{" "}
												{getImportErrorMessage(failedVault.reason, m)}
											</p>
										))}
									</div>
								</div>
							)}

							<Separator />

							<div className="flex flex-wrap gap-2">
								<Button
									type="button"
									onClick={() => {
										onOpenChange(false);
										navigate({ to: "/vaults" });
									}}
								>
									{m["vaults.import.summary.action.open_vaults"]()}
								</Button>
								<Button
									type="button"
									variant="outline"
									onClick={() => onOpenChange(false)}
								>
									{m["vaults.import.summary.action.close"]()}
								</Button>
							</div>
						</div>
					)}

					{displayError && !showSummaryStep && (
						<div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-destructive text-sm">
							{displayError}
						</div>
					)}
				</div>

				{!showSummaryStep && (
					<div className="flex flex-col-reverse gap-2 border-t px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
						<div>
							{showUploadStep && (
								<Button
									type="button"
									variant="ghost"
									onClick={() => setDialogStep("manager")}
									disabled={isBusy}
								>
									{m["vaults.import.action.back"]()}
								</Button>
							)}
						</div>

						<div className="flex flex-col-reverse gap-2 sm:flex-row">
							<Button
								type="button"
								variant="outline"
								onClick={() => handleDialogOpenChange(false)}
								disabled={isBusy}
							>
								{m["vaults.import.action.cancel"]()}
							</Button>

							{showManagerStep && (
								<Button
									type="button"
									onClick={handleContinueToUpload}
									disabled={
										!selectedProviderId ||
										isBusy ||
										importProviders.length === 0
									}
								>
									{m["vaults.import.action.continue"]()}
								</Button>
							)}

							{showPreviewStep && (
								<Button
									type="button"
									onClick={handleStartImport}
									disabled={!canStartImport || isBusy}
								>
									{isBusy ? (
										<>
											<Loader2 className="mr-2 h-4 w-4 animate-spin" />
											{m["vaults.import.action.importing"]()}
										</>
									) : (
										m["vaults.import.action.start_import"]()
									)}
								</Button>
							)}
						</div>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
