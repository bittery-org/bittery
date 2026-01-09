import { useTRPCClient } from "@bittery/shared/trpc";
import {
	Badge,
	Button,
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
	toast,
} from "@bittery/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, X } from "lucide-react";

interface Invitation {
	id: string;
	email: string;
	role: string;
	status: string;
	invitedBy: string;
	createdAt: Date;
	expiresAt: Date;
}

interface PendingInvitationsListProps {
	teamId: string;
	invitations: Invitation[];
	canManage: boolean;
}

export function PendingInvitationsList({
	invitations,
	canManage,
}: PendingInvitationsListProps) {
	const trpcClient = useTRPCClient();
	const queryClient = useQueryClient();

	const cancelMutation = useMutation({
		mutationFn: (input: { invitationId: string }) =>
			trpcClient.team.invitations.cancel.mutate(input),
		onSuccess: () => {
			toast.success("Invitation cancelled");
			queryClient.invalidateQueries({ queryKey: ["team"] });
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

	const resendMutation = useMutation({
		mutationFn: (input: { invitationId: string }) =>
			trpcClient.team.invitations.resend.mutate(input),
		onSuccess: () => {
			toast.success("Invitation resent");
			queryClient.invalidateQueries({ queryKey: ["team"] });
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

	if (invitations.length === 0) {
		return (
			<p className="py-4 text-center text-muted-foreground">
				No pending invitations
			</p>
		);
	}

	const isExpired = (expiresAt: Date) => new Date(expiresAt) < new Date();

	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>Email</TableHead>
					<TableHead>Role</TableHead>
					<TableHead>Invited By</TableHead>
					<TableHead>Status</TableHead>
					{canManage && <TableHead className="w-[100px]">Actions</TableHead>}
				</TableRow>
			</TableHeader>
			<TableBody>
				{invitations.map((invitation) => (
					<TableRow key={invitation.id}>
						<TableCell className="font-medium">{invitation.email}</TableCell>
						<TableCell>
							<Badge variant="secondary">{invitation.role}</Badge>
						</TableCell>
						<TableCell className="text-muted-foreground">
							{invitation.invitedBy}
						</TableCell>
						<TableCell>
							{isExpired(invitation.expiresAt) ? (
								<Badge variant="destructive">Expired</Badge>
							) : (
								<Badge variant="outline">Pending</Badge>
							)}
						</TableCell>
						{canManage && (
							<TableCell>
								<div className="flex gap-1">
									<Button
										variant="ghost"
										size="icon"
										onClick={() =>
											resendMutation.mutate({ invitationId: invitation.id })
										}
										disabled={resendMutation.isPending}
										title="Resend invitation"
									>
										<RefreshCw className="h-4 w-4" />
									</Button>
									<Button
										variant="ghost"
										size="icon"
										onClick={() =>
											cancelMutation.mutate({ invitationId: invitation.id })
										}
										disabled={cancelMutation.isPending}
										title="Cancel invitation"
									>
										<X className="h-4 w-4 text-destructive" />
									</Button>
								</div>
							</TableCell>
						)}
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}
