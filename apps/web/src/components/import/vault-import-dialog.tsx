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
			return m.vaults_import_provider_1password_1pux_description();
		default:
			return m.vaults_import_provider_generic_description();
	}
}

function getProviderImageDescription(
	provider: ImportProvider,
	m: ImportMessageCatalog,
): string {
	switch (provider.id) {
		case "1password-1pux":
			return m.vaults_import_provider_1password_1pux_image_description();
		default:
			return m.vaults_import_provider_generic_image_description();
	}
}

function getImportProgressMessage(
	progress: ImportExecutionProgress,
	m: ImportMessageCatalog,
): string {
	switch (progress.stage) {
		case "parsing":
			return m.vaults_import_progress_parsing();
		case "mapping":
			return progress.currentVaultName
				? m.vaults_import_progress_mapping_named({
						vaultName: progress.currentVaultName,
					})
				: m.vaults_import_progress_mapping_default();
		case "encrypting":
			return progress.currentVaultName
				? m.vaults_import_progress_encrypting_named({
						vaultName: progress.currentVaultName,
					})
				: m.vaults_import_progress_encrypting_default();
		case "uploading":
			return progress.currentVaultName
				? m.vaults_import_progress_uploading_named({
						vaultName: progress.currentVaultName,
					})
				: m.vaults_import_progress_uploading_default();
		case "finalizing":
			return m.vaults_import_progress_finalizing();
		case "completed":
			return m.vaults_import_progress_completed();
		case "error":
			return m.vaults_import_progress_error();
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
			return m.vaults_import_warning_item_parse_failed({
				itemNumber: getNumberParam(warning.params, "itemNumber", 0),
				vaultName: getStringParam(warning.params, "vaultName"),
			});
		case "invalid-item":
			return m.vaults_import_warning_invalid_item({
				itemNumber: getNumberParam(warning.params, "itemNumber", 0),
				vaultName: getStringParam(warning.params, "vaultName"),
			});
		case "archived-skipped":
			return m.vaults_import_warning_archived_skipped({
				title: getStringParam(warning.params, "title"),
			});
		case "missing-title":
			return m.vaults_import_warning_missing_title({
				itemNumber: getNumberParam(warning.params, "itemNumber", 0),
				vaultName: getStringParam(warning.params, "vaultName"),
				title: getStringParam(warning.params, "title"),
			});
		case "documents-skipped":
			return m.vaults_import_warning_documents_skipped({
				title: getStringParam(warning.params, "title"),
			});
		case "attachments-skipped":
			return m.vaults_import_warning_attachments_skipped({
				title: getStringParam(warning.params, "title"),
			});
		case "category-fallback": {
			const sourceCategory = getStringParam(warning.params, "sourceCategory");
			return m.vaults_import_warning_category_fallback({
				title: getStringParam(warning.params, "title"),
				sourceCategory:
					sourceCategory ||
					m.vaults_import_warning_fallback_unknown_source_category(),
			});
		}
		case "totp-secret-missing":
			return m.vaults_import_warning_totp_secret_missing({
				title: getStringParam(warning.params, "title"),
			});
		default:
			return m.vaults_import_warning_unknown();
	}
}

