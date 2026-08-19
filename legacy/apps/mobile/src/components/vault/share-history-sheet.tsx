/**
 * Every share link ever created for one item: status, expiry, access count, revoke, and the
 * per-link access log.
 *
 * Mobile's own presentation of `@bittery/ui`'s `ShareHistoryDialog` + `ShareLinksList`, which
 * are a `Dialog` of `Card`s with a nested `Dialog` for the logs — two stacked modals and a
 * `max-h-[80vh]` that leaves no room on a phone. The data path is identical to desktop's
 * (`apiQueries.shares.list`, `api.share.remove`, `api.share.accessLogs`) and so is the copy;
 * only the chrome is rebuilt.
 *
 * The links themselves are never shown, because they cannot be: the decryption key lives only
 * in the URL handed over at creation time and the server stores none of it. This screen manages
 * links, it does not hand them out again — `sharing_links_list_copy_once_explainer` says so at
 * the top so the absence does not read as a bug.
 */

import { useQueryInvalidator } from "@bittery/core/hooks";
import { createStoredAccountApiClient } from "@bittery/core/services/api-client";
import { apiQueryKeys } from "@bittery/shared/api-query";
import { Skeleton, toast } from "@bittery/ui";
import {
	IconCircleAlert,
	IconEarth,
	IconEye,
	IconLink,
	IconMail,
	IconTrash,
} from "@bittery/ui/icons";
import { cn } from "@bittery/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
	ConfirmSheet,
	EmptyState,
	IconTile,
	iconClass,
	ListCard,
	ListRow,
	MobileSheet,
	Pressable,
} from "@/components/ui";
import { storage } from "@/lib/storage";
import { useI18n } from "@/providers/i18n-provider";

type Messages = ReturnType<typeof useI18n>["m"];

type ShareLinkStatus = "active" | "expired" | "exhausted" | "revoked";

/** The dot colours desktop's `ShareLinksList` uses, kept identical so status reads the same. */
const STATUS_DOT: Record<ShareLinkStatus, string> = {
	active: "bg-success",
	expired: "bg-muted-foreground",
	exhausted: "bg-warning",
	revoked: "bg-danger",
};

function getStatusLabel(status: ShareLinkStatus, m: Messages) {
	switch (status) {
		case "expired":
			return m.sharing_links_list_status_expired();
		case "exhausted":
			return m.sharing_links_list_status_exhausted();
		case "revoked":
			return m.sharing_links_list_status_revoked();
		default:
			return m.sharing_links_list_status_active();
	}
}

function formatDate(value: string): string {
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

interface ShareHistorySheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	itemId: string;
	/** The account the item belongs to, which is not always the active one on mobile. */
	accountId: string;
}

