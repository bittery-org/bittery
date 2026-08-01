import { useQueryInvalidator } from "@bittery/core/hooks";
import { useI18n } from "@bittery/i18n/react";
import { useRPC, useRPCClient } from "@bittery/shared/rpc";
import {
	IconCalendar,
	IconCircleAlert,
	IconClock,
	IconEarth,
	IconMail,
	IconEye,
	IconLink,
	IconLoaderCircle,
	IconShieldCheck,
	IconTrash,
	IconUsers,
} from "@bittery/ui/icons";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
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
import { Badge } from "../badge";
import { Button } from "../button";
import { Card, CardContent } from "../card";
import { cn } from "../../lib/utils";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../dialog";
import { ScrollArea } from "../scroll-area";
import { Skeleton } from "../skeleton";
import { toast } from "../sonner";

interface ShareLinksListProps {
	itemId: string;
}

interface ShareLinkData {
	id: string;
	status: "active" | "expired" | "exhausted" | "revoked";
	accessMode: "anyone" | "email-restricted";
	isOneTimeUse: boolean;
	accessCount: number;
	maxAccessCount: number | null;
	allowedEmails: { email: string; verified: boolean }[];
	expiresAt: string;
	createdAt: string;
	lastAccessedAt: string | null;
}

type ShareLinkStatus = ShareLinkData["status"];
type ShareLinkAccessMode = ShareLinkData["accessMode"];

const STATUS_COLORS: Record<string, string> = {
	active: "bg-green-500",
	expired: "bg-gray-500",
	exhausted: "bg-amber-500",
	revoked: "bg-red-500",
};

function normalizeShareLinkStatus(status: string): ShareLinkStatus {
	switch (status) {
		case "active":
		case "expired":
		case "exhausted":
		case "revoked":
			return status;
		default:
			return "revoked";
	}
}

function normalizeShareLinkAccessMode(accessMode: string): ShareLinkAccessMode {
	return accessMode === "email-restricted"
		? "email-restricted"
		: "anyone";
}

