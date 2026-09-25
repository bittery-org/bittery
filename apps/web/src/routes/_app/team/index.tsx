import {
	useRuntimeClient,
	useRuntimeSession,
} from "@bittery/client-runtime/react";
import { m as messages } from "@bittery/i18n/paraglide/messages";
import { useApiClient } from "@bittery/shared/api";
import { apiQueries, apiQueryKeys } from "@bittery/shared/api-query";
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
	IconMail as Mail,
	IconSettings as Settings,
	IconUsers as Users,
} from "@bittery/ui/icons";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { InviteDialog } from "@/components/teams/invite-dialog";
import { MemberList } from "@/components/teams/member-list";
import { PendingInvitationsList } from "@/components/teams/pending-invitations-list";
import { TeamLeaveRecovery } from "@/components/teams/team-leave-recovery";
import { TeamSettings } from "@/components/teams/team-settings";
import { getTeamPageAccess } from "@/lib/team-access";
import { useI18n } from "@/providers/i18n-provider";

export const Route = createFileRoute("/_app/team/")({
	component: TeamPage,
	head: () => ({
		meta: [{ title: messages.team_page_meta_title() }],
	}),
});

function TeamPage() {
	const api = useApiClient();
	const runtime = useRuntimeClient();
	const session = useRuntimeSession();
	const { m } = useI18n();

	const accountId = session.state === "unlocked" ? session.accountId : null;
	const teamPageQuery = useQuery({
		queryKey: [...apiQueryKeys.teams.current, "runtime", accountId],
		queryFn: ({ signal }) => {
			if (!accountId) throw new Error("No unlocked Account");
			return runtime.readTeamPage({ accountId }, { signal });
		},
		enabled: !!accountId,
	});
	const page = teamPageQuery.data;
	const team = page?.team;
	const teamId = team?.id;
	const registrationStatusQuery = useQuery(
		apiQueries.auth.registrationStatus(api),
	);
	const { teamManagementEnabled, canManageTeam, canViewInvitations } =
		getTeamPageAccess({
			userRole: team?.userRole,
			entitlements: page
				? { teamManagement: page.teamManagementEnabled }
				: null,
		});

	const isSelfHostedMode = registrationStatusQuery.data?.mode === "self-hosted";
	const isCloudMode = registrationStatusQuery.data?.mode === "cloud";
	const currentUserId = page?.user.id;

	if (teamPageQuery.isLoading || !accountId) {
		return (
			<div className="mx-auto w-full max-w-6xl space-y-4">
				<Skeleton className="h-48 w-full rounded-lg" />
				<div className="grid gap-4 sm:grid-cols-3">
					<Skeleton className="h-24" />
					<Skeleton className="h-24" />
					<Skeleton className="h-24" />
				</div>
				<Skeleton className="h-64" />
			</div>
		);
	}
	if (teamPageQuery.isError) {
		return (
			<div className="mx-auto w-full max-w-6xl space-y-4 py-8">
				<TeamLeaveRecovery key={accountId} accountId={accountId} />
				<p className="text-center" role="alert">
					{m.team_page_error_load_failed()}
				</p>
			</div>
		);
	}

	if (!team) {
		return (
			<div className="mx-auto w-full max-w-6xl space-y-4 py-8">
				<TeamLeaveRecovery key={accountId} accountId={accountId} />
				<p className="text-center text-muted-foreground">
					{m.team_page_empty_no_team()}
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
				return m.team_role_owner();
			case "admin":
				return m.team_role_admin();
			default:
				return m.team_role_member();
		}
	};

	const memberCountLabel =
		Number(team.memberCount) === 1
			? m.team_page_hero_member_count_created_by_single({
					count: Number(team.memberCount),
					ownerName: team.ownerName,
				})
			: m.team_page_hero_member_count_created_by_plural({
					count: Number(team.memberCount),
					ownerName: team.ownerName,
				});

	return (
		<div className="mx-auto flex w-full max-w-6xl flex-col gap-4 pb-3">
			{/* Page header */}
			<div className="flex flex-col gap-3 sm:flex-row sm:items-center">
				<div className="flex min-w-0 items-center gap-3">
					<Avatar className="size-9 shrink-0 rounded-lg border sm:size-10">
						{team.imageUrl && (
							<AvatarImage src={team.imageUrl} alt={team.name} />
						)}
						<AvatarFallback className="rounded-lg text-sm">
							{getTeamInitials()}
						</AvatarFallback>
					</Avatar>
					<div className="min-w-0">
						<div className="flex flex-wrap items-center gap-2">
							<h1 className="truncate font-semibold text-lg tracking-[-0.015em]">
								{team.name}
							</h1>
							<Badge
								variant={roleBadgeVariant}
								className="px-1.5 py-0 text-[11px] capitalize"
							>
								{getRoleLabel(team.userRole)}
							</Badge>
						</div>
						<p className="text-muted-foreground text-xs">{memberCountLabel}</p>
					</div>
				</div>

				{canManageTeam && teamId && (
					<div className="sm:ml-auto sm:shrink-0">
						<InviteDialog teamId={teamId} />
					</div>
				)}
			</div>

			{isCloudMode && !teamManagementEnabled ? (
				<div className="rounded-lg border bg-card px-4 py-3 text-muted-foreground text-sm">
					{m.team_page_notice_management_unavailable()}
				</div>
			) : null}

			{/* Tabs Area */}
			<TeamLeaveRecovery key={accountId} accountId={accountId} />
			<Tabs defaultValue="members">
				<TabsList className="w-full sm:w-fit">
					<TabsTrigger value="members" className="flex-1 sm:flex-none">
						<Users className="h-4 w-4 sm:mr-2" />
						<span className="hidden sm:inline">
							{m.team_page_tab_members()}
						</span>
					</TabsTrigger>
					{canViewInvitations ? (
						<TabsTrigger value="invitations" className="flex-1 sm:flex-none">
							<Mail className="h-4 w-4 sm:mr-2" />
							<span className="hidden sm:inline">
								{m.team_page_tab_invitations()}
							</span>
							{page?.invitations.length ? (
								<span className="ml-1.5 rounded-full border bg-foreground/3 px-1.5 text-[10px] text-muted-foreground tabular-nums">
									{page.invitations.length}
								</span>
							) : null}
						</TabsTrigger>
					) : null}
					<TabsTrigger value="settings" className="flex-1 sm:flex-none">
						<Settings className="h-4 w-4 sm:mr-2" />
						<span className="hidden sm:inline">
							{m.team_page_tab_settings()}
						</span>
					</TabsTrigger>
				</TabsList>

				<TabsContent value="members" className="mt-4">
					<div className="space-y-3">
						<div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
							<h2 className="font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
								{m.team_page_members_heading()}
							</h2>
							<p className="text-muted-foreground text-sm">
								{canManageTeam
									? m.team_page_members_description()
									: m.team_page_members_description_read_only()}
							</p>
						</div>
						{teamId ? (
							<MemberList
								teamId={teamId}
								members={[...(page?.members || [])]}
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
								<h2 className="font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
									{m.team_page_invitations_heading()}
								</h2>
								<p className="text-muted-foreground text-sm">
									{m.team_page_invitations_description()}
								</p>
							</div>
							{teamId ? (
								<PendingInvitationsList
									invitations={[...(page?.invitations || [])]}
									canManage={canManageTeam}
									accountId={accountId}
									teamId={teamId}
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