export function ShareHistorySheet({
	open,
	onOpenChange,
	itemId,
	accountId,
}: ShareHistorySheetProps) {
	const { m } = useI18n();
	const invalidator = useQueryInvalidator();

	const [linkPendingRevoke, setLinkPendingRevoke] = useState<string | null>(
		null,
	);
	const [isRevoking, setIsRevoking] = useState(false);
	const [logsLinkId, setLogsLinkId] = useState<string | null>(null);

	/**
	 * A client for the *item's* account, not the app-level `useApiClient` that desktop's
	 * `ItemDetailPage` uses. Desktop can get away with the ambient one because its detail page
	 * only ever shows the active account's items; mobile's Items tab is cross-account, so an
	 * item from the second account would otherwise have its links listed — and revoked —
	 * against the first account's session.
	 */
	const accountApi = async () => {
		const client = await createStoredAccountApiClient(storage, accountId);
		if (!client) throw new Error("Account session is not available");
		return client;
	};

	const shareLinks = useQuery({
		queryKey: [...apiQueryKeys.shares.list(itemId), accountId],
		queryFn: async () => (await (await accountApi()).share.list(itemId)).data,
		enabled: open && Boolean(itemId) && Boolean(accountId),
		// Revoking elsewhere must not leave a stale "active" here: this list is short and only
		// fetched while the sheet is open, so always refetching costs nothing.
		staleTime: 0,
	});
	const links = shareLinks.data?.links ?? [];

	const accessLogs = useQuery({
		queryKey: [...apiQueryKeys.shares.accessLogs(logsLinkId ?? ""), accountId],
		queryFn: async () =>
			(await (await accountApi()).share.accessLogs(logsLinkId ?? "")).data,
		enabled: Boolean(logsLinkId),
	});

	const handleRevoke = async () => {
		if (!linkPendingRevoke) return;
		setIsRevoking(true);
		try {
			await (await accountApi()).share.remove(linkPendingRevoke);
			await invalidator.invalidateShare(itemId);
			await shareLinks.refetch();
			toast.success(m.sharing_links_list_toast_revoke_success());
			setLinkPendingRevoke(null);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: m.sharing_links_list_toast_revoke_error(),
			);
		} finally {
			setIsRevoking(false);
		}
	};

	return (
		<>
			<MobileSheet
				open={open && logsLinkId === null}
				onOpenChange={onOpenChange}
				title={m.mob_share_history_title()}
				description={m.mob_share_history_description()}
			>
				<div className="flex flex-col gap-4 px-4 pt-1 pb-6">
					{shareLinks.isLoading ? (
						<div className="flex flex-col gap-2">
							{[0, 1, 2].map((row) => (
								<Skeleton key={row} className="h-20 rounded-2xl" />
							))}
						</div>
					) : links.length === 0 ? (
						<EmptyState
							icon={IconLink}
							title={m.sharing_links_list_empty_links()}
							description={m.sharing_links_list_copy_once_explainer()}
						/>
					) : (
						<>
							<p className="text-muted-foreground text-xs">
								{m.sharing_links_list_copy_once_explainer()}
							</p>
							<div className="flex flex-col gap-3">
								{links.map((link) => (
									<ShareLinkCard
										key={link.id}
										link={link}
										onViewLogs={() => setLogsLinkId(link.id)}
										onRevoke={() => setLinkPendingRevoke(link.id)}
									/>
								))}
							</div>
						</>
					)}
				</div>
			</MobileSheet>

			<MobileSheet
				open={logsLinkId !== null}
				onOpenChange={(next) => {
					if (!next) setLogsLinkId(null);
				}}
				title={m.sharing_links_list_logs_title()}
				description={m.sharing_links_list_logs_description()}
			>
				<div className="flex flex-col gap-3 px-4 pt-1 pb-6">
					{accessLogs.isLoading ? (
						<div className="flex flex-col gap-2">
							{[0, 1].map((row) => (
								<Skeleton key={row} className="h-14 rounded-2xl" />
							))}
						</div>
					) : (accessLogs.data?.length ?? 0) === 0 ? (
						<EmptyState
							icon={IconEye}
							title={m.mob_share_history_logs_empty()}
						/>
					) : (
						<ListCard>
							{(accessLogs.data ?? []).map((log) => (
								<ListRow
									key={log.id}
									leading={
										<IconTile tone={log.success ? "default" : "danger"}>
											{log.success ? (
												<IconEye className={iconClass.row} />
											) : (
												<IconCircleAlert className={iconClass.row} />
											)}
										</IconTile>
									}
									title={
										log.accessedByEmail ??
										(log.success
											? m.sharing_links_list_logs_status_success()
											: m.sharing_links_list_logs_status_failed())
									}
									subtitle={formatDate(log.accessedAt)}
									value={
										log.ipAddress
											? m.sharing_links_list_logs_ip({
													ipAddress: log.ipAddress,
												})
											: undefined
									}
								/>
							))}
						</ListCard>
					)}
					<Pressable
						onClick={() => setLogsLinkId(null)}
						surface="sheet"
						className="flex h-11 w-full items-center justify-center rounded-xl bg-surface-tertiary font-medium text-base text-foreground"
					>
						{m.mob_share_history_action_close()}
					</Pressable>
				</div>
			</MobileSheet>

			<ConfirmSheet
				open={linkPendingRevoke !== null}
				onOpenChange={(next) => {
					if (!next && !isRevoking) setLinkPendingRevoke(null);
				}}
				title={m.sharing_links_list_revoke_dialog_title()}
				description={m.sharing_links_list_revoke_dialog_description()}
				confirmLabel={m.sharing_links_list_action_revoke_link()}
				cancelLabel={m.sharing_links_list_action_cancel()}
				onConfirm={() => void handleRevoke()}
				isPending={isRevoking}
			/>
		</>
	);
}

