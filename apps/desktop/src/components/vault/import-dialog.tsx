import { encrypt } from "@bittery/crypto/encryption";
import * as tauriStorage from "@bittery/crypto/storage-tauri";
import { useTRPCClient } from "@bittery/shared/trpc";
import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Label,
	Progress,
} from "@bittery/ui";
import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, FileUp } from "lucide-react";
import { useState } from "react";
import { useQueryInvalidator } from "../../providers/sync-provider";
import type { ParsedImportItem } from "../../utils/import-parsers";
import { parseImportFile } from "../../utils/import-parsers";

interface ImportDialogProps {
	vaultId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function ImportDialog({
	vaultId,
	open,
	onOpenChange,
}: ImportDialogProps) {
	const trpcClient = useTRPCClient();
	const invalidator = useQueryInvalidator();

	const [importStatus, setImportStatus] = useState<
		"idle" | "parsing" | "encrypting" | "uploading" | "success" | "error"
	>("idle");
	const [progress, setProgress] = useState(0);
	const [parsedItems, setParsedItems] = useState<ParsedImportItem[]>([]);
	const [errorMessage, setErrorMessage] = useState<string>("");
	const [warnings, setWarnings] = useState<string[]>([]);

	const form = useForm({
		defaultValues: {
			importFormat: "csv" as "csv" | "json",
			selectedFile: null as File | null,
		},
		onSubmit: async ({ value }) => {
			if (value.selectedFile) {
				await importMutation.mutateAsync();
			}
		},
	});

	const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		if (file) {
			form.setFieldValue("selectedFile", file);
			setImportStatus("idle");
			setErrorMessage("");
			setWarnings([]);
			setParsedItems([]);
			setProgress(0);

			// Auto-detect format from file extension
			if (file.name.endsWith(".json")) {
				form.setFieldValue("importFormat", "json");
			} else if (file.name.endsWith(".csv")) {
				form.setFieldValue("importFormat", "csv");
			}
		}
	};

	const importMutation = useMutation({
		mutationFn: async () => {
			const { selectedFile, importFormat } = form.state.values;
			if (!selectedFile) throw new Error("No file selected");

			setImportStatus("parsing");
			setProgress(10);

			// Read file content
			const content = await selectedFile.text();

			// Parse the file
			const parseResult = parseImportFile(content, importFormat);

			if (!parseResult.success) {
				throw new Error(
					parseResult.errors.join("\n") || "Failed to parse import file",
				);
			}

			if (parseResult.warnings.length > 0) {
				setWarnings(parseResult.warnings);
			}

			setParsedItems(parseResult.items);
			setProgress(30);

			// Get vault key for encryption
			setImportStatus("encrypting");
			const vaultKey = await tauriStorage.getDecryptedVaultKey(vaultId);
			if (!vaultKey) {
				throw new Error("Failed to get vault key for encryption");
			}

			// Encrypt all items
			const encryptedItems = [];
			for (let i = 0; i < parseResult.items.length; i++) {
				const item = parseResult.items[i];

				// Merge overview and sensitiveData into a single object for encryption
				// This matches the manual creation flow where ALL data is encrypted
				const completeItemData = {
					title: item.overview.title,
					url: item.overview.url,
					username: item.overview.username,
					...item.sensitiveData,
				};

				// Encrypt the complete item data
				const encryptedData = await encrypt(
					JSON.stringify(completeItemData),
					vaultKey,
				);

				encryptedItems.push({
					category: item.category,
					favorite: item.favorite,
					encryptedData: encryptedData.ciphertext,
					encryptionIv: encryptedData.iv,
					encryptionAlgorithm: encryptedData.algorithm,
				});

				// Update progress
				const encryptProgress =
					30 + Math.floor((i / parseResult.items.length) * 40);
				setProgress(encryptProgress);
			}

			setProgress(70);
			setImportStatus("uploading");

			// Bulk import via tRPC
			const result = await trpcClient.vault.bulkImportItems.mutate({
				vaultId,
				items: encryptedItems,
			});

			setProgress(100);
			setImportStatus("success");

			return result;
		},
		onSuccess: async () => {
			// Invalidate queries to refresh the item list
			await invalidator.invalidateVaultList(vaultId);

			// Auto-close dialog after a short delay
			setTimeout(() => {
				onOpenChange(false);
				resetDialog();
			}, 2000);
		},
		onError: (error) => {
			setImportStatus("error");
			setErrorMessage(
				error instanceof Error ? error.message : "Unknown error occurred",
			);
		},
	});

	const resetDialog = () => {
		form.reset();
		setImportStatus("idle");
		setProgress(0);
		setParsedItems([]);
		setErrorMessage("");
		setWarnings([]);
	};

	const handleClose = () => {
		if (importStatus !== "encrypting" && importStatus !== "uploading") {
			onOpenChange(false);
			resetDialog();
		}
	};

