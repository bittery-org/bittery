import { m as messages } from "@bittery/i18n/paraglide/messages";
import { useRPC, useRPCClient } from "@bittery/shared/rpc";
import {
	Badge,
	Button,
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
	metadata: unknown;
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
	const localDate = new Date(
		date.getTime() - date.getTimezoneOffset() * 60_000,
	);
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

function toIso(value: string): string | null {
	if (!value) return null;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return null;
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
			return m.admin_page_filter_action_group_option_all();
		case "auth":
			return m.admin_page_event_action_group_auth();
		case "team":
			return m.admin_page_event_action_group_team();
		case "vault":
			return m.admin_page_event_action_group_vault();
		case "item":
			return m.admin_page_event_action_group_item();
		case "share":
			return m.admin_page_event_action_group_share();
		case "other":
			return m.admin_page_event_action_group_other();
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
			return m.admin_page_filter_result_option_all();
		case "success":
			return m.admin_page_event_result_success();
		case "failure":
			return m.admin_page_event_result_failure();
		default:
			return result;
	}
}

function getSourceLabel(
	source: TeamEvent["source"],
	m: AdminMessageCatalog,
): string {
	switch (source) {
		case "audit_log":
			return m.admin_page_event_source_audit_log();
		case "share_access_log":
			return m.admin_page_event_source_share_access_log();
		default:
			return source;
	}
}

function getEventActionLabel(action: string, m: AdminMessageCatalog): string {
	switch (action) {
		case "account_deleted":
			return m.admin_page_event_action_account_deleted();
		case "device_revoked":
			return m.admin_page_event_action_device_revoked();
		case "email_changed":
			return m.admin_page_event_action_email_changed();
		case "item_created":
			return m.admin_page_event_action_item_created();
		case "item_deleted":
			return m.admin_page_event_action_item_deleted();
		case "item_moved":
			return m.admin_page_event_action_item_moved();
		case "item_permanently_deleted":
			return m.admin_page_event_action_item_permanently_deleted();
		case "item_restored":
			return m.admin_page_event_action_item_restored();
		case "logout_all":
			return m.admin_page_event_action_logout_all();
		case "password_changed":
			return m.admin_page_event_action_password_changed();
		case "password_reset_via_recovery":
			return m.admin_page_event_action_password_reset_via_recovery();
		case "recovery_key_regenerated":
			return m.admin_page_event_action_recovery_key_regenerated();
		case "recovery_key_setup":
			return m.admin_page_event_action_recovery_key_setup();
		case "secret_key_regenerated":
			return m.admin_page_event_action_secret_key_regenerated();
		case "share_access_failed":
			return m.admin_page_event_action_share_access_failed();
		case "share_access_success":
			return m.admin_page_event_action_share_access_success();
		case "share_created":
			return m.admin_page_event_action_share_created();
		case "share_revoked":
			return m.admin_page_event_action_share_revoked();
		case "team_member_removed":
			return m.admin_page_event_action_team_member_removed();
		case "vault_created":
			return m.admin_page_event_action_vault_created();
		case "vault_deleted":
			return m.admin_page_event_action_vault_deleted();
		case "vault_member_added":
			return m.admin_page_event_action_vault_member_added();
		case "vault_member_removed":
			return m.admin_page_event_action_vault_member_removed();
		case "vault_updated":
			return m.admin_page_event_action_vault_updated();
		default:
			return humanizeIdentifier(action);
	}
}

function getEntityTypeLabel(
	entityType: string | null,
	m: AdminMessageCatalog,
): string {
	if (!entityType) {
		return m.admin_page_fallback_empty();
	}

	switch (entityType) {
		case "item":
			return m.admin_page_event_entity_type_item();
		case "share_link":
			return m.admin_page_event_entity_type_share_link();
		case "team":
			return m.admin_page_event_entity_type_team();
		case "user":
			return m.admin_page_event_entity_type_user();
		case "vault":
			return m.admin_page_event_entity_type_vault();
		default:
			return humanizeIdentifier(entityType);
	}
}

export const Route = createFileRoute("/_app/admin/")({
	beforeLoad: async ({ context }) => {
		const access = await context.queryClient.ensureQueryData(
			context.rpc.billing.entitlements.queryOptions(),
		);

		if (access.mode !== "cloud") {
			throw redirect({ to: "/home" });
		}

		if (access.plan !== "team" || !access.entitlements.teamManagement) {
			throw redirect({ to: "/billing" });
		}

		const me = await context.queryClient.ensureQueryData(
			context.rpc.auth.me.queryOptions(),
		);

		if (me.role !== "owner" && me.role !== "admin") {
			throw redirect({ to: "/team" });
		}
	},
	component: TeamAdminConsolePage,
	head: () => ({
		meta: [{ title: messages.admin_page_meta_title() }],
	}),
});

