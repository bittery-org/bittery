/** biome-ignore-all lint/style/noNonNullAssertion: The queries are only enabled when a team id is there */
import { useTRPC } from "@bittery/shared/trpc";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Skeleton,
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@bittery/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Mail, Settings, Users } from "lucide-react";
import { InviteDialog } from "@/components/teams/invite-dialog";
import { MemberList } from "@/components/teams/member-list";
import { PendingInvitationsList } from "@/components/teams/pending-invitations-list";
import { TeamSettings } from "@/components/teams/team-settings";

export const Route = createFileRoute("/_app/team/")({
	component: TeamPage,
	head: () => ({
		meta: [{ title: "Team - Bittery" }],
	}),
});

function TeamPage() {
	const trpc = useTRPC();

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
	const isSelfHostedMode =
		registrationStatusQuery.data?.mode === "self-hosted";
	const currentUserId = meQuery.data?.id;

	if (teamListQuery.isLoading || teamQuery.isLoading) {
		return (
			<div className="space-y-6">
				<Skeleton className="h-8 w-48" />
				<Skeleton className="h-64" />
			</div>
		);
	}

	if (!team) {
		return (
			<div className="py-8 text-center">
				<p className="text-muted-foreground">No team found</p>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<div className="flex items-center gap-4">
				<div className="flex-1">
					<h1 className="font-bold text-3xl tracking-tight">{team.name}</h1>
					<p className="text-muted-foreground">
						{team.memberCount} member{team.memberCount !== 1 ? "s" : ""} ·
						Created by {team.ownerName}
					</p>
				</div>
				{canEdit && teamId && <InviteDialog teamId={teamId} />}
			</div>

			<Tabs defaultValue="members">
				<TabsList>
					<TabsTrigger value="members">
						<Users className="mr-2 h-4 w-4" />
						Members
					</TabsTrigger>
					<TabsTrigger value="invitations">
						<Mail className="mr-2 h-4 w-4" />
						Invitations
						{invitationsQuery.data?.length ? (
							<span className="ml-2 rounded-full bg-primary px-2 py-0.5 text-primary-foreground text-xs">
								{invitationsQuery.data.length}
							</span>
						) : null}
					</TabsTrigger>
					<TabsTrigger value="settings">
						<Settings className="mr-2 h-4 w-4" />
						Settings
					</TabsTrigger>
				</TabsList>

				<TabsContent value="members" className="mt-4">
					<Card>
						<CardHeader>
							<CardTitle>Team Members</CardTitle>
							<CardDescription>
								Manage who has access to this team.
							</CardDescription>
						</CardHeader>
						<CardContent>
							{membersQuery.isLoading ? (
								<Skeleton className="h-32" />
							) : teamId ? (
								<MemberList
									teamId={teamId}
									members={membersQuery.data || []}
									currentUserId={currentUserId}
									currentUserRole={team.userRole}
									isSelfHostedMode={isSelfHostedMode}
								/>
							) : null}
						</CardContent>
					</Card>
				</TabsContent>

				<TabsContent value="invitations" className="mt-4">
					<Card>
						<CardHeader>
							<CardTitle>Pending Invitations</CardTitle>
							<CardDescription>
								Invitations that haven't been accepted yet.
							</CardDescription>
						</CardHeader>
						<CardContent>
							{invitationsQuery.isLoading ? (
								<Skeleton className="h-32" />
							) : teamId ? (
								<PendingInvitationsList
									invitations={invitationsQuery.data || []}
									canManage={canEdit}
								/>
							) : null}
						</CardContent>
					</Card>
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
