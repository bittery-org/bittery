import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	Progress,
} from "@bittery/ui";
import {
	IconCircleCheck2OutlineDuo18 as CheckCircle,
	IconCircleWarningOutlineDuo18 as AlertCircle,
	IconLoader2OutlineDuo18 as Loader2,
	IconArchiveExport2OutlineDuo18 as Download,
} from "@bittery/ui/icons";
import { useCallback } from "react";
import {
	useVaultExport,
} from "@/hooks/use-vault-export";
import { useI18n } from "@/providers/i18n-provider";

interface VaultExportDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function VaultExportDialog({ open, onOpenChange }: VaultExportDialogProps) {
	const { m } = useI18n();
	const { progress, archiveBlob, error, reset, startExport, downloadArchive } =
		useVaultExport();

	const isIdle = progress.stage === "idle";
	const isInProgress =
		!isIdle &&
		progress.stage !== "completed" &&
		progress.stage !== "error";
	const isCompleted = progress.stage === "completed";
	const isError = progress.stage === "error";

	const progressPercent = (() => {
		if (progress.totalItems === 0 && progress.totalAttachments === 0) {
			return 0;
		}
		if (
			progress.stage === "fetching" ||
			progress.stage === "decrypting"
		) {
			if (progress.totalItems === 0) return 0;
			return Math.min(
				100,
				Math.round((progress.processedItems / progress.totalItems) * 100),
			);
		}
		if (progress.stage === "downloading-files") {
			if (progress.totalAttachments === 0) return 100;
			return Math.min(
				100,
				Math.round(
					(progress.processedAttachments / progress.totalAttachments) * 100,
				),
			);
		}
		if (progress.stage === "building-archive") return 95;
		if (progress.stage === "completed") return 100;
		return 0;
	})();

	const stageLabel = (() => {
		switch (progress.stage) {
			case "fetching":
				return m.vault_export_dialog_stage_fetching();
			case "decrypting":
				return m.vault_export_dialog_stage_decrypting();
			case "downloading-files":
				return m.vault_export_dialog_stage_downloading_files();
			case "building-archive":
				return m.vault_export_dialog_stage_building_archive();
			case "completed":
				return m.vault_export_dialog_stage_completed();
			default:
				return "";
		}
	})();

	const handleOpenChange = useCallback(
		(nextOpen: boolean) => {
			if (!nextOpen && isInProgress) {
				return;
			}
			if (!nextOpen) {
				reset();
			}
			onOpenChange(nextOpen);
		},
		[isInProgress, onOpenChange, reset],
	);

	const handleTryAgain = useCallback(() => {
		reset();
	}, [reset]);

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="max-w-[calc(100%-1rem)] sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{m.vault_export_dialog_title()}</DialogTitle>
					<DialogDescription>
						{m.vault_export_dialog_description()}
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-5 pt-1">
					{/* ── Confirm view ─────────────────────────────────────────── */}
					{isIdle && (
						<div className="flex flex-col gap-4">
							<div className="flex justify-end gap-2">
								<Button
									variant="outline"
									onClick={() => handleOpenChange(false)}
								>
									{m.vault_export_dialog_cancel()}
								</Button>
								<Button onClick={startExport}>
									{m.vault_export_dialog_confirm_button()}
								</Button>
							</div>
						</div>
					)}

					{/* ── In-progress view ─────────────────────────────────────── */}
					{isInProgress && (
						<div className="space-y-4">
							<div className="flex items-center gap-3">
								<Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
								<span className="text-sm">{stageLabel}</span>
							</div>
							<Progress value={progressPercent} className="h-2" />
							{progress.totalItems > 0 && (
								<p className="text-muted-foreground text-xs">
									{m.vault_export_dialog_progress_items({
										done: progress.processedItems,
										total: progress.totalItems,
									})}
								</p>
							)}
							{progress.totalAttachments > 0 &&
								progress.stage === "downloading-files" && (
									<p className="text-muted-foreground text-xs">
										{m.vault_export_dialog_progress_attachments({
											done: progress.processedAttachments,
											total: progress.totalAttachments,
										})}
									</p>
								)}
						</div>
					)}

					{/* ── Completed view ───────────────────────────────────────── */}
					{isCompleted && (
						<div className="space-y-4">
							<div className="flex items-center gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-4">
								<CheckCircle className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
								<span className="font-medium text-sm">
									{m.vault_export_dialog_stage_completed()}
								</span>
							</div>
							<div className="flex justify-end gap-2">
								<Button
									variant="outline"
									onClick={() => handleOpenChange(false)}
								>
									{m.vault_export_dialog_cancel()}
								</Button>
								<Button onClick={downloadArchive} disabled={!archiveBlob}>
									<Download className="mr-2 h-4 w-4" />
									{m.vault_export_dialog_download()}
								</Button>
							</div>
						</div>
					)}

					{/* ── Error view ───────────────────────────────────────────── */}
					{isError && (
						<div className="space-y-4">
							<div className="flex items-start gap-3 rounded-xl border border-destructive/20 bg-destructive/10 p-4">
								<AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
								<span className="text-destructive text-sm">
									{error ?? m.vault_export_dialog_error_generic()}
								</span>
							</div>
							<div className="flex justify-end gap-2">
								<Button
									variant="outline"
									onClick={() => handleOpenChange(false)}
								>
									{m.vault_export_dialog_cancel()}
								</Button>
								<Button onClick={handleTryAgain}>
									{m.vault_export_dialog_try_again()}
								</Button>
							</div>
						</div>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