function TeamAdminConsolePage() {
	const rpc = useRPC();
	const rpcClient = useRPCClient();
	const { m } = useI18n();
	const [filters, setFilters] = useState<Filters>(defaultFilters);
	const [selectedEvent, setSelectedEvent] = useState<TeamEvent | null>(null);

	const teamListQuery = useQuery(rpc.team.list.queryOptions());
	const teamId = teamListQuery.data?.id;
	const membersQuery = useQuery({
		...rpc.team.members.list.queryOptions({ teamId: teamId || "" }),
		enabled: !!teamId,
	});

	const eventsQuery = useInfiniteQuery({
		queryKey: ["admin-team-events", filters],
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam }) =>
			rpcClient.audit.teamEvents.query({
				limit: DEFAULT_LIMIT,
				cursor: pageParam ?? null,
				actionGroup: filters.actionGroup,
				result: filters.result,
				actorUserId:
					filters.actorUserId !== "all" ? filters.actorUserId : null,
				search: filters.search.trim() || null,
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
			{/* Hero Banner */}
			<section className="relative overflow-hidden rounded-2xl border bg-card p-3 sm:p-5">
				<div className="pointer-events-none absolute inset-0 bg-linear-to-br from-muted/60 via-transparent to-transparent" />

				<div className="relative flex items-center gap-3">
					<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted shadow-sm sm:h-10 sm:w-10">
						<History className="h-4 w-4 text-muted-foreground sm:h-5 sm:w-5" />
					</div>
					<div className="min-w-0">
						<h1 className="truncate font-semibold text-lg tracking-tight sm:text-xl">
							{m.admin_page_hero_title()}
						</h1>
						<p className="truncate text-muted-foreground text-xs">
							{m.admin_page_hero_description()}
						</p>
					</div>
				</div>
			</section>

			{/* Filters */}
			<div className="rounded-xl border bg-card p-4">
				<div className="flex flex-col gap-3">
					<div className="relative">
						<Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
						<Input
							value={filters.search}
							onChange={(event) =>
								updateFilters({ search: event.target.value })
							}
							placeholder={m.admin_page_filter_search_placeholder()}
							className="pl-9"
						/>
					</div>

					<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
						<Select
							value={filters.actionGroup}
							onValueChange={(value) =>
								updateFilters({ actionGroup: value as ActionGroup })
							}
						>
							<SelectTrigger>
								<SelectValue
									placeholder={m.admin_page_filter_action_group_placeholder()}
								/>
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">
									{m.admin_page_filter_action_group_option_all()}
								</SelectItem>
								<SelectItem value="auth">
									{m.admin_page_event_action_group_auth()}
								</SelectItem>
								<SelectItem value="team">
									{m.admin_page_event_action_group_team()}
								</SelectItem>
								<SelectItem value="vault">
									{m.admin_page_event_action_group_vault()}
								</SelectItem>
								<SelectItem value="item">
									{m.admin_page_event_action_group_item()}
								</SelectItem>
								<SelectItem value="share">
									{m.admin_page_event_action_group_share()}
								</SelectItem>
								<SelectItem value="other">
									{m.admin_page_event_action_group_other()}
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
								<SelectValue
									placeholder={m.admin_page_filter_result_placeholder()}
								/>
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">
									{m.admin_page_filter_result_option_all()}
								</SelectItem>
								<SelectItem value="success">
									{m.admin_page_event_result_success()}
								</SelectItem>
								<SelectItem value="failure">
									{m.admin_page_event_result_failure()}
								</SelectItem>
							</SelectContent>
						</Select>

						<Select
							value={filters.actorUserId}
							onValueChange={(value) => updateFilters({ actorUserId: value })}
						>
							<SelectTrigger>
								<SelectValue
									placeholder={m.admin_page_filter_actor_placeholder()}
								/>
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">
									{m.admin_page_filter_actor_option_all()}
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
							className="w-full"
						>
							{m.admin_page_filter_reset()}
						</Button>
					</div>

					<div className="grid grid-cols-2 gap-2">
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
			</div>

			<div className="rounded-xl border bg-card">
				{eventsQuery.isLoading ? (
					<div className="space-y-2 p-4">
						<Skeleton className="h-12 w-full" />
						<Skeleton className="h-12 w-full" />
						<Skeleton className="h-12 w-full" />
					</div>
				) : allEvents.length === 0 ? (
					<div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
						<History className="h-8 w-8 text-muted-foreground" />
						<p className="font-medium text-sm">{m.admin_page_empty_title()}</p>
						<p className="text-muted-foreground text-xs">
							{m.admin_page_empty_description()}
						</p>
					</div>
				) : (
					<>
						<div className="overflow-x-auto">
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead className="whitespace-nowrap">
											{m.admin_page_table_header_time()}
										</TableHead>
										<TableHead className="whitespace-nowrap">
											{m.admin_page_table_header_action()}
										</TableHead>
										<TableHead className="whitespace-nowrap">
											{m.admin_page_table_header_actor()}
										</TableHead>
										<TableHead className="hidden whitespace-nowrap md:table-cell">
											{m.admin_page_table_header_entity()}
										</TableHead>
										<TableHead className="whitespace-nowrap">
											{m.admin_page_table_header_result()}
										</TableHead>
										<TableHead className="hidden whitespace-nowrap lg:table-cell">
											{m.admin_page_table_header_network()}
										</TableHead>
										<TableHead className="w-20" />
									</TableRow>
								</TableHeader>
								<TableBody>
									{allEvents.map((event) => (
										<TableRow
											key={`${event.source}-${event.id}`}
											className="cursor-pointer"
											onClick={() => setSelectedEvent(event)}
										>
											<TableCell className="whitespace-nowrap text-muted-foreground text-xs">
												{formatTimestamp(event.timestamp)}
											</TableCell>
											<TableCell>
												<div className="flex flex-col gap-1">
													<span className="font-medium text-sm">
														{getEventActionLabel(event.action, m)}
													</span>
													<Badge
														variant="outline"
														className="w-fit text-[11px] capitalize"
													>
														{getActionGroupLabel(event.actionGroup, m)}
													</Badge>
												</div>
											</TableCell>
											<TableCell className="max-w-35 truncate text-sm">
												{event.actor.email ||
													event.actor.name ||
													m.admin_page_fallback_unknown_actor()}
											</TableCell>
											<TableCell className="hidden text-xs md:table-cell">
												{event.entity.type && event.entity.id
													? `${getEntityTypeLabel(event.entity.type, m)}:${event.entity.id.slice(0, 8)}`
													: m.admin_page_fallback_empty()}
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
											<TableCell className="hidden text-xs lg:table-cell">
												<div className="space-y-0.5">
													<div>
														{event.network.maskedIp ||
															m.admin_page_fallback_empty()}
													</div>
													<div className="text-muted-foreground">
														{event.network.maskedUserAgent ||
															m.admin_page_fallback_empty()}
													</div>
												</div>
											</TableCell>
											<TableCell>
												<Button
													size="sm"
													variant="ghost"
													onClick={(e) => {
														e.stopPropagation();
														setSelectedEvent(event);
													}}
												>
													{m.admin_page_table_action_view()}
												</Button>
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</div>

						{eventsQuery.hasNextPage && (
							<div className="flex justify-center border-t p-4">
								<Button
									variant="outline"
									onClick={() => eventsQuery.fetchNextPage()}
									disabled={eventsQuery.isFetchingNextPage}
								>
									{eventsQuery.isFetchingNextPage && (
										<Loader2 className="mr-2 h-4 w-4 animate-spin" />
									)}
									{m.admin_page_pagination_load_more()}
								</Button>
							</div>
						)}
					</>
				)}
			</div>

			<Dialog
				open={!!selectedEvent}
				onOpenChange={(open) => !open && setSelectedEvent(null)}
			>
				<DialogContent className="sm:max-w-2xl">
					<DialogHeader>
						<DialogTitle>
							{selectedEvent
								? getEventActionLabel(selectedEvent.action, m)
								: m.admin_page_dialog_fallback_title()}
						</DialogTitle>
						<DialogDescription>
							{m.admin_page_dialog_description()}
						</DialogDescription>
					</DialogHeader>
					{selectedEvent && (
						<ScrollArea className="max-h-[70vh]">
							<div className="space-y-4">
								<div className="grid gap-2 sm:grid-cols-2">
									<Detail
										label={m.admin_page_detail_label_timestamp()}
										value={formatTimestamp(selectedEvent.timestamp)}
									/>
									<Detail
										label={m.admin_page_detail_label_result()}
										value={getResultLabel(selectedEvent.result, m)}
										className={
											selectedEvent.result === "failure"
												? "text-destructive"
												: "text-emerald-600"
										}
									/>
									<Detail
										label={m.admin_page_detail_label_actor()}
										value={
											selectedEvent.actor.email ||
											selectedEvent.actor.name ||
											m.admin_page_fallback_unknown_actor()
										}
									/>
									<Detail
										label={m.admin_page_detail_label_source()}
										value={getSourceLabel(selectedEvent.source, m)}
									/>
									<Detail
										label={m.admin_page_detail_label_entity_type()}
										value={getEntityTypeLabel(selectedEvent.entity.type, m)}
									/>
									<Detail
										label={m.admin_page_detail_label_entity_id()}
										value={
											selectedEvent.entity.id || m.admin_page_fallback_empty()
										}
									/>
								</div>

								<div className="space-y-2 rounded-lg border p-3">
									<h3 className="font-medium text-sm">
										{m.admin_page_section_network_details()}
									</h3>
									<Detail
										label={m.admin_page_detail_label_ip_address()}
										value={
											selectedEvent.network.fullIp ||
											m.admin_page_fallback_empty()
										}
									/>
									<Detail
										label={m.admin_page_detail_label_user_agent()}
										value={
											selectedEvent.network.fullUserAgent ||
											m.admin_page_fallback_empty()
										}
									/>
								</div>

								<div className="space-y-2 rounded-lg border p-3">
									<h3 className="font-medium text-sm">
										{m.admin_page_section_metadata()}
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