interface ShareLinkCardProps {
	link: {
		id: string;
		status: ShareLinkStatus;
		accessMode: "anyone" | "email-restricted";
		isOneTimeUse: boolean;
		accessCount: number;
		maxAccessCount?: number | null;
		expiresAt: string;
		createdAt: string;
	};
	onViewLogs: () => void;
	onRevoke: () => void;
}

function ShareLinkCard({ link, onViewLogs, onRevoke }: ShareLinkCardProps) {
	const { m } = useI18n();
	const isRevocable = link.status === "active";

	const accessCountLabel =
		link.maxAccessCount != null
			? link.accessCount === 1
				? m.sharing_links_list_access_count_with_limit_single({
						count: String(link.accessCount),
						max: String(link.maxAccessCount),
					})
				: m.sharing_links_list_access_count_with_limit_plural({
						count: String(link.accessCount),
						max: String(link.maxAccessCount),
					})
			: link.accessCount === 1
				? m.sharing_links_list_access_count_single({
						count: String(link.accessCount),
					})
				: m.sharing_links_list_access_count_plural({
						count: String(link.accessCount),
					});

	return (
		<div className="overflow-hidden rounded-2xl border border-border bg-surface">
			<div className="flex items-start gap-3 p-4">
				<IconTile>
					{link.accessMode === "anyone" ? (
						<IconEarth className={iconClass.row} />
					) : (
						<IconMail className={iconClass.row} />
					)}
				</IconTile>
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span
							aria-hidden
							className={cn(
								"size-2 shrink-0 rounded-full",
								STATUS_DOT[link.status],
							)}
						/>
						<span className="truncate font-medium text-base text-foreground">
							{getStatusLabel(link.status, m)}
						</span>
						{link.isOneTimeUse ? (
							<span className="shrink-0 rounded-lg bg-surface-tertiary px-2 py-0.5 font-medium text-2xs text-muted-foreground">
								{m.sharing_links_list_badge_one_time()}
							</span>
						) : null}
					</div>
					<p className="mt-1 text-muted-foreground text-xs">
						{m.sharing_links_list_label_expires_at({
							date: formatDate(link.expiresAt),
						})}
					</p>
					<p className="text-muted-foreground text-xs">
						{m.mob_share_history_created({ date: formatDate(link.createdAt) })}
					</p>
					<p className="mt-1 text-muted-foreground text-xs">
						{accessCountLabel}
					</p>
				</div>
			</div>

			<div className="flex border-separator border-t">
				<Pressable
					onClick={onViewLogs}
					className="flex h-12 flex-1 items-center justify-center gap-2 font-medium text-foreground text-sm"
				>
					<IconEye className={iconClass.chip} />
					{m.sharing_links_list_action_view_access_logs()}
				</Pressable>
				{isRevocable ? (
					<Pressable
						onClick={onRevoke}
						className="flex h-12 flex-1 items-center justify-center gap-2 border-separator border-l font-medium text-danger text-sm"
					>
						<IconTrash className={iconClass.chip} />
						{m.sharing_links_list_action_revoke_link()}
					</Pressable>
				) : null}
			</div>
		</div>
	);
}
