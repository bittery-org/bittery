import { useTRPC, useTRPCClient } from "@bittery/shared/trpc";
import {
	Badge,
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	toast,
} from "@bittery/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Check, Clock, Mail, X } from "lucide-react";
import { useQueryInvalidator } from "../../providers/sync-provider";

export function PendingInvitations() {
	const trpc = useTRPC();
	const trpcClient = useTRPCClient();
	const invalidator = useQueryInvalidator();
	const pendingQuery = useQuery(trpc.team.invitations.pending.queryOptions());

	const acceptMutation = useMutation({
		mutationFn: (input: { token: string }) =>
			trpcClient.team.invitations.accept.mutate(input),
		onSuccess: async (data) => {
			toast.success(`Joined ${data.teamName}`);
			await invalidator.invalidateTeamInvitations();
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

	const declineMutation = useMutation({
		mutationFn: (input: { token: string }) =>
			trpcClient.team.invitations.decline.mutate(input),
		onSuccess: async () => {
			toast.success("Invitation declined");
			await invalidator.invalidateTeamInvitations();
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

	if (pendingQuery.isLoading || !pendingQuery.data?.length) {
		return null;
	}

	return (
		<Card className="overflow-hidden border-border/70 py-0">
			<CardHeader className="border-b bg-muted/30 py-5">
				<CardTitle className="flex items-center gap-2">
					<Mail className="h-5 w-5" />
					Pending Invitations
				</CardTitle>
				<CardDescription>
					You have {pendingQuery.data.length} pending team invitation
					{pendingQuery.data.length > 1 ? "s" : ""}
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-3 p-5">
				<div className="space-y-3">
					{pendingQuery.data.map((invitation) => (
						<div
							key={invitation.id}
							className="flex flex-col gap-3 rounded-lg border bg-background/70 p-3 sm:flex-row sm:items-center sm:justify-between"
						>
							<div className="space-y-1">
								<div className="flex flex-wrap items-center gap-2">
									<span className="font-medium">{invitation.teamName}</span>
									<Badge variant="secondary">{invitation.role}</Badge>
								</div>
								<div className="flex flex-wrap items-center gap-3 text-muted-foreground text-sm">
									<span>Invited by {invitation.invitedBy}</span>
									<span className="flex items-center gap-1">
										<Clock className="h-3 w-3" />
										Expires{" "}
										{formatDistanceToNow(new Date(invitation.expiresAt), {
											addSuffix: true,
										})}
									</span>
								</div>
							</div>
							<div className="flex gap-2">
								<Button
									size="sm"
									variant="outline"
									onClick={() =>
										declineMutation.mutate({ token: invitation.token })
									}
									disabled={declineMutation.isPending}
								>
									<X className="h-4 w-4" />
								</Button>
								<Button
									size="sm"
									onClick={() =>
										acceptMutation.mutate({ token: invitation.token })
									}
									disabled={acceptMutation.isPending}
								>
									<Check className="mr-1 h-4 w-4" />
									Accept
								</Button>
							</div>
						</div>
					))}
				</div>
			</CardContent>
		</Card>
	);
}
