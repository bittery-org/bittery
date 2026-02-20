import { useTRPCClient } from "@bittery/shared/trpc";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
	Button,
	toast,
} from "@bittery/ui";
import { IconArrowDoorOutOutlineDuo18 as LogOut } from "@bittery/ui/icons";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useQueryInvalidator } from "../../providers/sync-provider";

interface LeaveTeamDialogProps {
	teamId: string;
	teamName: string;
}

export function LeaveTeamDialog({ teamId, teamName }: LeaveTeamDialogProps) {
	const [open, setOpen] = useState(false);
	const trpcClient = useTRPCClient();
	const invalidator = useQueryInvalidator();
	const navigate = useNavigate();

	const leaveMutation = useMutation({
		mutationFn: () => trpcClient.team.leave.mutate({ teamId }),
		onSuccess: async () => {
			toast.success("You have left the team");
			await invalidator.invalidateTeam();
			setOpen(false);
			navigate({ to: "/team" });
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

	return (
		<AlertDialog open={open} onOpenChange={setOpen}>
			<AlertDialogTrigger asChild>
				<Button variant="outline">
					<LogOut className="mr-2 h-4 w-4" />
					Leave Team
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Leave Team</AlertDialogTitle>
					<AlertDialogDescription>
						Are you sure you want to leave <strong>{teamName}</strong>? You will
						lose access to all team vaults and will need to be re-invited to
						rejoin.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction
						onClick={() => leaveMutation.mutate()}
						disabled={leaveMutation.isPending}
					>
						{leaveMutation.isPending ? "Leaving..." : "Leave Team"}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
