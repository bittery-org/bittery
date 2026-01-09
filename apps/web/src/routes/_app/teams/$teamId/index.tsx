import { useTRPC } from "@bittery/shared/trpc";
import {
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Input,
	Label,
	Skeleton,
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
	toast
} from "@bittery/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Mail, Settings, Users } from "lucide-react";
import { useState } from "react";
import { InviteDialog } from "@/components/teams/invite-dialog";
import { MemberList } from "@/components/teams/member-list";
import { PendingInvitationsList } from "@/components/teams/pending-invitations-list";

export const Route = createFileRoute("/_app/teams/$teamId/")({
	component: TeamDetailPage,
});

function TeamDetailPage() {
	const { teamId } = Route.useParams();
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const [isEditing, setIsEditing] = useState(false);
	const [teamName, setTeamName] = useState("");

	const teamQuery = useQuery(trpc.team.get.queryOptions({ teamId }));
	const membersQuery = useQuery(trpc.team.members.list.queryOptions({ teamId }));
	const invitationsQuery = useQuery(trpc.team.invitations.list.queryOptions({ teamId }));

	const updateMutation = useMutation({
		...trpc.team.update.mutationOptions(),
		onSuccess: () => {
			toast.success("Team name updated");
			queryClient.invalidateQueries({ queryKey: ["team"] });
			setIsEditing(false);
		},
		onError: (error) => {
			toast.error(error.message);
		},
	});

	const team = teamQuery.data;
	const canEdit = team?.userRole === "owner" || team?.userRole === "admin";

	const handleStartEdit = () => {
		setTeamName(team?.name || "");
		setIsEditing(true);
	};

	const handleSave = () => {
		if (!teamName.trim()) return;
		updateMutation.mutate({ teamId, name: teamName.trim() });
	};

	if (teamQuery.isLoading) {
		return (
			<div className="space-y-6">
				<Skeleton className="h-8 w-48" />
				<Skeleton className="h-64" />
			</div>
		);
	}

	if (!team) {
		return (
			<div className="text-center py-8">
				<p className="text-muted-foreground">Team not found</p>
				<Link to="/teams" className="text-primary hover:underline">
					Back to teams
				</Link>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<div className="flex items-center gap-4">
				<Link to="/teams">
					<Button variant="ghost" size="icon">
						<ArrowLeft className="h-4 w-4" />
					</Button>
				</Link>
				<div className="flex-1">
					<h1 className="text-3xl font-bold tracking-tight">{team.name}</h1>
					<p className="text-muted-foreground">
						{team.memberCount} member{team.memberCount !== 1 ? "s" : ""} ·
						Created by {team.ownerName}
					</p>
				</div>
				{canEdit && <InviteDialog teamId={teamId} />}
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
							<span className="ml-2 rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground">
								{invitationsQuery.data.length}
							</span>
						) : null}
					</TabsTrigger>
					{canEdit && (
						<TabsTrigger value="settings">
							<Settings className="mr-2 h-4 w-4" />
							Settings
						</TabsTrigger>
					)}
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
							) : (
								<MemberList
									teamId={teamId}
									members={membersQuery.data || []}
									userRole={team.userRole}
								/>
							)}
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
							) : (
								<PendingInvitationsList
									teamId={teamId}
									invitations={invitationsQuery.data || []}
									canManage={canEdit}
								/>
							)}
						</CardContent>
					</Card>
				</TabsContent>

				{canEdit && (
					<TabsContent value="settings" className="mt-4">
						<Card>
							<CardHeader>
								<CardTitle>Team Settings</CardTitle>
								<CardDescription>
									Manage your team's settings.
								</CardDescription>
							</CardHeader>
							<CardContent className="space-y-4">
								<div className="grid gap-2">
									<Label htmlFor="teamName">Team Name</Label>
									{isEditing ? (
										<div className="flex gap-2">
											<Input
												id="teamName"
												value={teamName}
												onChange={(e) => setTeamName(e.target.value)}
											/>
											<Button onClick={handleSave} disabled={updateMutation.isPending}>
												Save
											</Button>
											<Button variant="outline" onClick={() => setIsEditing(false)}>
												Cancel
											</Button>
										</div>
									) : (
										<div className="flex items-center gap-2">
											<span className="text-lg">{team.name}</span>
											<Button variant="outline" size="sm" onClick={handleStartEdit}>
												Edit
											</Button>
										</div>
									)}
								</div>
							</CardContent>
						</Card>
					</TabsContent>
				)}
			</Tabs>
		</div>
	);
}
