/**
 * Previous passwords for a login, and the one verb that matters: put this one back.
 *
 * The phone counterpart of `@bittery/ui`'s `PasswordHistoryDialog`, which is a centred modal
 * with a `max-w-2xl` body and a second `AlertDialog` stacked on top of it — at phone width that
 * lands as a floating card over the detail screen instead of the bottom sheet every other item
 * action uses.
 *
 * The restore confirmation swaps this sheet's *contents* rather than opening a second sheet, for
 * the reason `ShareItemSheet` documents: unmounting one open Radix dialog while mounting another
 * in the same commit can strand `pointer-events: none` on the body.
 */

import type { PasswordHistoryEntry } from "@bittery/shared/types";
import { IconArchiveRestore, IconCheck, IconCopy } from "@bittery/ui/icons";
import { useState } from "react";
import { iconClass, ListCard, MobileSheet, Pressable } from "@/components/ui";
import { useI18n } from "@/providers/i18n-provider";

/** Length is a secret too, so every entry masks to the same 12 dots. */
const MASK = "•".repeat(12);

interface PasswordHistorySheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	passwordHistory?: PasswordHistoryEntry[];
	currentPassword?: string;
	onCopy: (value: string, label: string) => Promise<void>;
	onRestorePassword: (password: string) => Promise<void>;
	isRestoring?: boolean;
}

function formatChangedAt(changedAt: string, locale: string): string {
	const timestamp = Date.parse(changedAt);
	if (Number.isNaN(timestamp)) return changedAt;
	return new Intl.DateTimeFormat(locale, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(timestamp));
}

/** Newest first, with unparseable timestamps sunk to the bottom rather than dropped. */
function sortByChangedAt(
	entries: PasswordHistoryEntry[],
): PasswordHistoryEntry[] {
	return [...entries].sort((left, right) => {
		const leftTs = Date.parse(left.changedAt);
		const rightTs = Date.parse(right.changedAt);
		if (Number.isNaN(leftTs) && Number.isNaN(rightTs)) return 0;
		if (Number.isNaN(leftTs)) return 1;
		if (Number.isNaN(rightTs)) return -1;
		return rightTs - leftTs;
	});
}

export function PasswordHistorySheet({
	open,
	onOpenChange,
	passwordHistory,
	currentPassword,
	onCopy,
	onRestorePassword,
	isRestoring = false,
}: PasswordHistorySheetProps) {
	const { m, locale } = useI18n();
	const [pendingRestore, setPendingRestore] =
		useState<PasswordHistoryEntry | null>(null);

	const history = sortByChangedAt(passwordHistory ?? []);

	const closeConfirm = () => setPendingRestore(null);

	const confirmRestore = async () => {
		if (!pendingRestore) return;
		try {
			await onRestorePassword(pendingRestore.password);
			setPendingRestore(null);
		} catch {
			// The detail screen owns the failure toast; the confirm stays up so the user can retry.
		}
	};

	return (
		<MobileSheet
			open={open}
			onOpenChange={(next) => {
				if (isRestoring) return;
				if (!next) closeConfirm();
				onOpenChange(next);
			}}
			title={
				pendingRestore
					? m.vaults_detail_items_password_history_dialog_restore_dialog_title()
					: m.vaults_detail_items_password_history_dialog_title()
			}
			description={
				pendingRestore
					? m.vaults_detail_items_password_history_dialog_restore_dialog_description()
					: m.vaults_detail_items_password_history_dialog_description()
			}
		>
			{pendingRestore ? (
				<div className="flex flex-col gap-2 px-4 pt-1 pb-6">
					<Pressable
						onClick={() => void confirmRestore()}
						disabled={isRestoring}
						scale
						haptic={false}
						className="flex h-12 w-full items-center justify-center rounded-xl bg-primary font-semibold text-base text-primary-foreground"
					>
						{isRestoring
							? m.vaults_detail_items_password_history_dialog_restore_dialog_action_restoring()
							: m.vaults_detail_items_password_history_dialog_restore_dialog_action_restore()}
					</Pressable>
					<Pressable
						onClick={closeConfirm}
						disabled={isRestoring}
						surface="sheet"
						className="flex h-12 w-full items-center justify-center rounded-xl bg-surface-tertiary font-medium text-base text-foreground"
					>
						{m.vaults_detail_items_detail_action_cancel()}
					</Pressable>
				</div>
			) : (
				<div className="native-scroll max-h-[60dvh] overflow-y-auto px-4 pt-1 pb-6">
					<ListCard>
						{history.length === 0 ? (
							<p className="px-4 py-6 text-center text-muted-foreground text-sm">
								{m.vaults_detail_items_password_history_dialog_empty()}
							</p>
						) : (
							history.map((entry) => (
								<HistoryRow
									key={`${entry.password}-${entry.changedAt}`}
									changedAt={formatChangedAt(entry.changedAt, locale)}
									isCurrent={entry.password === currentPassword}
									isRestoring={isRestoring}
									onCopy={() =>
										void onCopy(
											entry.password,
											m.vaults_detail_items_copy_label_password(),
										)
									}
									onRestore={() => setPendingRestore(entry)}
								/>
							))
						)}
					</ListCard>
				</div>
			)}
		</MobileSheet>
	);
}

function HistoryRow({
	changedAt,
	isCurrent,
	isRestoring,
	onCopy,
	onRestore,
}: {
	changedAt: string;
	isCurrent: boolean;
	isRestoring: boolean;
	onCopy: () => void;
	onRestore: () => void;
}) {
	const { m } = useI18n();

	return (
		<div className="flex items-center gap-2 px-4 py-3">
			<div className="min-w-0 flex-1">
				<p className="truncate font-mono text-base text-foreground tracking-wider">
					{MASK}
				</p>
				<p className="mt-0.5 truncate text-muted-foreground text-sm">
					{isCurrent
						? m.vaults_detail_items_password_history_dialog_action_current()
						: changedAt}
				</p>
			</div>
			<Pressable
				onClick={onCopy}
				aria-label={m.vaults_detail_items_password_history_dialog_action_copy()}
				className="flex size-11 shrink-0 items-center justify-center rounded-full"
			>
				<IconCopy className={`${iconClass.row} text-muted-foreground`} />
			</Pressable>
			<Pressable
				onClick={onRestore}
				disabled={isCurrent || isRestoring}
				aria-label={m.vaults_detail_items_password_history_dialog_action_restore()}
				className="flex size-11 shrink-0 items-center justify-center rounded-full"
			>
				{isCurrent ? (
					<IconCheck className={`${iconClass.row} text-success`} />
				) : (
					<IconArchiveRestore className={`${iconClass.row} text-primary`} />
				)}
			</Pressable>
		</div>
	);
}
