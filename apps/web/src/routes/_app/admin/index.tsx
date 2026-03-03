import { useTRPC, useTRPCClient } from "@bittery/shared/trpc";
import {
	Badge,
	Button,
	Card,
	CardContent,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	Input,
	ScrollArea,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Skeleton,
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@bittery/ui";
import {
	IconHistoryOutlineDuo18 as History,
	IconLoader2OutlineDuo18 as Loader2,
	IconMagnifier3OutlineDuo18 as Search,
} from "@bittery/ui/icons";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useMemo, useState } from "react";

type ActionGroup =
	| "all"
	| "auth"
	| "team"
	| "vault"
	| "item"
	| "share"
	| "other";
type ResultFilter = "all" | "success" | "failure";

interface TeamEvent {
	id: string;
	timestamp: string;
	source: "audit_log" | "share_access_log";
	action: string;
	actionGroup: "auth" | "team" | "vault" | "item" | "share" | "other";
	actor: {
		userId: string | null;
		name: string | null;
		email: string | null;
	};
	entity: {
		type: string | null;
		id: string | null;
	};
	result: "success" | "failure";
	network: {
		maskedIp: string | null;
		maskedUserAgent: string | null;
		fullIp: string | null;
		fullUserAgent: string | null;
	};
	metadata: Record<string, unknown> | null;
}

interface Filters {
	actionGroup: ActionGroup;
	result: ResultFilter;
	actorUserId: string;
	search: string;
	from: string;
	to: string;
}

const DEFAULT_LIMIT = 50;

function toLocalDateTimeValue(date: Date): string {
	const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
	return localDate.toISOString().slice(0, 16);
}

function defaultFilters(): Filters {
	const now = new Date();
	const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
	return {
		actionGroup: "all",
		result: "all",
		actorUserId: "all",
		search: "",
		from: toLocalDateTimeValue(fourteenDaysAgo),
		to: toLocalDateTimeValue(now),
	};
}

function toIso(value: string): string | undefined {
	if (!value) return undefined;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return undefined;
	return date.toISOString();
}