export function ShareLinksList({ itemId }: ShareLinksListProps) {
	const { m } = useI18n();
	const [selectedLink, setSelectedLink] = useState<ShareLinkData | null>(null);
	const [showAccessLogs, setShowAccessLogs] = useState(false);
	const [linkToRevoke, setLinkToRevoke] = useState<string | null>(null);

	const rpc = useRPC();
	const rpcClient = useRPCClient();
	const invalidator = useQueryInvalidator();

	const linksQuery = useQuery(rpc.share.listByItem.queryOptions({ itemId }));

	const revokeMutation = useMutation({
		mutationFn: (linkId: string) => rpcClient.share.revoke.mutate({ linkId }),
		onSuccess: async () => {
			toast.success(m.sharing_links_list_toast_revoke_success());
			await invalidator.invalidateShare(itemId);
			setLinkToRevoke(null);
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

	const accessLogsQuery = useQuery({
		...rpc.share.getAccessLogs.queryOptions({
			linkId: selectedLink?.id || "",
		}),
		enabled: !!selectedLink && showAccessLogs,
	});

	const getStatusLabel = (status: ShareLinkStatus) => {
		switch (status) {
			case "active":
				return m.sharing_links_list_status_active();
			case "expired":
				return m.sharing_links_list_status_expired();
			case "exhausted":
				return m.sharing_links_list_status_exhausted();
			case "revoked":
				return m.sharing_links_list_status_revoked();
			default:
				return status;
		}
	};

	const getAccessCountLabel = (
		count: number,
		maxAccessCount: number | null,
	) => {
		if (maxAccessCount !== null) {
			return count === 1
				? m.sharing_links_list_access_count_with_limit_single({
						count,
						max: maxAccessCount,
					})
				: m.sharing_links_list_access_count_with_limit_plural({
						count,
						max: maxAccessCount,
					});
		}
		return count === 1
			? m.sharing_links_list_access_count_single({ count })
			: m.sharing_links_list_access_count_plural({ count });
	};

	const formatDate = (date: string) => {
		return new Date(date).toLocaleDateString(undefined, {
			month: "short",
			day: "numeric",
			year: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	};

	const formatRelativeTime = (date: string) => {
		const now = new Date();
		const diff = new Date(date).getTime() - now.getTime();

		if (diff < 0) return m.sharing_links_list_status_expired();

		const hours = Math.floor(diff / (1000 * 60 * 60));
		const days = Math.floor(hours / 24);

		if (days > 0) {
			return days === 1
				? m.sharing_links_list_relative_days_left_single({ count: days })
				: m.sharing_links_list_relative_days_left_plural({ count: days });
		}
		if (hours > 0) {
			return hours === 1
				? m.sharing_links_list_relative_hours_left_single({ count: hours })
				: m.sharing_links_list_relative_hours_left_plural({ count: hours });
		}
		return m.sharing_links_list_relative_less_than_hour();
	};

	if (linksQuery.isLoading) {
		return (
			<div className="space-y-2">
				<Skeleton className="h-20" />
				<Skeleton className="h-20" />
			</div>
		);
	}

	// Mapped field-by-field on purpose: the share token must never be threaded
	// into the client model. A token without its fragment key is a dead link,
	// so there is nothing this list could usefully do with it.
	const links: ShareLinkData[] = (linksQuery.data?.links || []).map((link) => ({
		id: link.id,
		status: normalizeShareLinkStatus(link.status),
		accessMode: normalizeShareLinkAccessMode(link.accessMode),
		isOneTimeUse: link.isOneTimeUse,
		accessCount: link.accessCount,
		maxAccessCount: link.maxAccessCount,
		allowedEmails: link.allowedEmails,
		expiresAt: link.expiresAt,
		createdAt: link.createdAt,
		lastAccessedAt: link.lastAccessedAt,
	}));

	if (links.length === 0) {
		return (
			<Card>
				<CardContent className="flex flex-col items-center justify-center py-8">
					<IconLink className="mb-4 h-8 w-8 text-muted-foreground" />
					<p className="text-muted-foreground text-sm">
						{m.sharing_links_list_empty_links()}
					</p>
				</CardContent>
			</Card>
		);
	}

	return (
		<>
			<div className="space-y-3">
				<p className="flex items-start gap-2 text-muted-foreground text-xs">
					<IconCircleAlert
						aria-hidden
						className="mt-px size-3.5 shrink-0"
					/>
					<span>{m.sharing_links_list_copy_once_explainer()}</span>
				</p>
				{links.map((link) => (
					<Card
						key={link.id}
						className={cn("py-0", link.status !== "active" ? "opacity-60" : "")}
					>
						<CardContent className="p-4">
							<div className="flex items-start justify-between">
								<div className="flex-1 space-y-2">
									<div className="flex items-center gap-2">
										<Badge
											variant="outline"
											className="flex items-center gap-1"
										>
											<span
												className={cn(
													"h-2",
													"w-2",
													"rounded-full",
													STATUS_COLORS[link.status],
												)}
											/>
											{getStatusLabel(link.status)}
										</Badge>
										<Badge variant="secondary">
											{link.accessMode === "anyone" ? (
												<>
													<IconEarth className="mr-1 h-3 w-3" />
													{m.sharing_links_list_access_mode_anyone()}
												</>
											) : (
												<>
													<IconMail className="mr-1 h-3 w-3" />
													{m.sharing_links_list_access_mode_email_restricted()}
												</>
											)}
										</Badge>
										{link.isOneTimeUse && (
											<Badge variant="secondary">
												<IconShieldCheck className="mr-1 h-3 w-3" />
												{m.sharing_links_list_badge_one_time()}
											</Badge>
										)}
									</div>

									<div className="flex flex-wrap gap-4 text-muted-foreground text-xs">
										<span className="flex items-center gap-1">
											<IconEye className="h-3 w-3" />
											{getAccessCountLabel(
												link.accessCount,
												link.maxAccessCount ?? null,
											)}
										</span>
										<span className="flex items-center gap-1">
											<IconClock className="h-3 w-3" />
											{link.status === "active"
												? formatRelativeTime(link.expiresAt)
												: m.sharing_links_list_label_expires_at({
														date: formatDate(link.expiresAt),
													})}
										</span>
										<span className="flex items-center gap-1">
											<IconCalendar className="h-3 w-3" />
											{m.sharing_links_list_label_created_at({
												date: formatDate(link.createdAt),
											})}
										</span>
									</div>

									{link.accessMode === "email-restricted" &&
										link.allowedEmails.length > 0 && (
											<div className="flex flex-wrap gap-1 pt-1">
												{link.allowedEmails.map((e) => (
													<Badge
														key={e.email}
														variant={e.verified ? "default" : "outline"}
														className="text-xs"
													>
														{e.email}
														{e.verified &&
															m.sharing_links_list_allowed_email_verified_suffix()}
													</Badge>
												))}
											</div>
										)}
								</div>

								<div className="flex items-center gap-1">
									<Button
										size="sm"
										variant="ghost"
										onClick={() => {
											setSelectedLink(link);
											setShowAccessLogs(true);
										}}
										title={m.sharing_links_list_action_view_access_logs()}
									>
										<IconUsers className="h-4 w-4" />
									</Button>
									{link.status === "active" && (
										<Button
											size="sm"
											variant="ghost"
											onClick={() => setLinkToRevoke(link.id)}
											className="text-destructive hover:bg-destructive/10 hover:text-destructive"
											title={m.sharing_links_list_action_revoke_link()}
										>
											<IconTrash className="h-4 w-4" />
										</Button>
									)}
								</div>
							</div>
						</CardContent>
					</Card>
				))}
			</div>

			<Dialog open={showAccessLogs} onOpenChange={setShowAccessLogs}>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>{m.sharing_links_list_logs_title()}</DialogTitle>
						<DialogDescription>
							{m.sharing_links_list_logs_description()}
						</DialogDescription>
					</DialogHeader>

					<ScrollArea className="max-h-96">
						{accessLogsQuery.isLoading ? (
							<div className="space-y-2">
								<Skeleton className="h-12" />
								<Skeleton className="h-12" />
								<Skeleton className="h-12" />
							</div>
						) : accessLogsQuery.data && accessLogsQuery.data.length > 0 ? (
							<div className="space-y-2">
								{accessLogsQuery.data.map((log) => (
									<Card key={log.id}>
										<CardContent className="p-3">
											<div className="flex items-start justify-between">
												<div className="space-y-1">
													<div className="flex items-center gap-2">
														<Badge
															variant={log.success ? "default" : "destructive"}
														>
															{log.success
																? m.sharing_links_list_logs_status_success()
																: m.sharing_links_list_logs_status_failed()}
														</Badge>
														{log.accessedByEmail && (
															<span className="text-sm">
																{log.accessedByEmail}
															</span>
														)}
													</div>
													<p className="text-muted-foreground text-xs">
														{formatDate(log.accessedAt)}
													</p>
													{log.ipAddress && (
														<p className="text-muted-foreground text-xs">
															{m.sharing_links_list_logs_ip({
																ipAddress: log.ipAddress,
															})}
														</p>
													)}
													{log.failureReason && (
														<p className="text-destructive text-xs">
															{log.failureReason}
														</p>
													)}
												</div>
											</div>
										</CardContent>
									</Card>
								))}
							</div>
						) : (
							<div className="py-8 text-center">
								<IconEye className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
								<p className="text-muted-foreground text-sm">
									{m.sharing_links_list_empty_logs()}
								</p>
							</div>
						)}
					</ScrollArea>
				</DialogContent>
			</Dialog>

			<AlertDialog
				open={!!linkToRevoke}
				onOpenChange={(open) => !open && setLinkToRevoke(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{m.sharing_links_list_revoke_dialog_title()}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{m.sharing_links_list_revoke_dialog_description()}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							{m.sharing_links_list_action_cancel()}
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={() =>
								linkToRevoke && revokeMutation.mutate(linkToRevoke)
							}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							{revokeMutation.isPending ? (
								<IconLoaderCircle className="h-4 w-4 animate-spin" />
							) : (
								<IconTrash className="h-4 w-4" />
							)}
							{m.sharing_links_list_action_revoke_link()}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