function getImportErrorMessage(
	error: ImportMessageDescriptor,
	m: ImportMessageCatalog,
): string {
	switch (error.code) {
		case "provider-unavailable":
			return m.vaults_import_error_provider_unavailable();
		case "file-incompatible":
			return m.vaults_import_error_file_incompatible({
				providerTitle: getStringParam(error.params, "providerTitle"),
			});
		case "no-importable-items":
			return m.vaults_import_error_no_importable_items();
		case "import-not-ready":
			return m.vaults_import_error_import_not_ready();
		case "mapping-missing":
			return m.vaults_import_error_mapping_missing({
				sourceVaultName: getStringParam(error.params, "sourceVaultName"),
			});
		case "target-vault-required":
			return m.vaults_import_error_target_vault_required({
				sourceVaultName: getStringParam(error.params, "sourceVaultName"),
			});
		case "target-vault-name-required":
			return m.vaults_import_error_target_vault_name_required({
				sourceVaultName: getStringParam(error.params, "sourceVaultName"),
			});
		case "target-vault-missing":
			return m.vaults_import_error_target_vault_missing({
				sourceVaultName: getStringParam(error.params, "sourceVaultName"),
			});
		case "target-vault-read-only":
			return m.vaults_import_error_target_vault_read_only({
				targetVaultName: getStringParam(error.params, "targetVaultName"),
			});
		case "missing-target-mapping":
			return m.vaults_import_error_missing_target_mapping();
		case "target-vault-key-decrypt-failed":
			return m.vaults_import_error_target_vault_key_decrypt_failed({
				targetVaultName: getStringParam(error.params, "targetVaultName"),
			});
		case "vault-import-failed":
			return m.vaults_import_error_vault_import_failed();
		case "parse-failed":
			return m.vaults_import_error_parse_failed();
		case "execution-failed":
			return m.vaults_import_error_execution_failed();
		case "create-vault-account-required":
			return m.vaults_import_error_create_vault_account_required();
		case "unsupported-file-type":
			return m.vaults_import_error_unsupported_file_type();
		case "archive-read-failed":
			return m.vaults_import_error_archive_read_failed();
		case "missing-export-data":
			return m.vaults_import_error_missing_export_data();
		case "read-export-data-failed":
			return m.vaults_import_error_read_export_data_failed();
		case "invalid-export-data-json":
			return m.vaults_import_error_invalid_export_data_json();
		case "no-vaults-found":
			return m.vaults_import_error_no_vaults_found();
		case "unsupported-item-provider":
			return m.vaults_import_error_unsupported_item_provider({
				providerId: getStringParam(error.params, "providerId"),
			});
		default:
			return m.vaults_import_error_execution_failed();
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
	const resetDialogState = useCallback(() => {
		setSelectedFileName("");
		setDialogStep("manager");
		setSelectedProviderId(null);
		reset();
	}, [reset]);

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
				toast.error(m.vaults_import_toast_select_provider_before_upload());
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
						? m.vaults_import_toast_completed_with_vault_issues_single({
								count: result.failedVaultCount,
							})
						: m.vaults_import_toast_completed_with_vault_issues_plural({
								count: result.failedVaultCount,
							}),
				);
				return;
			}

			toast.success(m.vaults_import_toast_completed_successfully());
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
			if (!nextOpen) {
				resetDialogState();
			}
			onOpenChange(nextOpen);
		},
		[isBusy, onOpenChange, resetDialogState],
	);

	const handleContinueToUpload = useCallback(() => {
		if (!selectedProviderId) {
			toast.error(m.vaults_import_toast_select_provider_to_continue());
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
			label: m.vaults_import_step_select_provider(),
			step: 1,
		},
		{
			label: m.vaults_import_step_upload_file(),
			step: 2,
		},
		{
			label: m.vaults_import_step_map_import(),
			step: 3,
		},
	];

	return (
		<Dialog open={open} onOpenChange={handleDialogOpenChange}>
			<DialogContent className="flex max-h-[92vh] max-w-[calc(100%-1rem)] flex-col overflow-hidden p-0 sm:max-w-4xl">
				<DialogHeader className="space-y-4 border-b px-6 py-5">
					<div className="space-y-1">
						<DialogTitle>{m.vaults_import_dialog_title()}</DialogTitle>
						<DialogDescription>
							{m.vaults_import_dialog_description()}
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
									{m.vaults_import_manager_title()}
								</h3>
								<p className="text-muted-foreground text-sm">
									{m.vaults_import_manager_description()}
								</p>
							</div>

							{importProviders.length === 0 ? (
								<div className="rounded-xl border border-dashed p-4 text-muted-foreground text-sm">
									{m.vaults_import_manager_empty_providers()}
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
														? m.vaults_import_manager_provider_card_selected()
														: m.vaults_import_manager_provider_card_select()}
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
										{m.vaults_import_upload_selected_provider_label()}
									</p>
									<p className="font-medium text-sm">
										{selectedProvider?.title ??
											m.vaults_import_upload_selected_provider_fallback()}
									</p>
								</div>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => setDialogStep("manager")}
									disabled={isBusy}
								>
									{m.vaults_import_upload_change_provider()}
								</Button>
							</div>

							<div className="space-y-4 rounded-xl border border-dashed p-5">
								<div className="space-y-1">
									<Label htmlFor="vault-import-file">
										{m.vaults_import_upload_file_label()}
									</Label>
									<p className="text-muted-foreground text-sm">
										{m.vaults_import_upload_file_description({
											providerTitle:
												selectedProvider?.title ??
												m.vaults_import_upload_file_description_fallback_provider(),
										})}
									</p>
									<p className="text-muted-foreground text-xs">
										{m.vaults_import_upload_accepted_formats({
											format:
												selectedProvider?.fileTypeLabel ??
												m.vaults_import_upload_accepted_formats_fallback(),
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
										{m.vaults_import_upload_dropzone_hint()}
									</div>

									<div className="flex flex-wrap items-center gap-2">
										<span className="inline-flex items-center rounded-md border border-input bg-background px-3 py-1.5 text-sm shadow-xs">
											<Upload className="mr-2 h-4 w-4" />
											{selectedFileName || m.vaults_import_upload_choose_file()}
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
										{m.vaults_import_preview_ready_title()}
									</p>
									<p className="text-muted-foreground text-xs">
										{m.vaults_import_preview_ready_description()}
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
										{m.vaults_import_preview_choose_another_file()}
									</Button>
								</div>
							</div>

							<div className="grid gap-2 sm:grid-cols-4">
								<div className="rounded-lg border bg-card p-3">
									<div className="text-muted-foreground text-xs">
										{m.vaults_import_preview_stat_vaults()}
									</div>
									<div className="font-semibold text-lg">
										{preview.summary.vaultCount}
									</div>
								</div>
								<div className="rounded-lg border bg-card p-3">
									<div className="text-muted-foreground text-xs">
										{m.vaults_import_preview_stat_items()}
									</div>
									<div className="font-semibold text-lg">
										{preview.summary.itemCount}
									</div>
								</div>
								<div className="rounded-lg border bg-card p-3">
									<div className="text-muted-foreground text-xs">
										{m.vaults_import_preview_stat_skipped()}
									</div>
									<div className="font-semibold text-lg">
										{preview.summary.skippedCount}
									</div>
								</div>
								<div className="rounded-lg border bg-card p-3">
									<div className="text-muted-foreground text-xs">
										{m.vaults_import_preview_stat_warnings()}
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
											{m.vaults_import_preview_warnings_title({
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
										{m.vaults_import_mapping_title()}
									</h3>
									<p className="text-muted-foreground text-sm">
										{m.vaults_import_mapping_description()}
									</p>
									{skippedEmptyVaultCount > 0 && (
										<p className="mt-1 text-muted-foreground text-xs">
											{skippedEmptyVaultCount === 1
												? m.vaults_import_mapping_skipped_empty_vaults_single({
														count: skippedEmptyVaultCount,
													})
												: m.vaults_import_mapping_skipped_empty_vaults_plural({
														count: skippedEmptyVaultCount,
													})}
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
																? m.vaults_import_mapping_source_item_count_single(
																		{
																			count: sourceVault.itemCount,
																		},
																	)
																: m.vaults_import_mapping_source_item_count_plural(
																		{
																			count: sourceVault.itemCount,
																		},
																	)}
														</p>
													</div>
													<Badge variant="secondary">
														{m.vaults_import_mapping_badge_source()}
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
																{m.vaults_import_mapping_mode_create()}
															</SelectItem>
															<SelectItem value="existing">
																{m.vaults_import_mapping_mode_existing()}
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
															placeholder={m.vaults_import_mapping_placeholder_new_vault_name()}
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
																	placeholder={m.vaults_import_mapping_placeholder_select_vault()}
																/>
															</SelectTrigger>
															<SelectContent>
																{existingVaults.length === 0 ? (
																	<SelectItem value="__none" disabled>
																		{m.vaults_import_mapping_empty_no_existing_vaults()}
																	</SelectItem>
																) : (
																	existingVaults.map((vault) => (
																		<SelectItem
																			key={vault.vaultId}
																			value={vault.vaultId}
																			disabled={vault.role === "read-only"}
																		>
																			{vault.role === "read-only"
																				? m.vaults_import_mapping_target_vault_read_only(
																						{ vaultName: vault.vaultName },
																					)
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
														{m.vaults_import_mapping_read_only_notice()}
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
										{m.vaults_import_summary_title()}
									</h3>
									<p className="text-muted-foreground text-sm">
										{m.vaults_import_summary_description()}
									</p>
								</div>
							</div>

							<div className="grid gap-2 sm:grid-cols-4">
								<div className="rounded-lg border p-3">
									<div className="text-muted-foreground text-xs">
										{m.vaults_import_summary_stat_imported()}
									</div>
									<div className="font-semibold text-lg">
										{summary.importedCount}
									</div>
								</div>
								<div className="rounded-lg border p-3">
									<div className="text-muted-foreground text-xs">
										{m.vaults_import_summary_stat_skipped()}
									</div>
									<div className="font-semibold text-lg">
										{summary.skippedCount}
									</div>
								</div>
								<div className="rounded-lg border p-3">
									<div className="text-muted-foreground text-xs">
										{m.vaults_import_summary_stat_warnings()}
									</div>
									<div className="font-semibold text-lg">
										{summary.warningCount}
									</div>
								</div>
								<div className="rounded-lg border p-3">
									<div className="text-muted-foreground text-xs">
										{m.vaults_import_summary_stat_new_vaults()}
									</div>
									<div className="font-semibold text-lg">
										{summary.createdVaultCount}
									</div>
								</div>
							</div>

							{summary.failedVaultCount > 0 && (
								<div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
									<p className="font-medium text-amber-700 text-sm dark:text-amber-300">
										{m.vaults_import_summary_failed_vaults_title()}
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
									{m.vaults_import_summary_action_open_vaults()}
								</Button>
								<Button
									type="button"
									variant="outline"
									onClick={() => onOpenChange(false)}
								>
									{m.vaults_import_summary_action_close()}
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
									{m.vaults_import_action_back()}
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
								{m.vaults_import_action_cancel()}
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
									{m.vaults_import_action_continue()}
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
											{m.vaults_import_action_importing()}
										</>
									) : (
										m.vaults_import_action_start_import()
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
