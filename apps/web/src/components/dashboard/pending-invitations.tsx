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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Mail, X } from "lucide-react";

export function PendingInvitations() {
	const trpc = useTRPC();
	const trpcClient = useTRPCClient();
	const queryClient = useQueryClient();
	const pendingQuery = useQuery(trpc.team.invitations.pending.queryOptions());

	const acceptMutation = useMutation({
		mutationFn: (input: { token: string }) =>
			trpcClient.team.invitations.accept.mutate(input),
		onSuccess: (data) => {
			toast.success(`Joined ${data.teamName}`);
			queryClient.invalidateQueries({ queryKey: ["team"] });
			queryClient.invalidateQueries({ queryKey: ["team", "invitations"] });
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

	const declineMutation = useMutation({
		mutationFn: (input: { token: string }) =>
			trpcClient.team.invitations.decline.mutate(input),
		onSuccess: () => {
			toast.success("Invitation declined");
			queryClient.invalidateQueries({ queryKey: ["team", "invitations"] });
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

	if (pendingQuery.isLoading || !pendingQuery.data?.length) {
		return null;
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<Mail className="h-5 w-5" />
					Pending Invitations
				</CardTitle>
				<CardDescription>
					You have {pendingQuery.data.length} pending team invitation
					{pendingQuery.data.length > 1 ? "s" : ""}
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="space-y-3">
					{pendingQuery.data.map((invitation) => (
						<div
							key={invitation.id}
							className="flex items-center justify-between rounded-lg border p-3"
						>
							<div className="space-y-1">
								<div className="flex items-center gap-2">
									<span className="font-medium">{invitation.teamName}</span>
									<Badge variant="secondary">{invitation.role}</Badge>
								</div>
								<p className="text-muted-foreground text-sm">
									Invited by {invitation.invitedBy}
								</p>
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