	return (
		<Dialog open={open} onOpenChange={handleClose}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Import from 1Password</DialogTitle>
					<DialogDescription>
						Import your passwords and items from a 1Password CSV or JSON export
						file.
					</DialogDescription>
				</DialogHeader>

				<form
					onSubmit={(e) => {
						e.preventDefault();
						form.handleSubmit();
					}}
				>
					<div className="space-y-4">
						{/* Format Selection */}
						<form.Field name="importFormat">
							{(field) => (
								<div className="space-y-2">
									<Label htmlFor={field.name}>Import Format</Label>
									<div className="flex gap-2">
										<Button
											type="button"
											variant={
												field.state.value === "csv" ? "default" : "outline"
											}
											onClick={() => field.handleChange("csv")}
											disabled={
												importStatus === "encrypting" ||
												importStatus === "uploading"
											}
											className="flex-1"
										>
											CSV File
										</Button>
										<Button
											type="button"
											variant={
												field.state.value === "json" ? "default" : "outline"
											}
											onClick={() => field.handleChange("json")}
											disabled={
												importStatus === "encrypting" ||
												importStatus === "uploading"
											}
											className="flex-1"
										>
											JSON File
										</Button>
									</div>
								</div>
							)}
						</form.Field>

						{/* File Upload */}
						<form.Field name="selectedFile">
							{(field) => (
								<div className="space-y-2">
									<Label>Select File</Label>
									<div className="flex items-center gap-2">
										<Button
											type="button"
											variant="outline"
											className="w-full justify-start"
											onClick={() =>
												document.getElementById("file-input")?.click()
											}
											disabled={
												importStatus === "encrypting" ||
												importStatus === "uploading"
											}
										>
											<FileUp className="mr-2 h-4 w-4" />
											<span className="max-w-xs truncate">
												{field.state.value
													? field.state.value.name
													: "Choose file..."}
											</span>
										</Button>
										<input
											id="file-input"
											type="file"
											accept=".csv,.json"
											className="hidden"
											onChange={handleFileSelect}
											disabled={
												importStatus === "encrypting" ||
												importStatus === "uploading"
											}
										/>
									</div>
								</div>
							)}
						</form.Field>

						{/* Progress */}
						{(importStatus === "parsing" ||
							importStatus === "encrypting" ||
							importStatus === "uploading") && (
							<div className="space-y-2">
								<div className="flex items-center justify-between text-sm">
									<span className="text-muted-foreground">
										{importStatus === "parsing" && "Parsing file..."}
										{importStatus === "encrypting" && "Encrypting items..."}
										{importStatus === "uploading" && "Uploading to vault..."}
									</span>
									<span className="text-muted-foreground">{progress}%</span>
								</div>
								<Progress value={progress} />
							</div>
						)}

						{/* Success Message */}
						{importStatus === "success" && (
							<div className="flex items-start gap-2 rounded-md border border-green-200 bg-green-50 p-3 dark:border-green-800 dark:bg-green-950">
								<CheckCircle2 className="mt-0.5 h-4 w-4 text-green-600 dark:text-green-400" />
								<div className="text-sm">
									<p className="font-medium text-green-900 dark:text-green-100">
										Import successful!
									</p>
									<p className="text-green-700 dark:text-green-300">
										{parsedItems.length} item
										{parsedItems.length !== 1 ? "s" : ""} imported into your
										vault.
									</p>
								</div>
							</div>
						)}

						{/* Error Message */}
						{importStatus === "error" && errorMessage && (
							<div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 dark:border-red-800 dark:bg-red-950">
								<AlertCircle className="mt-0.5 h-4 w-4 text-red-600 dark:text-red-400" />
								<div className="text-sm">
									<p className="font-medium text-red-900 dark:text-red-100">
										Import failed
									</p>
									<p className="text-red-700 dark:text-red-300">
										{errorMessage}
									</p>
								</div>
							</div>
						)}

						{/* Warnings */}
						{warnings.length > 0 && importStatus !== "error" && (
							<div className="flex items-start gap-2 rounded-md border border-yellow-200 bg-yellow-50 p-3 dark:border-yellow-800 dark:bg-yellow-950">
								<AlertCircle className="mt-0.5 h-4 w-4 text-yellow-600 dark:text-yellow-400" />
								<div className="text-sm">
									<p className="font-medium text-yellow-900 dark:text-yellow-100">
										Warnings ({warnings.length})
									</p>
									<ul className="mt-1 list-inside list-disc space-y-1 text-yellow-700 dark:text-yellow-300">
										{warnings.slice(0, 3).map((warning) => (
											<li key={warning} className="text-xs">
												{warning}
											</li>
										))}
										{warnings.length > 3 && (
											<li className="text-xs">
												... and {warnings.length - 3} more
											</li>
										)}
									</ul>
								</div>
							</div>
						)}

						{/* Info Text */}
						{importStatus === "idle" && (
							<p className="text-muted-foreground text-sm">
								Select a 1Password export file to import your items. All
								sensitive data will be encrypted before being stored in your
								vault.
							</p>
						)}
					</div>

					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={handleClose}
							disabled={
								importStatus === "encrypting" || importStatus === "uploading"
							}
						>
							{importStatus === "success" ? "Close" : "Cancel"}
						</Button>
						{importStatus !== "success" && (
							<Button
								type="submit"
								disabled={
									!form.state.values.selectedFile ||
									importStatus === "encrypting" ||
									importStatus === "uploading"
								}
							>
								{importStatus === "encrypting" || importStatus === "uploading"
									? "Importing..."
									: "Import"}
							</Button>
						)}
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
