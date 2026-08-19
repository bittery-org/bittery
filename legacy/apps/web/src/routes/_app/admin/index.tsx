import type { AuditEvent, TeamMember } from "@bittery/api-contract";
import { formatDate, formatDateTime } from "@bittery/i18n/format/browser";
import { m as messages } from "@bittery/i18n/paraglide/messages";
import { useApiClient } from "@bittery/shared/api";
import { apiQueries } from "@bittery/shared/api-query";
import {
	Avatar,
	AvatarFallback,
	Badge,
	Button,
	cn,
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
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@bittery/ui";
import {
	IconNetwork as Activity,
	IconCircleAlert as AlertTriangle,
	IconCheck as Check,
	IconChevronRight as ChevronRight,
	IconEye as Eye,
	IconHistory as History,
	IconLaptop as Laptop,
	IconLoaderCircle as Loader2,
	IconLockKeyhole as LockKey,
	IconSearch as Search,
	IconShare as Share,
	IconUsers as Users,
	IconVault as Vault,
} from "@bittery/ui/icons";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
	normalizeDeploymentMode,
	normalizeEntitlements,
} from "@/lib/api-normalizers";
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
type AdminTab = "people" | "activity";
type AdminMessageCatalog = ReturnType<typeof useI18n>["m"];

/** The server's audit-event shape, under the name this console has always used for it. */
type TeamEvent = AuditEvent;

interface Filters {
	actionGroup: ActionGroup;
	result: ResultFilter;
	actorUserId: string;
	search: string;
	from: string;
	to: string;
}

const DEFAULT_LIMIT = 50;

function toLocalDateTimeValue(date: Date) {
	const localDate = new Date(
		date.getTime() - date.getTimezoneOffset() * 60_000,
	);
	return localDate.toISOString().slice(0, 16);
}

function defaultFilters(): Filters {
	const now = new Date();
	return {
		actionGroup: "all",
		result: "all",
		actorUserId: "all",
		search: "",
		from: toLocalDateTimeValue(new Date(now.getTime() - 14 * 86_400_000)),
		to: toLocalDateTimeValue(now),
	};
}

