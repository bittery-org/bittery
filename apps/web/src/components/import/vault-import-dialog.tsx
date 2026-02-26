import {
	getImportProvider,
	getImportProviders,
	type ImportProvider,
	type ImportProviderId,
} from "@bittery/shared";
import {
	Badge,
	Button,
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
	type ImportExecutionSummary,
	useVaultImport,
} from "@/hooks/use-vault-import";

type ImportDialogStep = "manager" | "upload";

interface VaultImportDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onImportCompleted?: (summary: ImportExecutionSummary) => void;
}

function ImportProviderLogo({ provider }: { provider: ImportProvider }) {
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
			title={provider.imageDescription}
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
		return "Import failed. Please verify the export file and try again.";
	}, [error]);

	const handleSelectedFile = useCallback(
		async (file: File) => {
			if (!selectedProviderId) {
				toast.error("Select a provider before uploading a file.");
				return;
			}

			setSelectedFileName(file.name);

			try {
				await parseFile(file, selectedProviderId);
			} catch (parseError) {
				toast.error(
					parseError instanceof Error
						? parseError.message
						: "Could not parse that export file. Try a different file.",
				);
			}
		},
		[parseFile, selectedProviderId],
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
					`Import finished with ${result.failedVaultCount} vault issue${
						result.failedVaultCount === 1 ? "" : "s"
					}.`,
				);
				return;
			}

			toast.success("Import completed successfully.");
		} catch (executionError) {
			const executionMessage =
				executionError instanceof Error
					? executionError.message
					: "Import failed unexpectedly.";
			toast.error(executionMessage);
		}
	}, [executeImport, onImportCompleted]);

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
			toast.error("Select an import provider to continue.");
			return;
		}
		setDialogStep("upload");
	}, [selectedProviderId]);

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

	return (
		<Dialog open={open} onOpenChange={handleDialogOpenChange}>
			<DialogContent className="flex max-h-[92vh] max-w-[calc(100%-1rem)] flex-col overflow-hidden p-0 sm:max-w-4xl">
				<DialogHeader className="space-y-4 border-b px-6 py-5">
					<div className="space-y-1">
						<DialogTitle>Import vault data</DialogTitle>
						<DialogDescription>
							Bring your items into Bittery with a guided import flow and vault
							mapping before encryption.
						</DialogDescription>
					</div>
					{!showSummaryStep && (
						<div className="grid gap-2 sm:grid-cols-3">
							{[
								{ label: "Select Provider", step: 1 },
								{ label: "Upload File", step: 2 },
								{ label: "Map + Import", step: 3 },
							].map((stepItem) => {
								const isActive = currentStep === stepItem.step;
								const isDone = currentStep > stepItem.step;
								return (
									<div
										key={stepItem.label}
										className={`rounded-lg border px-3 py-2 ${
											isDone
												? "border-primary/35 bg-primary/5"
												: isActive
													? "border-foreground/20 bg-muted/40"
													: "bg-background"
										}`}
									>
										<div className="flex items-center gap-2">
											{isDone ? (
												<CheckCircle className="h-4 w-4 text-primary" />
											) : (
												<span
													className={`inline-flex h-5 w-5 items-center justify-center rounded-full border font-medium text-[11px] ${
														isActive
															? "border-primary/50 text-primary"
															: "border-border text-muted-foreground"
													}`}
												>
													{stepItem.step}
												</span>
											)}
											<span
												className={`font-medium text-xs ${
													isActive ? "text-foreground" : "text-muted-foreground"
												}`}
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
								<h3 className="font-medium text-sm">Choose import provider</h3>
								<p className="text-muted-foreground text-sm">
									Select your provider, then upload the corresponding export
									file in the next step.
								</p>
							</div>

							{importProviders.length === 0 ? (
								<div className="rounded-xl border border-dashed p-4 text-muted-foreground text-sm">
									No import providers are currently registered.
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
												className={`flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition ${
													isSelected
														? "border-primary/45 bg-primary/5"
														: "border-border bg-card hover:border-foreground/30 hover:bg-accent/30"
												}`}
												aria-pressed={isSelected}
											>
												<ImportProviderLogo provider={provider} />
												<div className="flex-1 space-y-0.5">
													<p className="font-medium text-sm">
														{provider.title}
													</p>
													<p className="text-muted-foreground text-xs">
														{provider.description}
													</p>
												</div>
												<Badge variant={isSelected ? "default" : "secondary"}>
													{isSelected ? "Selected" : "Select"}
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
										Selected Provider
									</p>
									<p className="font-medium text-sm">
										{selectedProvider?.title ?? "Import provider"}
									</p>
								</div>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => setDialogStep("manager")}
									disabled={isBusy}
								>
									Change
								</Button>
							</div>

							<div className="space-y-4 rounded-xl border border-dashed p-5">
								<div className="space-y-1">
									<Label htmlFor="vault-import-file">Export file</Label>
									<p className="text-muted-foreground text-sm">
										Upload the export generated by{" "}
										{selectedProvider?.title ?? "your selected provider"}.
									</p>
									<p className="text-muted-foreground text-xs">
										Accepted:{" "}
										{selectedProvider?.fileTypeLabel ?? "provider format"}
									</p>
								</div>

								<label
									htmlFor="vault-import-file"
									className={`block space-y-3 rounded-lg border border-dashed p-4 transition ${
										isDropzoneActive
											? "border-primary/45 bg-primary/5"
											: "border-border bg-background/40"
									} ${
										isBusy || !selectedProvider
											? "cursor-not-allowed opacity-70"
											: "cursor-pointer"
									}`}
									onDragOver={handleDropzoneDragOver}
									onDragLeave={handleDropzoneDragLeave}
									onDrop={handleDropzoneDrop}
								>
									<div className="text-muted-foreground text-sm">
										Drop your export file here or choose it manually.
									</div>

									<div className="flex flex-wrap items-center gap-2">
										<span className="inline-flex items-center rounded-md border border-input bg-background px-3 py-1.5 text-sm shadow-xs">
											<Upload className="mr-2 h-4 w-4" />
											{selectedFileName || "Choose file"}
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
									<p className="font-medium text-sm">Preview is ready</p>
									<p className="text-muted-foreground text-xs">
										Review vault mapping before starting encrypted import.
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
										Choose another file
									</Button>
								</div>
							</div>

							<div className="grid gap-2 sm:grid-cols-4">
								<div className="rounded-lg border bg-card p-3">
									<div className="text-muted-foreground text-xs">Vaults</div>
									<div className="font-semibold text-lg">
										{preview.summary.vaultCount}
									</div>
								</div>
								<div className="rounded-lg border bg-card p-3">
									<div className="text-muted-foreground text-xs">Items</div>
									<div className="font-semibold text-lg">
										{preview.summary.itemCount}
									</div>
								</div>
								<div className="rounded-lg border bg-card p-3">
									<div className="text-muted-foreground text-xs">Skipped</div>
									<div className="font-semibold text-lg">
										{preview.summary.skippedCount}
									</div>
								</div>
								<div className="rounded-lg border bg-card p-3">
									<div className="text-muted-foreground text-xs">Warnings</div>
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
											Warnings ({preview.warnings.length})
										</span>
									</div>
									<div className="max-h-32 space-y-1 overflow-y-auto pr-1">
										{preview.warnings.slice(0, 8).map((warning) => (
											<p
												key={`${warning.code}-${warning.sourceItemId ?? warning.message}`}
												className="text-muted-foreground text-xs"
											>
												{warning.message}
											</p>
										))}
									</div>
								</div>
							)}

							<div className="space-y-3 rounded-xl border p-4">
								<div>
									<h3 className="font-medium text-sm">Vault mapping</h3>
									<p className="text-muted-foreground text-sm">
										Each source vault can create a new Bittery vault or merge
										into an existing one.
									</p>
									{skippedEmptyVaultCount > 0 && (
										<p className="mt-1 text-muted-foreground text-xs">
											{skippedEmptyVaultCount} empty source vault
											{skippedEmptyVaultCount === 1 ? "" : "s"} were excluded
											automatically.
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
															{sourceVault.itemCount} item
															{sourceVault.itemCount === 1 ? "" : "s"}
														</p>
													</div>
													<Badge variant="secondary">Source</Badge>
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
															<SelectItem value="create">Create New</SelectItem>
															<SelectItem value="existing">
																Use Existing
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
															placeholder="New vault name"
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
																<SelectValue placeholder="Select a vault" />
															</SelectTrigger>
															<SelectContent>
																{existingVaults.length === 0 ? (
																	<SelectItem value="__none" disabled>
																		No existing vaults
																	</SelectItem>
																) : (
																	existingVaults.map((vault) => (
																		<SelectItem
																			key={vault.vaultId}
																			value={vault.vaultId}
																			disabled={vault.role === "read-only"}
																		>
																			{vault.vaultName}
																			{vault.role === "read-only"
																				? " (read-only)"
																				: ""}
																		</SelectItem>
																	))
																)}
															</SelectContent>
														</Select>
													)}
												</div>

												{selectedVault?.role === "read-only" && (
													<p className="text-amber-700 text-xs dark:text-amber-300">
														This vault is read-only. Choose a different target.
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
											<span>{progress.message}</span>
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
									<h3 className="font-medium">Import complete</h3>
									<p className="text-muted-foreground text-sm">
										Your items were imported and encrypted successfully.
									</p>
								</div>
							</div>

							<div className="grid gap-2 sm:grid-cols-4">
								<div className="rounded-lg border p-3">
									<div className="text-muted-foreground text-xs">Imported</div>
									<div className="font-semibold text-lg">
										{summary.importedCount}
									</div>
								</div>
								<div className="rounded-lg border p-3">
									<div className="text-muted-foreground text-xs">Skipped</div>
									<div className="font-semibold text-lg">
										{summary.skippedCount}
									</div>
								</div>
								<div className="rounded-lg border p-3">
									<div className="text-muted-foreground text-xs">Warnings</div>
									<div className="font-semibold text-lg">
										{summary.warningCount}
									</div>
								</div>
								<div className="rounded-lg border p-3">
									<div className="text-muted-foreground text-xs">
										New Vaults
									</div>
									<div className="font-semibold text-lg">
										{summary.createdVaultCount}
									</div>
								</div>
							</div>

							{summary.failedVaultCount > 0 && (
								<div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
									<p className="font-medium text-amber-700 text-sm dark:text-amber-300">
										Some vaults could not be imported
									</p>
									<div className="space-y-1">
										{summary.failedVaults.map((failedVault) => (
											<p
												key={`${failedVault.sourceVaultId}-${failedVault.message}`}
												className="text-muted-foreground text-xs"
											>
												{failedVault.sourceVaultName}: {failedVault.message}
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
									Open Vaults
								</Button>
								<Button
									type="button"
									variant="outline"
									onClick={() => onOpenChange(false)}
								>
									Close
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
									Back
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
								Cancel
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
									Continue
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
											Importing...
										</>
									) : (
										"Start Import"
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
