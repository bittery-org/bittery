import { useI18n } from "@bittery/i18n/react";
import type { PasswordHistoryEntry } from "@bittery/shared/types";
import { useMemo, useState } from "react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "../alert-dialog";
import { Button } from "../button";
import { Card, CardContent } from "../card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../dialog";
import { copyWithToast } from "../clipboard";
import { IconCopyOutlineDuo18 } from "@bittery/ui/icons";

export interface PasswordHistoryDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	passwordHistory?: PasswordHistoryEntry[];
	currentPassword?: string;
	onRestorePassword: (password: string) => Promise<void>;
	isRestoring?: boolean;
}

function formatChangedAt(changedAt: string, locale: string): string {
	const timestamp = Date.parse(changedAt);
	if (Number.isNaN(timestamp)) {
		return changedAt;
	}

	return new Intl.DateTimeFormat(locale).format(new Date(timestamp));
}

function maskPassword(password: string): string {
	return "\u2022".repeat(Math.max(8, Math.min(16, password.length)));
}

export function PasswordHistoryDialog({
	open,
	onOpenChange,
	passwordHistory,
	currentPassword,
	onRestorePassword,
	isRestoring = false,
}: PasswordHistoryDialogProps) {
	const { m, locale } = useI18n();
	const [pendingRestore, setPendingRestore] =
		useState<PasswordHistoryEntry | null>(null);

	const sortedHistory = useMemo(() => {
		return [...(passwordHistory ?? [])].sort((left, right) => {
			const leftTs = Date.parse(left.changedAt);
			const rightTs = Date.parse(right.changedAt);

			if (Number.isNaN(leftTs) && Number.isNaN(rightTs)) {
				return 0;
			}
			if (Number.isNaN(leftTs)) {
				return 1;
			}
			if (Number.isNaN(rightTs)) {
				return -1;
			}

			return rightTs - leftTs;
		});
	}, [passwordHistory]);

	const handleConfirmRestore = async () => {
		if (!pendingRestore) {
			return;
		}

		try {
			await onRestorePassword(pendingRestore.password);
			setPendingRestore(null);
		} catch {
			// Parent handles restore error toasts.
		}
	};

	return (
		<>
			<Dialog open={open} onOpenChange={onOpenChange}>
				<DialogContent className="flex max-h-[80vh] max-w-2xl flex-col overflow-hidden">
					<DialogHeader>
						<DialogTitle>
							{m.vaults_detail_items_password_history_dialog_title()}
						</DialogTitle>
						<DialogDescription>
							{m.vaults_detail_items_password_history_dialog_description()}
						</DialogDescription>
					</DialogHeader>

					<div className="flex-1 space-y-3 overflow-y-auto pr-2">
						{sortedHistory.length === 0 ? (
							<Card>
								<CardContent className="py-8 text-center text-muted-foreground text-sm">
									{m.vaults_detail_items_password_history_dialog_empty()}
								</CardContent>
							</Card>
						) : (
							sortedHistory.map((historyEntry) => {
								const isCurrent = historyEntry.password === currentPassword;
								return (
									<Card
										key={`${historyEntry.password}-${historyEntry.changedAt}`}
										className="py-0"
									>
										<CardContent className="flex items-center justify-between gap-4 p-4">
											<div className="min-w-0">
												<p className="font-medium text-sm">
													{formatChangedAt(historyEntry.changedAt, locale)}
												</p>
												<p className="font-mono text-muted-foreground text-xs">
													{maskPassword(historyEntry.password)}
												</p>
											</div>

											<div className="flex shrink-0 items-center gap-2">
												<Button
													variant="ghost"
													size="sm"
													onClick={() =>
															copyWithToast(
																historyEntry.password,
																m.vaults_detail_items_copy_label_password(),
														)
													}
												>
													<IconCopyOutlineDuo18 className="size-4" />
													{m.vaults_detail_items_password_history_dialog_action_copy()}
												</Button>
												<Button
													variant="outline"
													size="sm"
													onClick={() => setPendingRestore(historyEntry)}
													disabled={isCurrent || isRestoring}
												>
													{isCurrent
														? m.vaults_detail_items_password_history_dialog_action_current()
														: m.vaults_detail_items_password_history_dialog_action_restore()}
												</Button>
											</div>
										</CardContent>
									</Card>
								);
							})
						)}
					</div>
				</DialogContent>
			</Dialog>

			<AlertDialog
				open={Boolean(pendingRestore)}
				onOpenChange={(isOpen) => {
					if (!isOpen && !isRestoring) {
						setPendingRestore(null);
					}
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{m.vaults_detail_items_password_history_dialog_restore_dialog_title()}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{m.vaults_detail_items_password_history_dialog_restore_dialog_description()}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={isRestoring}>
							{m.vaults_detail_items_detail_action_cancel()}
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={handleConfirmRestore}
							disabled={isRestoring}
						>
							{isRestoring
								? m.vaults_detail_items_password_history_dialog_restore_dialog_action_restoring()
								: m.vaults_detail_items_password_history_dialog_restore_dialog_action_restore()}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
