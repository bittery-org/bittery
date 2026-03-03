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
import { formatDateTime } from "@/lib/i18n-format";
import { m as messages } from "@/paraglide/messages";
import { useI18n } from "@/providers/i18n-provider";

type ActionGroup =
	| "all"
	| "auth"
	| "team"
	| "vault"
	| "item"
	| "share"
	| "other";
type ResultFilter = "all" | "success" | "failure";
type AdminMessageCatalog = ReturnType<typeof useI18n>["m"];

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

function humanizeIdentifier(value: string): string {
	return value
		.replaceAll("_", " ")
		.replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatTimestamp(value: string): string {
	return formatDateTime(value, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function getActionGroupLabel(
	actionGroup: ActionGroup | TeamEvent["actionGroup"],
	m: AdminMessageCatalog,
): string {
	switch (actionGroup) {
		case "all":
			return m["admin.page.filter.action_group.option.all"]();
		case "auth":
			return m["admin.page.event.action_group.auth"]();
		case "team":
			return m["admin.page.event.action_group.team"]();
		case "vault":
			return m["admin.page.event.action_group.vault"]();
		case "item":
			return m["admin.page.event.action_group.item"]();
		case "share":
			return m["admin.page.event.action_group.share"]();
		case "other":
			return m["admin.page.event.action_group.other"]();
		default:
			return actionGroup;
	}
}

function getResultLabel(
	result: ResultFilter | TeamEvent["result"],
	m: AdminMessageCatalog,
): string {
	switch (result) {
		case "all":
			return m["admin.page.filter.result.option.all"]();
		case "success":
			return m["admin.page.event.result.success"]();
		case "failure":
			return m["admin.page.event.result.failure"]();
		default:
			return result;
	}
}

function getSourceLabel(source: TeamEvent["source"], m: AdminMessageCatalog): string {
	switch (source) {
		case "audit_log":
			return m["admin.page.event.source.audit_log"]();
		case "share_access_log":
			return m["admin.page.event.source.share_access_log"]();
		default:
			return source;
	}
}

function getEventActionLabel(action: string, m: AdminMessageCatalog): string {
	switch (action) {
		case "account_deleted":
			return m["admin.page.event.action.account_deleted"]();
		case "device_revoked":
			return m["admin.page.event.action.device_revoked"]();
		case "email_changed":
			return m["admin.page.event.action.email_changed"]();
		case "item_created":
			return m["admin.page.event.action.item_created"]();
		case "item_deleted":
			return m["admin.page.event.action.item_deleted"]();
		case "item_moved":
			return m["admin.page.event.action.item_moved"]();
		case "item_permanently_deleted":
			return m["admin.page.event.action.item_permanently_deleted"]();
		case "item_restored":
			return m["admin.page.event.action.item_restored"]();
		case "logout_all":
			return m["admin.page.event.action.logout_all"]();
		case "password_changed":
			return m["admin.page.event.action.password_changed"]();
		case "password_reset_via_recovery":
			return m["admin.page.event.action.password_reset_via_recovery"]();
		case "recovery_key_regenerated":
			return m["admin.page.event.action.recovery_key_regenerated"]();
		case "recovery_key_setup":
			return m["admin.page.event.action.recovery_key_setup"]();
		case "secret_key_regenerated":
			return m["admin.page.event.action.secret_key_regenerated"]();
		case "share_access_failed":
			return m["admin.page.event.action.share_access_failed"]();
		case "share_access_success":
			return m["admin.page.event.action.share_access_success"]();
		case "share_created":
			return m["admin.page.event.action.share_created"]();
		case "share_revoked":
			return m["admin.page.event.action.share_revoked"]();
		case "team_member_removed":
			return m["admin.page.event.action.team_member_removed"]();
		case "vault_created":
			return m["admin.page.event.action.vault_created"]();
		case "vault_deleted":
			return m["admin.page.event.action.vault_deleted"]();
		case "vault_member_added":
			return m["admin.page.event.action.vault_member_added"]();
		case "vault_member_removed":
			return m["admin.page.event.action.vault_member_removed"]();
		case "vault_updated":
			return m["admin.page.event.action.vault_updated"]();
		default:
			return humanizeIdentifier(action);
	}
}

function getEntityTypeLabel(
	entityType: string | null,
	m: AdminMessageCatalog,
): string {
	if (!entityType) {
		return m["admin.page.fallback.empty"]();
	}

	switch (entityType) {
		case "item":
			return m["admin.page.event.entity_type.item"]();
		case "share_link":
			return m["admin.page.event.entity_type.share_link"]();
		case "team":
			return m["admin.page.event.entity_type.team"]();
		case "user":
			return m["admin.page.event.entity_type.user"]();
		case "vault":
			return m["admin.page.event.entity_type.vault"]();
		default:
			return humanizeIdentifier(entityType);
	}
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
		meta: [{ title: messages["admin.page.meta_title"]() }],
	}),
});

