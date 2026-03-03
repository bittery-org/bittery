import { useTRPC, useTRPCClient } from "@bittery/shared/trpc";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	Badge,
	Button,
	Card,
	CardContent,
	cn,
	copyWithToast,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	ScrollArea,
	Skeleton,
	toast,
} from "@bittery/ui";
import {
	IconCalendarOutlineDuo18 as Calendar,
	IconClockTimeOutlineDuo18 as Clock,
	IconCopyOutlineDuo18 as Copy,
	IconEyeOutlineDuo18 as Eye,
	IconEarthOutlineDuo18 as Globe,
	IconLinkOutlineDuo18 as Link,
	IconLoader2OutlineDuo18 as Loader2,
	IconEnvelopeOutlineDuo18 as Mail,
	IconMagicShieldOutlineDuo18 as Shield,
	IconTrash2OutlineDuo18 as Trash2,
	IconUsers6OutlineDuo18 as Users,
} from "@bittery/ui/icons";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useI18n } from "@/providers/i18n-provider";
import { useQueryInvalidator } from "../../providers/sync-provider";

interface ShareLinksListProps {
	itemId: string;
}

interface ShareLinkData {
	id: string;
	token: string;
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

const STATUS_COLORS: Record<string, string> = {
	active: "bg-green-500",
	expired: "bg-gray-500",
	exhausted: "bg-amber-500",
	revoked: "bg-red-500",
};

export function ShareLinksList({ itemId }: ShareLinksListProps) {
	const [selectedLink, setSelectedLink] = useState<ShareLinkData | null>(null);
	const [showAccessLogs, setShowAccessLogs] = useState(false);
	const [linkToRevoke, setLinkToRevoke] = useState<string | null>(null);
	const { m } = useI18n();

	const trpc = useTRPC();
	const trpcClient = useTRPCClient();
	const invalidator = useQueryInvalidator();

	const linksQuery = useQuery(trpc.share.listByItem.queryOptions({ itemId }));

	const revokeMutation = useMutation({
		mutationFn: (linkId: string) => trpcClient.share.revoke.mutate({ linkId }),
		onSuccess: async () => {
			toast.success(m["sharing.links_list.toast.revoke_success"]());
			await invalidator.invalidateShare(itemId);
			setLinkToRevoke(null);
		},
		onError: () => {
			toast.error(m["sharing.links_list.toast.revoke_error"]());
		},
	});

	const accessLogsQuery = useQuery({
		...trpc.share.getAccessLogs.queryOptions({
			linkId: selectedLink?.id || "",
		}),
		enabled: !!selectedLink && showAccessLogs,
	});

	const handleCopyLink = (token: string) => {
		// Note: We cannot regenerate the full link with key since the key is not stored
		// This just copies the base URL - users should copy the original link when created
		const baseUrl = window.location.origin;
		const shareUrl = `${baseUrl}/share/${token}`;
		copyWithToast(shareUrl, m["sharing.common.link_label"](), {
			autoClearMs: 0,
			successMessage: m["sharing.links_list.toast.copy_warning"](),
		});
	};

	const getStatusLabel = (status: ShareLinkStatus) => {
		switch (status) {
			case "active":
				return m["sharing.links_list.status.active"]();
			case "expired":
				return m["sharing.links_list.status.expired"]();
			case "exhausted":
				return m["sharing.links_list.status.exhausted"]();
			case "revoked":
				return m["sharing.links_list.status.revoked"]();
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
				? m["sharing.links_list.access_count_with_limit.single"]({
						count,
						max: maxAccessCount,
					})
				: m["sharing.links_list.access_count_with_limit.plural"]({
						count,
						max: maxAccessCount,
					});
		}

		return count === 1
			? m["sharing.links_list.access_count.single"]({ count })
			: m["sharing.links_list.access_count.plural"]({ count });
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

		if (diff < 0) return m["sharing.links_list.status.expired"]();

		const hours = Math.floor(diff / (1000 * 60 * 60));
		const days = Math.floor(hours / 24);

		if (days > 0) {
			return days === 1
				? m["sharing.links_list.relative.days_left.single"]({ count: days })
				: m["sharing.links_list.relative.days_left.plural"]({ count: days });
		}
		if (hours > 0) {
			return hours === 1
				? m["sharing.links_list.relative.hours_left.single"]({ count: hours })
				: m["sharing.links_list.relative.hours_left.plural"]({ count: hours });
		}
		return m["sharing.links_list.relative.less_than_hour"]();
	};

	if (linksQuery.isLoading) {
		return (
			<div className="space-y-2">
				<Skeleton className="h-20" />
				<Skeleton className="h-20" />
			</div>
		);
	}

	const links = linksQuery.data?.links || [];

	if (links.length === 0) {
		return (
			<Card>
				<CardContent className="flex flex-col items-center justify-center py-8">
					<Link className="mb-4 h-8 w-8 text-muted-foreground" />
					<p className="text-muted-foreground text-sm">
						{m["sharing.links_list.empty.links"]()}
					</p>
				</CardContent>
			</Card>
		);
	}

	return (
		<>
			<div className="space-y-3">
				{links.map((link) => (
					<Card
						key={link.id}
						className={cn("py-0", link.status !== "active" ? "opacity-60" : "")}
					>
						<CardContent className="p-4">
							<div className="flex items-start justify-between">
								<div className="flex-1 space-y-2">
									{/* Status and access mode badges */}
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
													<Globe className="mr-1 h-3 w-3" />
													{m["sharing.links_list.access_mode.anyone"]()}
												</>
											) : (
												<>
													<Mail className="mr-1 h-3 w-3" />
													{m[
														"sharing.links_list.access_mode.email_restricted"
													]()}
												</>
											)}
										</Badge>
										{link.isOneTimeUse && (
											<Badge variant="secondary">
												<Shield className="mr-1 h-3 w-3" />
												{m["sharing.links_list.badge.one_time"]()}
											</Badge>
										)}
									</div>

									{/* Access info */}
									<div className="flex flex-wrap gap-4 text-muted-foreground text-xs">
										<span className="flex items-center gap-1">
											<Eye className="h-3 w-3" />
											{getAccessCountLabel(
												link.accessCount,
												link.maxAccessCount ?? null,
											)}
										</span>
										<span className="flex items-center gap-1">
											<Clock className="h-3 w-3" />
											{link.status === "active"
												? formatRelativeTime(link.expiresAt)
												: m["sharing.links_list.label.expires_at"]({
														date: formatDate(link.expiresAt),
													})}
										</span>
										<span className="flex items-center gap-1">
											<Calendar className="h-3 w-3" />
											{m["sharing.links_list.label.created_at"]({
												date: formatDate(link.createdAt),
											})}
										</span>
									</div>

									{/* Allowed emails */}
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
															m[
																"sharing.links_list.allowed_email.verified_suffix"
															]()}
													</Badge>
												))}
											</div>
										)}
								</div>

								{/* Actions */}
								<div className="flex items-center gap-1">
									<Button
										size="sm"
										variant="ghost"
										onClick={() => handleCopyLink(link.token)}
										title={m["sharing.links_list.action.copy_link"]()}
									>
										<Copy className="h-4 w-4" />
									</Button>
									<Button
										size="sm"
										variant="ghost"
										onClick={() => {
											setSelectedLink(link as ShareLinkData);
											setShowAccessLogs(true);
										}}
										title={m["sharing.links_list.action.view_access_logs"]()}
									>
										<Users className="h-4 w-4" />
									</Button>
									{link.status === "active" && (
										<Button
											size="sm"
											variant="ghost"
											onClick={() => setLinkToRevoke(link.id)}
											className="text-destructive hover:bg-destructive/10 hover:text-destructive"
											title={m["sharing.links_list.action.revoke_link"]()}
										>
											<Trash2 className="h-4 w-4" />
										</Button>
									)}
								</div>
							</div>
						</CardContent>
					</Card>
				))}
			</div>

			{/* Access Logs Dialog */}
			<Dialog open={showAccessLogs} onOpenChange={setShowAccessLogs}>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>{m["sharing.links_list.logs.title"]()}</DialogTitle>
						<DialogDescription>
							{m["sharing.links_list.logs.description"]()}
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
																? m["sharing.links_list.logs.status.success"]()
																: m["sharing.links_list.logs.status.failed"]()}
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
															{m["sharing.links_list.logs.ip"]({
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
								<Eye className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
								<p className="text-muted-foreground text-sm">
									{m["sharing.links_list.empty.logs"]()}
								</p>
							</div>
						)}
					</ScrollArea>
				</DialogContent>
			</Dialog>

			{/* Revoke Confirmation Dialog */}
			<AlertDialog
				open={!!linkToRevoke}
				onOpenChange={(open) => !open && setLinkToRevoke(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{m["sharing.links_list.revoke_dialog.title"]()}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{m["sharing.links_list.revoke_dialog.description"]()}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							{m["sharing.links_list.action.cancel"]()}
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={() =>
								linkToRevoke && revokeMutation.mutate(linkToRevoke)
							}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							{revokeMutation.isPending ? (
								<Loader2 className="mr-2 h-4 w-4 animate-spin" />
							) : (
								<Trash2 className="mr-2 h-4 w-4" />
							)}
							{m["sharing.links_list.action.revoke_link"]()}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
