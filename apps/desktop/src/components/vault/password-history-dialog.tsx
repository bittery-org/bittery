import type { PasswordHistoryEntry } from "@bittery/shared/types";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	Button,
	Card,
	CardContent,
	copyWithToast,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@bittery/ui";
import { IconCopyOutlineDuo18 } from "@bittery/ui/icons";
import { useMemo, useState } from "react";

interface PasswordHistoryDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	passwordHistory?: PasswordHistoryEntry[];
	currentPassword?: string;
	onRestorePassword: (password: string) => Promise<void>;
	isRestoring?: boolean;
}

function formatChangedAt(changedAt: string): string {
	const timestamp = Date.parse(changedAt);
	if (Number.isNaN(timestamp)) {
		return changedAt;
	}

	return new Date(timestamp).toLocaleString();
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
	const [pendingRestore, setPendingRestore] = useState<PasswordHistoryEntry | null>(
		null,
	);

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
						<DialogTitle>Password History</DialogTitle>
						<DialogDescription>
							View previous passwords and restore one when needed.
						</DialogDescription>
					</DialogHeader>

					<div className="flex-1 space-y-3 overflow-y-auto pr-2">
						{sortedHistory.length === 0 ? (
							<Card>
								<CardContent className="py-8 text-center text-muted-foreground text-sm">
									No previous passwords saved yet.
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
													{formatChangedAt(historyEntry.changedAt)}
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
														copyWithToast(historyEntry.password, "Password")
													}
												>
													<IconCopyOutlineDuo18 className="size-4" />
													Copy
												</Button>
												<Button
													variant="outline"
													size="sm"
													onClick={() => setPendingRestore(historyEntry)}
													disabled={isCurrent || isRestoring}
												>
													{isCurrent ? "Current" : "Restore"}
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
						<AlertDialogTitle>Restore Password</AlertDialogTitle>
						<AlertDialogDescription>
							Restore this password for the login item? The current password
							will be archived automatically.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={isRestoring}>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={handleConfirmRestore}
							disabled={isRestoring}
						>
							{isRestoring ? "Restoring..." : "Restore"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