function TeamAdminConsolePage() {
	const trpc = useTRPC();
	const trpcClient = useTRPCClient();
	const { m } = useI18n();
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
		<div className="mx-auto flex w-full max-w-6xl flex-col gap-6 pb-3">
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
								{m["admin.page.hero.title"]()}
							</h1>
							<p className="text-muted-foreground text-sm">
								{m["admin.page.hero.description"]()}
							</p>
						</div>
					</div>

					<div className="grid gap-3 md:grid-cols-2 lg:grid-cols-6">
						<div className="relative md:col-span-2">
							<Search className="-translate-y-1/2 absolute top-1/2 left-3 h-4 w-4 text-muted-foreground" />
							<Input
								value={filters.search}
								onChange={(event) => updateFilters({ search: event.target.value })}
								placeholder={m["admin.page.filter.search.placeholder"]()}
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
								<SelectValue
									placeholder={m["admin.page.filter.action_group.placeholder"]()}
								/>
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">
									{m["admin.page.filter.action_group.option.all"]()}
								</SelectItem>
								<SelectItem value="auth">
									{m["admin.page.event.action_group.auth"]()}
								</SelectItem>
								<SelectItem value="team">
									{m["admin.page.event.action_group.team"]()}
								</SelectItem>
								<SelectItem value="vault">
									{m["admin.page.event.action_group.vault"]()}
								</SelectItem>
								<SelectItem value="item">
									{m["admin.page.event.action_group.item"]()}
								</SelectItem>
								<SelectItem value="share">
									{m["admin.page.event.action_group.share"]()}
								</SelectItem>
								<SelectItem value="other">
									{m["admin.page.event.action_group.other"]()}
								</SelectItem>
							</SelectContent>
						</Select>

						<Select
							value={filters.result}
							onValueChange={(value) =>
								updateFilters({ result: value as ResultFilter })
							}
						>
							<SelectTrigger>
								<SelectValue placeholder={m["admin.page.filter.result.placeholder"]()} />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">
									{m["admin.page.filter.result.option.all"]()}
								</SelectItem>
								<SelectItem value="success">
									{m["admin.page.event.result.success"]()}
								</SelectItem>
								<SelectItem value="failure">
									{m["admin.page.event.result.failure"]()}
								</SelectItem>
							</SelectContent>
						</Select>

						<Select
							value={filters.actorUserId}
							onValueChange={(value) => updateFilters({ actorUserId: value })}
						>
							<SelectTrigger>
								<SelectValue placeholder={m["admin.page.filter.actor.placeholder"]()} />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">
									{m["admin.page.filter.actor.option.all"]()}
								</SelectItem>
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
							{m["admin.page.filter.reset"]()}
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
							<p className="font-medium text-sm">
								{m["admin.page.empty.title"]()}
							</p>
							<p className="text-muted-foreground text-xs">
								{m["admin.page.empty.description"]()}
							</p>
						</div>
					) : (
						<>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>{m["admin.page.table.header.time"]()}</TableHead>
										<TableHead>{m["admin.page.table.header.action"]()}</TableHead>
										<TableHead>{m["admin.page.table.header.actor"]()}</TableHead>
										<TableHead>{m["admin.page.table.header.entity"]()}</TableHead>
										<TableHead>{m["admin.page.table.header.result"]()}</TableHead>
										<TableHead>{m["admin.page.table.header.network"]()}</TableHead>
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
														{getEventActionLabel(event.action, m)}
													</span>
													<Badge variant="outline" className="w-fit capitalize">
														{getActionGroupLabel(event.actionGroup, m)}
													</Badge>
												</div>
											</TableCell>
											<TableCell className="text-sm">
												{event.actor.email ||
													event.actor.name ||
													m["admin.page.fallback.unknown_actor"]()}
											</TableCell>
											<TableCell className="text-xs">
												{event.entity.type && event.entity.id
													? `${getEntityTypeLabel(event.entity.type, m)}:${event.entity.id.slice(0, 8)}`
													: m["admin.page.fallback.empty"]()}
											</TableCell>
											<TableCell>
												<Badge
													variant={
														event.result === "success"
															? "default"
															: "destructive"
													}
												>
													{getResultLabel(event.result, m)}
												</Badge>
											</TableCell>
											<TableCell className="text-xs">
												<div className="space-y-1">
													<div>{event.network.maskedIp || m["admin.page.fallback.empty"]()}</div>
													<div className="text-muted-foreground">
														{event.network.maskedUserAgent ||
															m["admin.page.fallback.empty"]()}
													</div>
												</div>
											</TableCell>
											<TableCell>
												<Button
													size="sm"
													variant="outline"
													onClick={() => setSelectedEvent(event)}
												>
													{m["admin.page.table.action.view"]()}
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
										{m["admin.page.pagination.load_more"]()}
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
								{selectedEvent
									? getEventActionLabel(selectedEvent.action, m)
									: m["admin.page.dialog.fallback_title"]()}
							</DialogTitle>
							<DialogDescription>
								{m["admin.page.dialog.description"]()}
							</DialogDescription>
						</DialogHeader>
						{selectedEvent && (
							<ScrollArea className="max-h-[70vh]">
								<div className="space-y-4">
									<div className="grid gap-2 sm:grid-cols-2">
										<Detail
											label={m["admin.page.detail.label.timestamp"]()}
											value={formatTimestamp(selectedEvent.timestamp)}
										/>
										<Detail
											label={m["admin.page.detail.label.result"]()}
											value={getResultLabel(selectedEvent.result, m)}
											className={
												selectedEvent.result === "failure"
													? "text-destructive"
												: "text-emerald-600"
										}
										/>
										<Detail
											label={m["admin.page.detail.label.actor"]()}
											value={
												selectedEvent.actor.email ||
												selectedEvent.actor.name ||
												m["admin.page.fallback.unknown_actor"]()
											}
										/>
										<Detail
											label={m["admin.page.detail.label.source"]()}
											value={getSourceLabel(selectedEvent.source, m)}
										/>
										<Detail
											label={m["admin.page.detail.label.entity_type"]()}
											value={getEntityTypeLabel(selectedEvent.entity.type, m)}
										/>
										<Detail
											label={m["admin.page.detail.label.entity_id"]()}
											value={selectedEvent.entity.id || m["admin.page.fallback.empty"]()}
										/>
									</div>

									<div className="space-y-2 rounded-lg border p-3">
										<h3 className="font-medium text-sm">
											{m["admin.page.section.network_details"]()}
										</h3>
										<Detail
											label={m["admin.page.detail.label.ip_address"]()}
											value={selectedEvent.network.fullIp || m["admin.page.fallback.empty"]()}
										/>
										<Detail
											label={m["admin.page.detail.label.user_agent"]()}
											value={
												selectedEvent.network.fullUserAgent ||
												m["admin.page.fallback.empty"]()
											}
										/>
									</div>

									<div className="space-y-2 rounded-lg border p-3">
										<h3 className="font-medium text-sm">
											{m["admin.page.section.metadata"]()}
										</h3>
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
