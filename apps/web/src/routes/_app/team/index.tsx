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
	IconVault3OutlineDuo18 as Vault,
} from "@bittery/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { InviteDialog } from "@/components/teams/invite-dialog";
import { MemberList } from "@/components/teams/member-list";
import { PendingInvitationsList } from "@/components/teams/pending-invitations-list";
import { TeamSettings } from "@/components/teams/team-settings";
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
	const registrationStatusQuery = useQuery(
		trpc.auth.registrationStatus.queryOptions(),
	);
	const meQuery = useQuery(trpc.auth.me.queryOptions());

	const teamQuery = useQuery({
		...trpc.team.get.queryOptions({ teamId: teamId! }),
		enabled: !!teamId,
	});
	const membersQuery = useQuery({
		...trpc.team.members.list.queryOptions({ teamId: teamId! }),
		enabled: !!teamId,
	});
	const invitationsQuery = useQuery({
		...trpc.team.invitations.list.queryOptions({ teamId: teamId! }),
		enabled: !!teamId,
	});

	const team = teamQuery.data;
	const canEdit = team?.userRole === "owner" || team?.userRole === "admin";
	const isSelfHostedMode = registrationStatusQuery.data?.mode === "self-hosted";
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

	const activeSeatLabel =
		team.memberCount === 1
			? m["team.page.hero.active_seats.single"]({ count: team.memberCount })
			: m["team.page.hero.active_seats.plural"]({ count: team.memberCount });

	return (
		<div className="mx-auto flex w-full max-w-6xl flex-col gap-6 pb-3">
			{/* Hero Banner */}
			<section className="relative overflow-hidden rounded-2xl border bg-card p-6 sm:p-7">
				<div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-muted/60 via-transparent to-transparent" />
				<div className="pointer-events-none absolute -top-24 right-0 h-56 w-56 rounded-full bg-muted/50 blur-3xl" />

				<div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
					<div className="flex items-start gap-5">
						<Avatar className="h-16 w-16 rounded-xl border shadow-sm">
							{team.imageUrl && (
								<AvatarImage src={team.imageUrl} alt={team.name} />
							)}
							<AvatarFallback className="rounded-xl text-lg">
								{getTeamInitials()}
							</AvatarFallback>
						</Avatar>
						<div className="space-y-3">
							<div className="flex flex-wrap items-center gap-2">
								<Badge variant="secondary" className="w-fit">
									{m["team.page.hero.badge"]()}
								</Badge>
								<Badge variant={roleBadgeVariant}>
									{getRoleLabel(team.userRole)}
								</Badge>
							</div>
							<div className="space-y-1.5">
								<h1 className="text-balance font-bold text-3xl tracking-tight md:text-4xl">
									{team.name}
								</h1>
								<p className="text-muted-foreground">{memberCountLabel}</p>
							</div>
							<div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
								<div className="inline-flex items-center gap-1.5 rounded-md border bg-background/70 px-2.5 py-1">
									<Vault className="h-3.5 w-3.5" />
									{activeSeatLabel}
								</div>
							</div>
						</div>
					</div>

					<div className="flex flex-wrap gap-2 lg:justify-end">
						{canEdit && teamId && <InviteDialog teamId={teamId} />}
					</div>
				</div>
			</section>

			{/* Tabs Area */}
			<Tabs defaultValue="members">
				<TabsList>
					<TabsTrigger value="members">
						<Users className="mr-2 h-4 w-4" />
						{m["team.page.tab.members"]()}
					</TabsTrigger>
					<TabsTrigger value="invitations">
						<Mail className="mr-2 h-4 w-4" />
						{m["team.page.tab.invitations"]()}
						{invitationsQuery.data?.length ? (
							<span className="ml-2 rounded-full bg-primary px-2 py-0.5 text-primary-foreground text-xs">
								{invitationsQuery.data.length}
							</span>
						) : null}
					</TabsTrigger>
					<TabsTrigger value="settings">
						<Settings className="mr-2 h-4 w-4" />
						{m["team.page.tab.settings"]()}
					</TabsTrigger>
				</TabsList>

				<TabsContent value="members" className="mt-4">
					<div className="space-y-3">
						<div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
							<h2 className="font-semibold text-lg tracking-tight">
								{m["team.page.members.heading"]()}
							</h2>
							<p className="text-muted-foreground text-sm">
								{m["team.page.members.description"]()}
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
								currentUserRole={team.userRole}
								isSelfHostedMode={isSelfHostedMode}
							/>
						) : null}
					</div>
				</TabsContent>

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
								canManage={canEdit}
							/>
						) : null}
					</div>
				</TabsContent>

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
