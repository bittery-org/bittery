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
	IconCalendarOutlineDuo18,
	IconClockTimeOutlineDuo18,
	IconCopyOutlineDuo18,
	IconEarthOutlineDuo18,
	IconEnvelopeOutlineDuo18,
	IconEyeOutlineDuo18,
	IconLinkOutlineDuo18,
	IconLoader2OutlineDuo18,
	IconMagicShieldOutlineDuo18,
	IconTrash2OutlineDuo18,
	IconUsers6OutlineDuo18,
} from "@bittery/ui/icons";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
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

const STATUS_COLORS: Record<string, string> = {
	active: "bg-green-500",
	expired: "bg-gray-500",
	exhausted: "bg-amber-500",
	revoked: "bg-red-500",
};

const STATUS_LABELS: Record<string, string> = {
	active: "Active",
	expired: "Expired",
	exhausted: "Used",
	revoked: "Revoked",
};

export function ShareLinksList({ itemId }: ShareLinksListProps) {
	const [selectedLink, setSelectedLink] = useState<ShareLinkData | null>(null);
	const [showAccessLogs, setShowAccessLogs] = useState(false);
	const [linkToRevoke, setLinkToRevoke] = useState<string | null>(null);

	const trpc = useTRPC();
	const trpcClient = useTRPCClient();
	const invalidator = useQueryInvalidator();

	const linksQuery = useQuery(trpc.share.listByItem.queryOptions({ itemId }));

	const revokeMutation = useMutation({
		mutationFn: (linkId: string) => trpcClient.share.revoke.mutate({ linkId }),
		onSuccess: async () => {
			toast.success("Share link revoked");
			await invalidator.invalidateShare(itemId);
			setLinkToRevoke(null);
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

	const accessLogsQuery = useQuery({
		...trpc.share.getAccessLogs.queryOptions({
			linkId: selectedLink?.id || "",
		}),
		enabled: !!selectedLink && showAccessLogs,
	});

	const handleCopyLink = (token: string) => {
		// Use the baseShareUrl from the API response
		const baseShareUrl = linksQuery.data?.baseShareUrl || "";
		const shareUrl = `${baseShareUrl}${token}`;
		copyWithToast(shareUrl, "Link", {
			autoClearMs: 0,
			successMessage:
				"Link copied (note: you'll need the original link with decryption key)",
		});
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

		if (diff < 0) return "Expired";

		const hours = Math.floor(diff / (1000 * 60 * 60));
		const days = Math.floor(hours / 24);

		if (days > 0) return `${days} day${days !== 1 ? "s" : ""} left`;
		if (hours > 0) return `${hours} hour${hours !== 1 ? "s" : ""} left`;
		return "Less than an hour";
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
					<IconLinkOutlineDuo18 className="mb-4 h-8 w-8 text-muted-foreground" />
					<p className="text-muted-foreground text-sm">
						No share links created yet
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
											{STATUS_LABELS[link.status]}
										</Badge>
										<Badge variant="secondary">
											{link.accessMode === "anyone" ? (
												<>
													<IconEarthOutlineDuo18 className="mr-1 h-3 w-3" />
													Anyone
												</>
											) : (
												<>
													<IconEnvelopeOutlineDuo18 className="mr-1 h-3 w-3" />
													Email restricted
												</>
											)}
										</Badge>
										{link.isOneTimeUse && (
											<Badge variant="secondary">
												<IconMagicShieldOutlineDuo18 className="mr-1 h-3 w-3" />
												One-time
											</Badge>
										)}
									</div>

									{/* Access info */}
									<div className="flex flex-wrap gap-4 text-muted-foreground text-xs">
										<span className="flex items-center gap-1">
											<IconEyeOutlineDuo18 className="h-3 w-3" />
											{link.accessCount} access
											{link.accessCount !== 1 ? "es" : ""}
											{link.maxAccessCount && ` / ${link.maxAccessCount}`}
										</span>
										<span className="flex items-center gap-1">
											<IconClockTimeOutlineDuo18 className="h-3 w-3" />
											{link.status === "active"
												? formatRelativeTime(link.expiresAt)
												: `Expires: ${formatDate(link.expiresAt)}`}
										</span>
										<span className="flex items-center gap-1">
											<IconCalendarOutlineDuo18 className="h-3 w-3" />
											Created: {formatDate(link.createdAt)}
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
														{e.verified && " (verified)"}
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
										title="Copy link"
									>
										<IconCopyOutlineDuo18 className="h-4 w-4" />
									</Button>
									<Button
										size="sm"
										variant="ghost"
										onClick={() => {
											setSelectedLink(link as ShareLinkData);
											setShowAccessLogs(true);
										}}
										title="View access logs"
									>
										<IconUsers6OutlineDuo18 className="h-4 w-4" />
									</Button>
									{link.status === "active" && (
										<Button
											size="sm"
											variant="ghost"
											onClick={() => setLinkToRevoke(link.id)}
											className="text-destructive hover:bg-destructive/10 hover:text-destructive"
											title="Revoke link"
										>
											<IconTrash2OutlineDuo18 className="h-4 w-4" />
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
						<DialogTitle>Access Logs</DialogTitle>
						<DialogDescription>
							View who has accessed this share link.
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
															{log.success ? "Success" : "Failed"}
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
															IP: {log.ipAddress}
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
								<IconEyeOutlineDuo18 className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
								<p className="text-muted-foreground text-sm">
									No access logs yet
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
						<AlertDialogTitle>Revoke Share Link?</AlertDialogTitle>
						<AlertDialogDescription>
							This will immediately disable the share link. Anyone with the link
							will no longer be able to access the shared item. This action
							cannot be undone.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() =>
								linkToRevoke && revokeMutation.mutate(linkToRevoke)
							}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							{revokeMutation.isPending ? (
								<IconLoader2OutlineDuo18 className="h-4 w-4 animate-spin" />
							) : (
								<IconTrash2OutlineDuo18 className="h-4 w-4" />
							)}
							Revoke Link
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