function toIso(value: string) {
	if (!value) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function humanizeIdentifier(value: string) {
	return value
		.replaceAll("_", " ")
		.replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatTimestamp(value: string) {
	return formatDateTime(value, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function getActionGroupLabel(actionGroup: ActionGroup, m: AdminMessageCatalog) {
	const labels: Record<ActionGroup, () => string> = {
		all: m.admin_page_filter_action_group_option_all,
		auth: m.admin_page_event_action_group_auth,
		team: m.admin_page_event_action_group_team,
		vault: m.admin_page_event_action_group_vault,
		item: m.admin_page_event_action_group_item,
		share: m.admin_page_event_action_group_share,
		other: m.admin_page_event_action_group_other,
	};
	return labels[actionGroup]();
}

function getResultLabel(result: ResultFilter, m: AdminMessageCatalog) {
	if (result === "all") return m.admin_page_filter_result_option_all();
	return result === "success"
		? m.admin_page_event_result_success()
		: m.admin_page_event_result_failure();
}

function getSourceLabel(source: TeamEvent["source"], m: AdminMessageCatalog) {
	return source === "audit_log"
		? m.admin_page_event_source_audit_log()
		: m.admin_page_event_source_share_access_log();
}

function getEventActionLabel(action: string, m: AdminMessageCatalog) {
	const labels: Record<string, (() => string) | undefined> = {
		account_deleted: m.admin_page_event_action_account_deleted,
		device_revoked: m.admin_page_event_action_device_revoked,
		email_changed: m.admin_page_event_action_email_changed,
		item_created: m.admin_page_event_action_item_created,
		item_deleted: m.admin_page_event_action_item_deleted,
		item_moved: m.admin_page_event_action_item_moved,
		item_permanently_deleted:
			m.admin_page_event_action_item_permanently_deleted,
		item_restored: m.admin_page_event_action_item_restored,
		logout_all: m.admin_page_event_action_logout_all,
		password_changed: m.admin_page_event_action_password_changed,
		password_reset_via_recovery:
			m.admin_page_event_action_password_reset_via_recovery,
		recovery_key_regenerated:
			m.admin_page_event_action_recovery_key_regenerated,
		recovery_key_setup: m.admin_page_event_action_recovery_key_setup,
		secret_key_regenerated: m.admin_page_event_action_secret_key_regenerated,
		share_access_failed: m.admin_page_event_action_share_access_failed,
		share_access_success: m.admin_page_event_action_share_access_success,
		share_created: m.admin_page_event_action_share_created,
		share_revoked: m.admin_page_event_action_share_revoked,
		team_member_removed: m.admin_page_event_action_team_member_removed,
		vault_created: m.admin_page_event_action_vault_created,
		vault_deleted: m.admin_page_event_action_vault_deleted,
		vault_member_added: m.admin_page_event_action_vault_member_added,
		vault_member_removed: m.admin_page_event_action_vault_member_removed,
		vault_updated: m.admin_page_event_action_vault_updated,
	};
	return labels[action]?.() ?? humanizeIdentifier(action);
}

function getEntityTypeLabel(
	type: TeamEvent["entity"]["type"],
	m: AdminMessageCatalog,
) {
	if (!type) return m.admin_page_fallback_empty();
	const labels: Record<string, (() => string) | undefined> = {
		item: m.admin_page_event_entity_type_item,
		share_link: m.admin_page_event_entity_type_share_link,
		team: m.admin_page_event_entity_type_team,
		user: m.admin_page_event_entity_type_user,
		vault: m.admin_page_event_entity_type_vault,
	};
	return labels[type]?.() ?? humanizeIdentifier(type);
}

function getActorLabel(event: TeamEvent, m: AdminMessageCatalog) {
	return (
		event.actor.email ||
		event.actor.name ||
		m.admin_page_fallback_unknown_actor()
	);
}

export const Route = createFileRoute("/_app/admin/")({
	validateSearch: (search: Record<string, unknown>): { tab: AdminTab } => ({
		tab: search.tab === "activity" ? "activity" : "people",
	}),
	beforeLoad: async ({ context }) => {
		const access = await context.queryClient.ensureQueryData(
			apiQueries.billing.entitlements(context.api),
		);
		const mode = normalizeDeploymentMode(access.mode);
		const entitlements = normalizeEntitlements(access.entitlements);
		if (!entitlements.teamManagement) {
			throw redirect({ to: mode === "cloud" ? "/billing" : "/home" });
		}
		if (mode === "cloud" && access.plan !== "team") {
			throw redirect({ to: "/billing" });
		}
		const me = await context.queryClient.ensureQueryData(
			apiQueries.auth.me(context.api),
		);
		if (me.role !== "owner" && me.role !== "admin") {
			throw redirect({ to: "/team" });
		}
	},
	component: TeamAdminConsolePage,
	head: () => ({ meta: [{ title: messages.admin_page_meta_title() }] }),
});

function TeamAdminConsolePage() {
	const api = useApiClient();
	const { m } = useI18n();
	const navigate = useNavigate({ from: Route.fullPath });
	const { tab } = Route.useSearch();
	const [filters, setFilters] = useState<Filters>(defaultFilters);
	const [selectedEvent, setSelectedEvent] = useState<TeamEvent | null>(null);

	const teamQuery = useQuery(apiQueries.teams.current(api));
	const teamId = teamQuery.data?.id;
	const membersQuery = useQuery({
		...apiQueries.teams.members(api, teamId || ""),
		enabled: !!teamId,
	});
	const eventsQuery = useInfiniteQuery({
		queryKey: ["admin-team-events", filters],
		initialPageParam: undefined as string | undefined,
		queryFn: async ({ pageParam }) =>
			(
				await api.audit.list({
					limit: DEFAULT_LIMIT,
					cursor: pageParam,
					actionGroup: filters.actionGroup,
					result: filters.result,
					actorUserId:
						filters.actorUserId !== "all" ? filters.actorUserId : undefined,
					search: filters.search.trim() || undefined,
					from: toIso(filters.from) ?? undefined,
					to: toIso(filters.to) ?? undefined,
				})
			).data,
		getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
	});

	const events = useMemo(
		() => eventsQuery.data?.pages.flatMap((page) => page.events) ?? [],
		[eventsQuery.data],
	);
	const members = membersQuery.data ?? [];

	return (
		<div className="mx-auto flex w-full max-w-[1500px] flex-col gap-4 pb-10">
			<header className="flex items-center gap-3">
				<div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground">
					<Users className="size-4" />
				</div>
				<div className="min-w-0">
					<h1 className="truncate font-semibold text-lg tracking-[-0.015em]">
						{m.admin_page_hero_title()}
					</h1>
					<p className="text-muted-foreground text-xs">
						{m.admin_page_hero_description()}
					</p>
				</div>
			</header>

			<Tabs
				value={tab}
				onValueChange={(value) =>
					navigate({ search: { tab: value as AdminTab }, replace: true })
				}
			>
				<TabsList className="w-full sm:w-fit">
					<TabsTrigger value="people" className="flex-1 sm:flex-none">
						<Users className="h-4 w-4 sm:mr-2" />
						{m.admin_console_tab_people()}
					</TabsTrigger>
					<TabsTrigger value="activity" className="flex-1 sm:flex-none">
						<History className="h-4 w-4 sm:mr-2" />
						{m.admin_console_tab_activity()}
					</TabsTrigger>
				</TabsList>

				<TabsContent value="people" className="mt-4">
					<PeopleTab
						events={events}
						isLoadingMembers={membersQuery.isLoading || teamQuery.isLoading}
						m={m}
						members={members}
						teamId={teamId ?? ""}
						onSelectEvent={setSelectedEvent}
					/>
				</TabsContent>

				<TabsContent value="activity" className="mt-4">
					<ActivityTab
						events={events}
						filters={filters}
						hasNextPage={eventsQuery.hasNextPage}
						isFetchingNextPage={eventsQuery.isFetchingNextPage}
						isLoading={eventsQuery.isLoading}
						m={m}
						members={members}
						onLoadMore={() => eventsQuery.fetchNextPage()}
						onResetFilters={() => setFilters(defaultFilters())}
						onSelectEvent={setSelectedEvent}
						onUpdateFilters={(next) =>
							setFilters((current) => ({ ...current, ...next }))
						}
					/>
				</TabsContent>
			</Tabs>

			<EventDialog
				event={selectedEvent}
				m={m}
				onClose={() => setSelectedEvent(null)}
			/>
		</div>
	);
}

/* -------------------------------------------------------------------------- */
/*                                 People tab                                  */
/* -------------------------------------------------------------------------- */

interface PeopleTabProps {
	events: readonly TeamEvent[];
	isLoadingMembers: boolean;
	m: AdminMessageCatalog;
	members: readonly TeamMember[];
	teamId: string;
	onSelectEvent: (event: TeamEvent) => void;
}

function PeopleTab({
	events,
	isLoadingMembers,
	m,
	members,
	teamId,
	onSelectEvent,
}: PeopleTabProps) {
	const api = useApiClient();
	const [search, setSearch] = useState("");
	const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

	const query = search.trim().toLowerCase();
	const visibleMembers = query
		? members.filter(
				(member) =>
					member.name.toLowerCase().includes(query) ||
					member.email.toLowerCase().includes(query),
			)
		: members;

	// Derived rather than stored, so the first member is selected as soon as the
	// list loads and the selection survives filtering without an effect.
	const selectedMember =
		visibleMembers.find((member) => member.userId === selectedUserId) ??
		visibleMembers[0];

	const accessQuery = useQuery({
		...apiQueries.teams.memberAccess(api, teamId, selectedMember?.userId ?? ""),
		enabled: !!selectedMember?.userId,
	});
	const access = accessQuery.data;
	const memberEvents = selectedMember
		? events.filter((event) => event.actor.userId === selectedMember.userId)
		: [];

	return (
		<div className="grid gap-4 xl:grid-cols-[minmax(300px,.75fr)_minmax(0,1.4fr)]">
			<section className="h-fit overflow-hidden rounded-lg border bg-card">
				<div className="border-b p-3">
					<div className="relative">
						<Search className="absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
						<Input
							className="h-8 pl-8"
							onChange={(event) => setSearch(event.target.value)}
							placeholder={m.admin_console_search_members()}
							value={search}
						/>
					</div>
				</div>
				<div className="divide-y">
					{isLoadingMembers ? (
						<LoadingRows />
					) : visibleMembers.length ? (
						visibleMembers.map((member) => (
							<MemberRow
								active={selectedMember?.userId === member.userId}
								key={member.userId}
								member={member}
								onClick={() => setSelectedUserId(member.userId)}
							/>
						))
					) : (
						<p className="px-4 py-8 text-center text-muted-foreground text-xs">
							{m.admin_console_members_empty()}
						</p>
					)}
				</div>
			</section>

			{selectedMember ? (
				<div className="space-y-4">
					<section className="overflow-hidden rounded-lg border bg-card">
						<div className="relative flex items-start gap-3 border-b p-5">
							<span
								aria-hidden
								className="absolute inset-x-0 top-0 h-16 bg-[radial-gradient(90%_100%_at_10%_0%,color-mix(in_oklab,var(--color-primary-deep)_9%,transparent),transparent_70%)]"
							/>
							<MemberAvatar
								className="relative size-11"
								member={selectedMember}
							/>
							<div className="relative min-w-0">
								<h2 className="truncate font-semibold text-base">
									{selectedMember.name}
								</h2>
								<p className="truncate text-muted-foreground text-xs">
									{selectedMember.email}
								</p>
							</div>
							<Badge className="relative ml-auto capitalize" variant="outline">
								{selectedMember.role}
							</Badge>
						</div>
						<div className="grid divide-y sm:grid-cols-4 sm:divide-x sm:divide-y-0">
							<AccessFact
								label={m.admin_console_joined()}
								value={
									selectedMember.joinedAt
										? formatDate(selectedMember.joinedAt)
										: m.admin_page_fallback_empty()
								}
							/>
							<AccessFact
								label={m.admin_console_stat_vaults()}
								pending={accessQuery.isPending}
								value={String(access?.vaults.length ?? 0)}
							/>
							<AccessFact
								label={m.admin_console_stat_sessions()}
								pending={accessQuery.isPending}
								value={String(access?.devices.length ?? 0)}
							/>
							<AccessFact
								label={m.admin_console_stat_shares()}
								pending={accessQuery.isPending}
								value={String(access?.activeShareLinkCount ?? 0)}
							/>
						</div>
					</section>

					<div className="grid gap-4 lg:grid-cols-2">
						<InventoryCard
							description={m.admin_console_vault_access_hint()}
							footnote={m.admin_console_vault_access_personal_note()}
							title={m.admin_console_vault_access()}
						>
							{accessQuery.isPending ? (
								<LoadingRows />
							) : access?.vaults.length ? (
								<div className="space-y-2">
									{access.vaults.map((vault) => (
										<InventoryRow
											icon={Vault}
											key={vault.id}
											meta={
												vault.itemCount === 1
													? m.admin_console_vault_item_count_single({
															count: vault.itemCount,
														})
													: m.admin_console_vault_item_count_plural({
															count: vault.itemCount,
														})
											}
											subtitle={m.admin_console_vault_granted({
												date: formatDate(vault.grantedAt),
											})}
											title={vault.name}
											trailing={
												<Badge className="capitalize" variant="outline">
													{vault.role}
												</Badge>
											}
										/>
									))}
								</div>
							) : (
								<InventoryEmpty label={m.admin_console_vault_access_empty()} />
							)}
						</InventoryCard>

						<InventoryCard
							description={m.admin_console_sessions_hint()}
							title={m.admin_console_sessions()}
						>
							{accessQuery.isPending ? (
								<LoadingRows />
							) : access?.devices.length ? (
								<div className="space-y-2">
									{access.devices.map((device) => (
										<InventoryRow
											icon={Laptop}
											key={device.id}
											meta={device.maskedIp ?? m.admin_page_fallback_empty()}
											subtitle={m.admin_console_session_last_active({
												time: formatTimestamp(device.lastActiveAt),
											})}
											title={
												device.deviceName ||
												[device.browserName, device.osName]
													.filter(Boolean)
													.join(" · ") ||
												m.admin_console_session_unnamed()
											}
										/>
									))}
								</div>
							) : (
								<InventoryEmpty label={m.admin_console_sessions_empty()} />
							)}
						</InventoryCard>
					</div>

					<InventoryCard
						description={m.admin_console_share_links_hint()}
						footnote={
							access && access.shareLinkTotal > access.shareLinks.length
								? m.admin_console_share_links_capped({
										shown: access.shareLinks.length,
										total: access.shareLinkTotal,
									})
								: undefined
						}
						title={m.admin_console_share_links()}
					>
						{accessQuery.isPending ? (
							<LoadingRows />
						) : access?.shareLinks.length ? (
							<div className="space-y-2">
								{access.shareLinks.map((link) => (
									<InventoryRow
										icon={Share}
										key={link.id}
										meta={
											link.accessCount === 1
												? m.admin_console_share_access_count_single({
														count: link.accessCount,
													})
												: m.admin_console_share_access_count_plural({
														count: link.accessCount,
													})
										}
										subtitle={m.admin_console_share_expires({
											date: formatDate(link.expiresAt),
										})}
										title={m.admin_page_event_entity_type_item()}
										trailing={<ShareStatusBadge link={link} m={m} />}
									/>
								))}
							</div>
						) : (
							<InventoryEmpty label={m.admin_console_share_links_empty()} />
						)}
					</InventoryCard>

					<section className="overflow-hidden rounded-lg border bg-card">
						<div className="border-b px-4 py-3">
							<h3 className="font-semibold text-sm">
								{m.admin_console_member_activity()}
							</h3>
							<p className="text-muted-foreground text-xs">
								{m.admin_console_member_activity_hint()}
							</p>
						</div>
						<div className="divide-y">
							{memberEvents.length ? (
								memberEvents
									.slice(0, 6)
									.map((event) => (
										<ActivityRow
											event={event}
											key={`${event.source}-${event.id}`}
											m={m}
											onClick={() => onSelectEvent(event)}
										/>
									))
							) : (
								<InventoryEmpty
									label={m.admin_console_member_activity_empty()}
								/>
							)}
						</div>
					</section>
				</div>
			) : (
				<section className="flex flex-col items-center justify-center gap-2 rounded-lg border bg-card py-16 text-center">
					<Users className="size-6 text-muted-foreground" />
					<p className="font-medium text-sm">
						{m.admin_console_select_member_title()}
					</p>
					<p className="text-muted-foreground text-xs">
						{m.admin_console_select_member_description()}
					</p>
				</section>
			)}
		</div>
	);
}

function ShareStatusBadge({
	link,
	m,
}: {
	link: { status: string; isExpired: boolean };
	m: AdminMessageCatalog;
}) {
	if (link.isExpired) {
		return (
			<Badge
				className="border-warning/30 bg-warning/10 text-warning"
				variant="outline"
			>
				{m.admin_console_share_status_expired()}
			</Badge>
		);
	}
	const labels: Record<string, (() => string) | undefined> = {
		active: m.admin_console_share_status_active,
		expired: m.admin_console_share_status_expired,
		exhausted: m.admin_console_share_status_exhausted,
		revoked: m.admin_console_share_status_revoked,
	};
	const label = labels[link.status]?.() ?? humanizeIdentifier(link.status);
	return (
		<Badge
			className={cn(
				link.status === "active" &&
					"border-success/30 bg-success/10 text-success",
			)}
			variant="outline"
		>
			{label}
		</Badge>
	);
}

function InventoryCard({
	children,
	description,
	footnote,
	title,
}: {
	children: React.ReactNode;
	description: string;
	footnote?: string;
	title: string;
}) {
	return (
		<section className="flex flex-col rounded-lg border bg-card p-4">
			<div>
				<h3 className="font-semibold text-sm">{title}</h3>
				<p className="text-muted-foreground text-xs">{description}</p>
			</div>
			<div className="mt-4 flex-1">{children}</div>
			{footnote && (
				<p className="mt-3 border-t pt-3 text-[11px] text-muted-foreground">
					{footnote}
				</p>
			)}
		</section>
	);
}

function InventoryRow({
	icon: Icon,
	meta,
	subtitle,
	title,
	trailing,
}: {
	icon: typeof Vault;
	meta: string;
	subtitle: string;
	title: string;
	trailing?: React.ReactNode;
}) {
	return (
		<div className="flex items-center gap-3 rounded-md border bg-foreground/3 p-2.5">
			<div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-card text-muted-foreground">
				<Icon className="size-3.5" />
			</div>
			<div className="min-w-0 flex-1">
				<p className="truncate font-medium text-xs">{title}</p>
				<p className="truncate text-[11px] text-muted-foreground">{subtitle}</p>
			</div>
			<span className="shrink-0 text-[10px] text-muted-foreground">{meta}</span>
			{trailing}
		</div>
	);
}

function InventoryEmpty({ label }: { label: string }) {
	return (
		<p className="py-6 text-center text-muted-foreground text-xs">{label}</p>
	);
}

function AccessFact({
	label,
	pending,
	value,
}: {
	label: string;
	pending?: boolean;
	value: string;
}) {
	return (
		<div className="p-4">
			<p className="font-semibold text-[10px] text-muted-foreground uppercase tracking-[0.06em]">
				{label}
			</p>
			{pending ? (
				<Skeleton className="mt-2 h-5 w-8" />
			) : (
				<p className="mt-2 font-medium text-sm">{value}</p>
			)}
		</div>
	);
}

function MemberAvatar({
	className,
	member,
}: {
	className?: string;
	member: TeamMember;
}) {
	const initials = member.name
		.split(" ")
		.map((part) => part[0])
		.filter(Boolean)
		.slice(0, 2)
		.join("")
		.toUpperCase();
	return (
		<Avatar className={cn("size-8 rounded-md", className)}>
			<AvatarFallback className="rounded-md bg-linear-to-br from-primary to-primary-deep font-semibold text-[10px] text-white shadow-[inset_0_0_0_1px_oklch(1_0_0/0.12)]">
				{initials}
			</AvatarFallback>
		</Avatar>
	);
}

function MemberRow({
	active,
	member,
	onClick,
}: {
	active: boolean;
	member: TeamMember;
	onClick: () => void;
}) {
	return (
		<button
			className={cn(
				"relative flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-foreground/4",
				active &&
					"bg-selected shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-primary)_14%,transparent)]",
			)}
			onClick={onClick}
			type="button"
		>
			{active && (
				<span
					aria-hidden
					className="absolute top-[6px] bottom-[6px] left-0 w-0.5 rounded-full bg-primary shadow-[0_0_8px_color-mix(in_oklab,var(--color-primary)_80%,transparent)]"
				/>
			)}
			<MemberAvatar member={member} />
			<div className="min-w-0 flex-1">
				<p className="truncate font-medium text-sm">{member.name}</p>
				<p className="truncate text-muted-foreground text-xs">{member.email}</p>
			</div>
			<span className="shrink-0 text-muted-foreground text-xs capitalize">
				{member.role}
			</span>
		</button>
	);
}

function ActivityRow({
	event,
	m,
	onClick,
}: {
	event: TeamEvent;
	m: AdminMessageCatalog;
	onClick: () => void;
}) {
	return (
		<button
			className="group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-foreground/4"
			onClick={onClick}
			type="button"
		>
			<div
				className={cn(
					"flex size-8 shrink-0 items-center justify-center rounded-md border",
					event.result === "failure"
						? "border-destructive/30 bg-destructive/10 text-destructive"
						: "bg-foreground/3 text-muted-foreground",
				)}
			>
				{event.result === "failure" ? (
					<AlertTriangle className="size-3.5" />
				) : (
					<Check className="size-3.5" />
				)}
			</div>
			<div className="min-w-0 flex-1">
				<p className="truncate font-medium text-sm">
					{getEventActionLabel(event.action, m)}
				</p>
				<p className="truncate text-muted-foreground text-xs">
					{getActorLabel(event, m)} · {formatTimestamp(event.timestamp)}
				</p>
			</div>
			<Badge className="hidden sm:flex" variant="outline">
				{getActionGroupLabel(event.actionGroup, m)}
			</Badge>
			<ChevronRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
		</button>
	);
}

/* -------------------------------------------------------------------------- */
/*                                Activity tab                                 */
/* -------------------------------------------------------------------------- */

interface ActivityTabProps {
	events: readonly TeamEvent[];
	filters: Filters;
	hasNextPage: boolean;
	isFetchingNextPage: boolean;
	isLoading: boolean;
	m: AdminMessageCatalog;
	members: readonly TeamMember[];
	onLoadMore: () => void;
	onResetFilters: () => void;
	onSelectEvent: (event: TeamEvent) => void;
	onUpdateFilters: (next: Partial<Filters>) => void;
}

/// Presets over filters the server already supports — not persisted "saved views".
const VIEWS = [
	{
		key: "all",
		icon: Activity,
		label: (m: AdminMessageCatalog) => m.admin_console_view_all(),
		filters: { actionGroup: "all", result: "all" },
	},
	{
		key: "failures",
		icon: AlertTriangle,
		label: (m: AdminMessageCatalog) => m.admin_console_view_failures(),
		filters: { actionGroup: "all", result: "failure" },
	},
	{
		key: "shares",
		icon: Share,
		label: (m: AdminMessageCatalog) => m.admin_console_view_shares(),
		filters: { actionGroup: "share", result: "all" },
	},
	{
		key: "auth",
		icon: LockKey,
		label: (m: AdminMessageCatalog) => m.admin_console_view_auth(),
		filters: { actionGroup: "auth", result: "all" },
	},
] as const satisfies ReadonlyArray<{
	key: string;
	icon: typeof Activity;
	label: (m: AdminMessageCatalog) => string;
	filters: Pick<Filters, "actionGroup" | "result">;
}>;

function ActivityTab({
	events,
	filters,
	hasNextPage,
	isFetchingNextPage,
	isLoading,
	m,
	members,
	onLoadMore,
	onResetFilters,
	onSelectEvent,
	onUpdateFilters,
}: ActivityTabProps) {
	const [focusedEventId, setFocusedEventId] = useState<string | null>(null);
	// Derived, so the inspector fills in as soon as the first page arrives.
	const focused =
		events.find((event) => event.id === focusedEventId) ?? events[0];
	const activeView = VIEWS.find(
		(view) =>
			view.filters.actionGroup === filters.actionGroup &&
			view.filters.result === filters.result,
	);

	return (
		<div className="flex flex-col gap-3">
			<FilterBar
				filters={filters}
				m={m}
				members={members}
				onReset={onResetFilters}
				onUpdate={onUpdateFilters}
			/>
			<div className="grid min-h-[620px] overflow-hidden rounded-lg border bg-card xl:grid-cols-[200px_minmax(0,1fr)_340px]">
				<aside className="border-b p-3 xl:border-r xl:border-b-0">
					<p className="px-2 font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
						{m.admin_console_views()}
					</p>
					<div className="mt-2 space-y-1">
						{VIEWS.map((view) => (
							<ViewButton
								active={activeView?.key === view.key}
								icon={view.icon}
								key={view.key}
								label={view.label(m)}
								onClick={() => onUpdateFilters(view.filters)}
							/>
						))}
					</div>
				</aside>

				<section className="min-w-0 border-b xl:border-r xl:border-b-0">
					<div className="grid grid-cols-[95px_minmax(160px,1fr)_minmax(120px,.7fr)_72px] border-b bg-foreground/3 px-3 py-2 font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
						<span>{m.admin_page_table_header_time()}</span>
						<span>{m.admin_page_table_header_action()}</span>
						<span>{m.admin_page_table_header_actor()}</span>
						<span>{m.admin_page_table_header_result()}</span>
					</div>
					<div className="divide-y">
						{isLoading ? (
							<LoadingRows />
						) : events.length ? (
							events.map((event) => (
								<EventLine
									active={focused?.id === event.id}
									event={event}
									key={`${event.source}-${event.id}`}
									m={m}
									onClick={() => setFocusedEventId(event.id)}
								/>
							))
						) : (
							<EmptyState m={m} />
						)}
					</div>
					{hasNextPage && (
						<div className="border-t p-3 text-center">
							<Button
								disabled={isFetchingNextPage}
								onClick={onLoadMore}
								size="sm"
								variant="outline"
							>
								{isFetchingNextPage && (
									<Loader2 className="size-3.5 animate-spin" />
								)}
								{m.admin_page_pagination_load_more()}
							</Button>
						</div>
					)}
				</section>

				<aside className="bg-background/40 p-4">
					{focused ? (
						<EvidencePanel
							event={focused}
							m={m}
							onOpen={() => onSelectEvent(focused)}
						/>
					) : (
						<div className="flex h-full flex-col items-center justify-center gap-2 text-center">
							<Eye className="size-5 text-muted-foreground" />
							<p className="font-medium text-sm">
								{m.admin_console_evidence_empty_title()}
							</p>
							<p className="text-muted-foreground text-xs">
								{m.admin_console_evidence_empty_description()}
							</p>
						</div>
					)}
				</aside>
			</div>
		</div>
	);
}

function FilterBar({
	filters,
	m,
	members,
	onReset,
	onUpdate,
}: {
	filters: Filters;
	m: AdminMessageCatalog;
	members: readonly TeamMember[];
	onReset: () => void;
	onUpdate: (next: Partial<Filters>) => void;
}) {
	return (
		<div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2">
			<div className="relative min-w-52 flex-1">
				<Search className="absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
				<Input
					className="h-8 pl-8"
					onChange={(event) => onUpdate({ search: event.target.value })}
					placeholder={m.admin_page_filter_search_placeholder()}
					value={filters.search}
				/>
			</div>
			<Select
				onValueChange={(value) =>
					onUpdate({ actionGroup: value as ActionGroup })
				}
				value={filters.actionGroup}
			>
				<SelectTrigger className="h-8 w-36">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{(
						["all", "auth", "team", "vault", "item", "share", "other"] as const
					).map((value) => (
						<SelectItem key={value} value={value}>
							{getActionGroupLabel(value, m)}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<Select
				onValueChange={(value) => onUpdate({ result: value as ResultFilter })}
				value={filters.result}
			>
				<SelectTrigger className="h-8 w-32">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{(["all", "success", "failure"] as const).map((value) => (
						<SelectItem key={value} value={value}>
							{getResultLabel(value, m)}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<Select
				onValueChange={(value) => onUpdate({ actorUserId: value })}
				value={filters.actorUserId}
			>
				<SelectTrigger className="h-8 w-40">
					<SelectValue placeholder={m.admin_page_filter_actor_placeholder()} />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="all">
						{m.admin_page_filter_actor_option_all()}
					</SelectItem>
					{members.map((member) => (
						<SelectItem key={member.userId} value={member.userId}>
							{member.name}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<Button onClick={onReset} size="sm" variant="ghost">
				{m.admin_page_filter_reset()}
			</Button>
		</div>
	);
}

function ViewButton({
	active,
	icon: Icon,
	label,
	onClick,
}: {
	active: boolean;
	icon: typeof Activity;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			className={cn(
				"relative flex h-8 w-full items-center gap-2 rounded-sm px-2 text-xs transition-colors hover:bg-accent",
				active &&
					"bg-selected shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-primary)_14%,transparent)]",
			)}
			onClick={onClick}
			type="button"
		>
			{active && (
				<span
					aria-hidden
					className="absolute top-[6px] bottom-[6px] -left-1 w-0.5 rounded-full bg-primary shadow-[0_0_8px_color-mix(in_oklab,var(--color-primary)_80%,transparent)]"
				/>
			)}
			<Icon className="size-3.5 shrink-0 text-muted-foreground" />
			<span className="flex-1 truncate text-left">{label}</span>
		</button>
	);
}

function EventLine({
	active,
	event,
	m,
	onClick,
}: {
	active: boolean;
	event: TeamEvent;
	m: AdminMessageCatalog;
	onClick: () => void;
}) {
	return (
		<button
			className={cn(
				"grid w-full grid-cols-[95px_minmax(160px,1fr)_minmax(120px,.7fr)_72px] items-center px-3 py-3 text-left text-xs transition-colors hover:bg-foreground/4",
				active &&
					"bg-selected shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-primary)_14%,transparent)]",
			)}
			onClick={onClick}
			type="button"
		>
			<span className="text-muted-foreground">
				{formatTimestamp(event.timestamp)}
			</span>
			<span className="truncate pr-3 font-medium">
				{getEventActionLabel(event.action, m)}
			</span>
			<span className="truncate pr-3 text-muted-foreground">
				{getActorLabel(event, m)}
			</span>
			<span
				className={
					event.result === "failure" ? "text-destructive" : "text-success"
				}
			>
				{getResultLabel(event.result, m)}
			</span>
		</button>
	);
}

function EvidencePanel({
	event,
	m,
	onOpen,
}: {
	event: TeamEvent;
	m: AdminMessageCatalog;
	onOpen: () => void;
}) {
	return (
		<div>
			<div className="flex items-center gap-2">
				<div
					className={cn(
						"flex size-8 shrink-0 items-center justify-center rounded-md border",
						event.result === "failure"
							? "border-destructive/30 bg-destructive/10 text-destructive"
							: "border-success/30 bg-success/10 text-success",
					)}
				>
					{event.result === "failure" ? (
						<AlertTriangle className="size-3.5" />
					) : (
						<Check className="size-3.5" />
					)}
				</div>
				<div className="min-w-0">
					<p className="truncate font-semibold text-sm">
						{getEventActionLabel(event.action, m)}
					</p>
					<p className="truncate text-muted-foreground text-xs">
						{getSourceLabel(event.source, m)}
					</p>
				</div>
			</div>
			<div className="mt-5 space-y-1">
				<Evidence
					label={m.admin_page_detail_label_timestamp()}
					value={formatTimestamp(event.timestamp)}
				/>
				<Evidence
					label={m.admin_page_detail_label_actor()}
					value={getActorLabel(event, m)}
				/>
				<Evidence
					label={m.admin_page_table_header_entity()}
					value={`${getEntityTypeLabel(event.entity.type, m)} · ${
						event.entity.id?.slice(0, 8) || m.admin_page_fallback_empty()
					}`}
				/>
				<Evidence
					label={m.admin_page_detail_label_ip_address()}
					value={event.network.maskedIp || m.admin_page_fallback_empty()}
				/>
				<Evidence
					label={m.admin_page_detail_label_user_agent()}
					value={event.network.maskedUserAgent || m.admin_page_fallback_empty()}
				/>
			</div>
			<Button className="mt-5 w-full" onClick={onOpen} variant="outline">
				<Eye className="size-3.5" />
				{m.admin_page_table_action_view()}
			</Button>
		</div>
	);
}

function Evidence({ label, value }: { label: string; value: string }) {
	return (
		<div className="border-b py-2.5 last:border-0">
			<p className="text-[10px] text-muted-foreground uppercase tracking-[0.06em]">
				{label}
			</p>
			<p className="mt-1 break-all text-xs">{value}</p>
		</div>
	);
}

/* -------------------------------------------------------------------------- */
/*                                   Shared                                    */
/* -------------------------------------------------------------------------- */

function LoadingRows() {
	return (
		<div className="space-y-2 p-4">
			<Skeleton className="h-11 w-full" />
			<Skeleton className="h-11 w-full" />
			<Skeleton className="h-11 w-full" />
		</div>
	);
}

function EmptyState({ m }: { m: AdminMessageCatalog }) {
	return (
		<div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
			<History className="size-6 text-muted-foreground" />
			<p className="font-medium text-sm">{m.admin_page_empty_title()}</p>
			<p className="text-muted-foreground text-xs">
				{m.admin_page_empty_description()}
			</p>
		</div>
	);
}

function EventDialog({
	event,
	m,
	onClose,
}: {
	event: TeamEvent | null;
	m: AdminMessageCatalog;
	onClose: () => void;
}) {
	return (
		<Dialog onOpenChange={(open) => !open && onClose()} open={!!event}>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>
						{event
							? getEventActionLabel(event.action, m)
							: m.admin_page_dialog_fallback_title()}
					</DialogTitle>
					<DialogDescription>
						{m.admin_page_dialog_description()}
					</DialogDescription>
				</DialogHeader>
				{event && (
					<ScrollArea className="max-h-[70vh]">
						<div className="space-y-4">
							<div className="grid gap-2 sm:grid-cols-2">
								<Detail
									label={m.admin_page_detail_label_timestamp()}
									value={formatTimestamp(event.timestamp)}
								/>
								<Detail
									className={
										event.result === "failure"
											? "text-destructive"
											: "text-success"
									}
									label={m.admin_page_detail_label_result()}
									value={getResultLabel(event.result, m)}
								/>
								<Detail
									label={m.admin_page_detail_label_actor()}
									value={getActorLabel(event, m)}
								/>
								<Detail
									label={m.admin_page_detail_label_source()}
									value={getSourceLabel(event.source, m)}
								/>
								<Detail
									label={m.admin_page_detail_label_entity_type()}
									value={getEntityTypeLabel(event.entity.type, m)}
								/>
								<Detail
									label={m.admin_page_detail_label_entity_id()}
									value={event.entity.id || m.admin_page_fallback_empty()}
								/>
							</div>
							<div className="space-y-2 rounded-lg border bg-foreground/3 p-3">
								<h3 className="font-medium text-sm">
									{m.admin_page_section_network_details()}
								</h3>
								<Detail
									label={m.admin_page_detail_label_ip_address()}
									value={event.network.fullIp || m.admin_page_fallback_empty()}
								/>
								<Detail
									label={m.admin_page_detail_label_user_agent()}
									value={
										event.network.fullUserAgent || m.admin_page_fallback_empty()
									}
								/>
							</div>
							<div className="space-y-2 rounded-lg border bg-foreground/3 p-3">
								<h3 className="font-medium text-sm">
									{m.admin_page_section_metadata()}
								</h3>
								<pre className="overflow-x-auto rounded-md border bg-foreground/3 p-3 text-xs">
									{JSON.stringify(event.metadata, null, 2)}
								</pre>
							</div>
						</div>
					</ScrollArea>
				)}
			</DialogContent>
		</Dialog>
	);
}

function Detail({
	className,
	label,
	value,
}: {
	className?: string;
	label: string;
	value: string;
}) {
	return (
		<div className="space-y-1 rounded-md border bg-foreground/3 p-2">
			<p className="text-muted-foreground text-xs">{label}</p>
			<p className={className ?? "break-all text-sm"}>{value}</p>
		</div>
	);
}
