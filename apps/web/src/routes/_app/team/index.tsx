/** biome-ignore-all lint/style/noNonNullAssertion: The queries are only enabled when a team id is there */
import { useTRPC } from "@bittery/shared/trpc";
import {
	Avatar,
	AvatarFallback,
	AvatarImage,
	Badge,
	Skeleton,
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@bittery/ui";
import {
	IconEnvelopeOutlineDuo18 as Mail,
	IconGear3OutlineDuo18 as Settings,
	IconUsers6OutlineDuo18 as Users,
} from "@bittery/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { InviteDialog } from "@/components/teams/invite-dialog";
import { MemberList } from "@/components/teams/member-list";
import { PendingInvitationsList } from "@/components/teams/pending-invitations-list";
import { TeamSettings } from "@/components/teams/team-settings";
import { getTeamPageAccess } from "@/lib/team-access";
import { m as messages } from "@/paraglide/messages";
import { useI18n } from "@/providers/i18n-provider";

export const Route = createFileRoute("/_app/team/")({
	component: TeamPage,
	head: () => ({
		meta: [{ title: messages["team.page.meta_title"]() }],
	}),
});

function TeamPage() {
	const trpc = useTRPC();
	const { m } = useI18n();

	const teamListQuery = useQuery(trpc.team.list.queryOptions());
	const teamId = teamListQuery.data?.id;
	const billingEntitlementsQuery = useQuery(
		trpc.billing.entitlements.queryOptions(),
	);
	const registrationStatusQuery = useQuery(
		trpc.auth.registrationStatus.queryOptions(),
	);
	const meQuery = useQuery(trpc.auth.me.queryOptions());
	const teamQuery = useQuery({
		...trpc.team.get.queryOptions({ teamId: teamId! }),
		enabled: !!teamId,
	});
	const team = teamQuery.data;
	const { teamManagementEnabled, canManageTeam, canViewInvitations } =
		getTeamPageAccess({
			userRole: team?.userRole,
			entitlements: billingEntitlementsQuery.data?.entitlements,
		});
	const membersQuery = useQuery({
		...trpc.team.members.list.queryOptions({ teamId: teamId! }),
		enabled: !!teamId,
	});
	const invitationsQuery = useQuery({
		...trpc.team.invitations.list.queryOptions({ teamId: teamId! }),
		enabled: !!teamId && canViewInvitations,
	});

	const isSelfHostedMode = registrationStatusQuery.data?.mode === "self-hosted";
	const isCloudMode = registrationStatusQuery.data?.mode === "cloud";
	const currentUserId = meQuery.data?.id;

	if (teamListQuery.isLoading || teamQuery.isLoading) {
		return (
			<div className="mx-auto w-full max-w-6xl space-y-6">
				<Skeleton className="h-48 w-full rounded-2xl" />
				<div className="grid gap-4 sm:grid-cols-3">
					<Skeleton className="h-24" />
					<Skeleton className="h-24" />
					<Skeleton className="h-24" />
				</div>
				<Skeleton className="h-64" />
			</div>
		);
	}

	if (!team) {
		return (
			<div className="py-8 text-center">
				<p className="text-muted-foreground">
					{m["team.page.empty.no_team"]()}
				</p>
			</div>
		);
	}

	const getTeamInitials = () =>
		team.name
			.split(" ")
			.map((w) => w[0])
			.join("")
			.toUpperCase()
			.slice(0, 2);

	const roleBadgeVariant =
		team.userRole === "owner"
			? "default"
			: team.userRole === "admin"
				? "secondary"
				: "outline";

	const getRoleLabel = (role: string) => {
		switch (role) {
			case "owner":
				return m["team.role.owner"]();
			case "admin":
				return m["team.role.admin"]();
			default:
				return m["team.role.member"]();
		}
	};

	const memberCountLabel =
		team.memberCount === 1
			? m["team.page.hero.member_count_created_by.single"]({
					count: team.memberCount,
					ownerName: team.ownerName,
				})
			: m["team.page.hero.member_count_created_by.plural"]({
					count: team.memberCount,
					ownerName: team.ownerName,
				});

	return (
		<div className="mx-auto flex w-full max-w-6xl flex-col gap-6 pb-3">
			{/* Hero Banner */}
			<section className="relative overflow-hidden rounded-2xl border bg-card p-3 sm:p-5">
				<div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-muted/60 via-transparent to-transparent" />

				<div className="relative flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
					<div className="flex min-w-0 items-center gap-3">
						<Avatar className="h-9 w-9 shrink-0 rounded-lg border shadow-sm sm:h-10 sm:w-10">
							{team.imageUrl && (
								<AvatarImage src={team.imageUrl} alt={team.name} />
							)}
							<AvatarFallback className="rounded-lg text-sm">
								{getTeamInitials()}
							</AvatarFallback>
						</Avatar>
						<div className="min-w-0">
							<div className="flex flex-wrap items-center gap-2">
								<h1 className="truncate font-semibold text-lg tracking-tight sm:text-xl">
									{team.name}
								</h1>
								<Badge
									variant={roleBadgeVariant}
									className="px-1.5 py-0 text-[11px] capitalize"
								>
									{getRoleLabel(team.userRole)}
								</Badge>
							</div>
							<p className="text-muted-foreground text-xs">
								{memberCountLabel}
							</p>
						</div>
					</div>

					{canManageTeam && teamId && (
						<div className="sm:shrink-0">
							<InviteDialog teamId={teamId} />
						</div>
					)}
				</div>
			</section>

			{isCloudMode && !teamManagementEnabled ? (
				<div className="rounded-xl border bg-muted/40 px-4 py-3 text-muted-foreground text-sm">
					{m["team.page.notice.management_unavailable"]()}
				</div>
			) : null}

			{/* Tabs Area */}
			<Tabs defaultValue="members">
				<TabsList className="w-full sm:w-fit">
					<TabsTrigger value="members" className="flex-1 sm:flex-none">
						<Users className="h-4 w-4 sm:mr-2" />
						<span className="hidden sm:inline">
							{m["team.page.tab.members"]()}
						</span>
					</TabsTrigger>
					{canViewInvitations ? (
						<TabsTrigger value="invitations" className="flex-1 sm:flex-none">
							<Mail className="h-4 w-4 sm:mr-2" />
							<span className="hidden sm:inline">
								{m["team.page.tab.invitations"]()}
							</span>
							{invitationsQuery.data?.length ? (
								<span className="ml-1.5 rounded-full bg-primary px-1.5 py-0.5 text-primary-foreground text-xs">
									{invitationsQuery.data.length}
								</span>
							) : null}
						</TabsTrigger>
					) : null}
					<TabsTrigger value="settings" className="flex-1 sm:flex-none">
						<Settings className="h-4 w-4 sm:mr-2" />
						<span className="hidden sm:inline">
							{m["team.page.tab.settings"]()}
						</span>
					</TabsTrigger>
				</TabsList>

				<TabsContent value="members" className="mt-4">
					<div className="space-y-3">
						<div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
							<h2 className="font-semibold text-lg tracking-tight">
								{m["team.page.members.heading"]()}
							</h2>
							<p className="text-muted-foreground text-sm">
								{canManageTeam
									? m["team.page.members.description"]()
									: m["team.page.members.description_read_only"]()}
							</p>
						</div>
						{membersQuery.isLoading ? (
							<div className="grid gap-3 sm:grid-cols-2">
								<Skeleton className="h-28" />
								<Skeleton className="h-28" />
								<Skeleton className="h-28" />
							</div>
						) : teamId ? (
							<MemberList
								teamId={teamId}
								members={membersQuery.data || []}
								currentUserId={currentUserId}
								canManageMembers={canManageTeam}
								isSelfHostedMode={isSelfHostedMode}
							/>
						) : null}
					</div>
				</TabsContent>

				{canViewInvitations ? (
					<TabsContent value="invitations" className="mt-4">
						<div className="space-y-3">
							<div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
								<h2 className="font-semibold text-lg tracking-tight">
									{m["team.page.invitations.heading"]()}
								</h2>
								<p className="text-muted-foreground text-sm">
									{m["team.page.invitations.description"]()}
								</p>
							</div>
							{invitationsQuery.isLoading ? (
								<div className="grid gap-3 sm:grid-cols-2">
									<Skeleton className="h-28" />
									<Skeleton className="h-28" />
								</div>
							) : teamId ? (
								<PendingInvitationsList
									invitations={invitationsQuery.data || []}
									canManage={canManageTeam}
								/>
							) : null}
						</div>
					</TabsContent>
				) : null}

				<TabsContent value="settings" className="mt-4">
					{teamId && (
						<TeamSettings
							teamId={teamId}
							teamName={team.name}
							userRole={team.userRole}
							imageUrl={team.imageUrl}
							createdAt={team.createdAt}
							updatedAt={team.updatedAt}
							isSelfHostedMode={isSelfHostedMode}
						/>
					)}
				</TabsContent>
			</Tabs>
		</div>
	);
}