function formatAction(action: string): string {
	return action
		.replaceAll("_", " ")
		.replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatTimestamp(value: string): string {
	return new Date(value).toLocaleString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export const Route = createFileRoute("/_app/admin/")({
	beforeLoad: async ({ context }) => {
		const access = await context.queryClient.ensureQueryData(
			context.trpc.billing.entitlements.queryOptions(),
		);

		if (access.mode !== "cloud") {
			throw redirect({ to: "/home" });
		}

		if (access.plan !== "team" || !access.entitlements.team_management) {
			throw redirect({ to: "/billing" });
		}

		const me = await context.queryClient.ensureQueryData(
			context.trpc.auth.me.queryOptions(),
		);

		if (me.role !== "owner" && me.role !== "admin") {
			throw redirect({ to: "/team" });
		}
	},
	component: TeamAdminConsolePage,
	head: () => ({
		meta: [{ title: "Admin Console - Bittery" }],
	}),
});

function TeamAdminConsolePage() {
	const trpc = useTRPC();
	const trpcClient = useTRPCClient();
	const [filters, setFilters] = useState<Filters>(defaultFilters);
	const [selectedEvent, setSelectedEvent] = useState<TeamEvent | null>(null);

	const teamListQuery = useQuery(trpc.team.list.queryOptions());
	const teamId = teamListQuery.data?.id;
	const membersQuery = useQuery({
		...trpc.team.members.list.queryOptions({ teamId: teamId || "" }),
		enabled: !!teamId,
	});

	const eventsQuery = useInfiniteQuery({
		queryKey: ["admin-team-events", filters],
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam }) =>
			trpcClient.audit.teamEvents.query({
				limit: DEFAULT_LIMIT,
				cursor: pageParam,
				actionGroup: filters.actionGroup,
				result: filters.result,
				actorUserId:
					filters.actorUserId !== "all" ? filters.actorUserId : undefined,
				search: filters.search.trim() || undefined,
				from: toIso(filters.from),
				to: toIso(filters.to),
			}),
		getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
	});

	const allEvents = useMemo(
		() => eventsQuery.data?.pages.flatMap((page) => page.events) ?? [],
		[eventsQuery.data],
	);

	const updateFilters = (next: Partial<Filters>) => {
		setFilters((current) => ({ ...current, ...next }));
	};

	return (
		<div className="mx-auto flex w-full max-w-7xl flex-col gap-6 pb-3">
			<section className="relative overflow-hidden rounded-2xl border bg-card p-6 sm:p-7">
				<div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-muted/60 via-transparent to-transparent" />
				<div className="pointer-events-none absolute -top-24 right-0 h-56 w-56 rounded-full bg-muted/50 blur-3xl" />

				<div className="relative space-y-4">
					<div className="flex items-center gap-3">
						<div className="rounded-xl border bg-background/80 p-2.5">
							<History className="h-5 w-5 text-primary" />
						</div>
						<div>
							<h1 className="font-bold text-3xl tracking-tight">
								Admin Console
							</h1>
							<p className="text-muted-foreground text-sm">
								Team-level security events and share access activity.
							</p>
						</div>
					</div>

					<div className="grid gap-3 md:grid-cols-2 lg:grid-cols-6">
						<div className="relative md:col-span-2">
							<Search className="-translate-y-1/2 absolute top-1/2 left-3 h-4 w-4 text-muted-foreground" />
							<Input
								value={filters.search}
								onChange={(event) => updateFilters({ search: event.target.value })}
								placeholder="Search action, entity, email"
								className="pl-9"
							/>
						</div>

						<Select
							value={filters.actionGroup}
							onValueChange={(value) =>
								updateFilters({ actionGroup: value as ActionGroup })
							}
						>
							<SelectTrigger>
								<SelectValue placeholder="Action Group" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">All Actions</SelectItem>
								<SelectItem value="auth">Auth</SelectItem>
								<SelectItem value="team">Team</SelectItem>
								<SelectItem value="vault">Vault</SelectItem>
								<SelectItem value="item">Item</SelectItem>
								<SelectItem value="share">Share</SelectItem>
								<SelectItem value="other">Other</SelectItem>
							</SelectContent>
						</Select>

						<Select
							value={filters.result}
							onValueChange={(value) =>
								updateFilters({ result: value as ResultFilter })
							}
						>
							<SelectTrigger>
								<SelectValue placeholder="Result" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">All Results</SelectItem>
								<SelectItem value="success">Success</SelectItem>
								<SelectItem value="failure">Failure</SelectItem>
							</SelectContent>
						</Select>

						<Select
							value={filters.actorUserId}
							onValueChange={(value) => updateFilters({ actorUserId: value })}
						>
							<SelectTrigger>
								<SelectValue placeholder="Actor" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">All Actors</SelectItem>
								{membersQuery.data?.map((member) => (
									<SelectItem key={member.userId} value={member.userId}>
										{member.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>

						<Button
							variant="outline"
							onClick={() => setFilters(defaultFilters())}
						>
							Reset
						</Button>
					</div>

					<div className="grid gap-3 md:grid-cols-2 lg:max-w-xl">
						<Input
							type="datetime-local"
							value={filters.from}
							onChange={(event) => updateFilters({ from: event.target.value })}
						/>
						<Input
							type="datetime-local"
							value={filters.to}
							onChange={(event) => updateFilters({ to: event.target.value })}
						/>
					</div>
				</div>
			</section>

			<Card>
				<CardContent className="space-y-4 p-4">
					{eventsQuery.isLoading ? (
						<div className="space-y-2">
							<Skeleton className="h-12 w-full" />
							<Skeleton className="h-12 w-full" />
							<Skeleton className="h-12 w-full" />
						</div>
					) : allEvents.length === 0 ? (
						<div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
							<History className="h-8 w-8 text-muted-foreground" />
							<p className="font-medium text-sm">No events found</p>
							<p className="text-muted-foreground text-xs">
								Adjust your filters or date range to see more activity.
							</p>
						</div>
					) : (
						<>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Time</TableHead>
										<TableHead>Action</TableHead>
										<TableHead>Actor</TableHead>
										<TableHead>Entity</TableHead>
										<TableHead>Result</TableHead>
										<TableHead>Network</TableHead>
										<TableHead className="w-[90px]" />
									</TableRow>
								</TableHeader>
								<TableBody>
									{allEvents.map((event) => (
										<TableRow key={`${event.source}-${event.id}`}>
											<TableCell className="text-muted-foreground text-xs">
												{formatTimestamp(event.timestamp)}
											</TableCell>
											<TableCell>
												<div className="flex flex-col gap-1">
													<span className="font-medium text-sm">
														{formatAction(event.action)}
													</span>
													<Badge variant="outline" className="w-fit capitalize">
														{event.actionGroup}
													</Badge>
												</div>
											</TableCell>
											<TableCell className="text-sm">
												{event.actor.email || event.actor.name || "Unknown"}
											</TableCell>
											<TableCell className="text-xs">
												{event.entity.type && event.entity.id
													? `${event.entity.type}:${event.entity.id.slice(0, 8)}`
													: "—"}
											</TableCell>
											<TableCell>
												<Badge
													variant={
														event.result === "success"
															? "default"
															: "destructive"
													}
												>
													{event.result}
												</Badge>
											</TableCell>
											<TableCell className="text-xs">
												<div className="space-y-1">
													<div>{event.network.maskedIp || "—"}</div>
													<div className="text-muted-foreground">
														{event.network.maskedUserAgent || "—"}
													</div>
												</div>
											</TableCell>
											<TableCell>
												<Button
													size="sm"
													variant="outline"
													onClick={() => setSelectedEvent(event)}
												>
													View
												</Button>
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>

							{eventsQuery.hasNextPage && (
								<div className="flex justify-center">
									<Button
										variant="outline"
										onClick={() => eventsQuery.fetchNextPage()}
										disabled={eventsQuery.isFetchingNextPage}
									>
										{eventsQuery.isFetchingNextPage && (
											<Loader2 className="mr-2 h-4 w-4 animate-spin" />
										)}
										Load More
									</Button>
								</div>
							)}
						</>
					)}
				</CardContent>
			</Card>

			<Dialog
				open={!!selectedEvent}
				onOpenChange={(open) => !open && setSelectedEvent(null)}
			>
				<DialogContent className="sm:max-w-2xl">
					<DialogHeader>
						<DialogTitle>
							{selectedEvent ? formatAction(selectedEvent.action) : "Event"}
						</DialogTitle>
						<DialogDescription>
							Full event metadata for investigation and auditing.
						</DialogDescription>
					</DialogHeader>
					{selectedEvent && (
						<ScrollArea className="max-h-[70vh]">
							<div className="space-y-4">
								<div className="grid gap-2 sm:grid-cols-2">
									<Detail label="Timestamp" value={formatTimestamp(selectedEvent.timestamp)} />
									<Detail
										label="Result"
										value={selectedEvent.result}
										className={
											selectedEvent.result === "failure"
												? "text-destructive"
												: "text-emerald-600"
										}
									/>
									<Detail
										label="Actor"
										value={
											selectedEvent.actor.email ||
											selectedEvent.actor.name ||
											"Unknown"
										}
									/>
									<Detail
										label="Source"
										value={selectedEvent.source}
									/>
									<Detail
										label="Entity Type"
										value={selectedEvent.entity.type || "—"}
									/>
									<Detail
										label="Entity ID"
										value={selectedEvent.entity.id || "—"}
									/>
								</div>

								<div className="space-y-2 rounded-lg border p-3">
									<h3 className="font-medium text-sm">Network Details</h3>
									<Detail
										label="IP Address"
										value={selectedEvent.network.fullIp || "—"}
									/>
									<Detail
										label="User Agent"
										value={selectedEvent.network.fullUserAgent || "—"}
									/>
								</div>

								<div className="space-y-2 rounded-lg border p-3">
									<h3 className="font-medium text-sm">Metadata</h3>
									<pre className="overflow-x-auto rounded bg-muted p-3 text-xs">
										{JSON.stringify(selectedEvent.metadata, null, 2)}
									</pre>
								</div>
							</div>
						</ScrollArea>
					)}
				</DialogContent>
			</Dialog>
		</div>
	);
}

function Detail({
	label,
	value,
	className,
}: {
	label: string;
	value: string;
	className?: string;
}) {
	return (
		<div className="space-y-1 rounded-md border bg-muted/20 p-2">
			<p className="text-muted-foreground text-xs">{label}</p>
			<p className={className ?? "text-sm"}>{value}</p>
		</div>
	);
}
