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
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { LogOut } from "lucide-react";
import { useState } from "react";

interface LeaveTeamDialogProps {
	teamId: string;
	teamName: string;
}

export function LeaveTeamDialog({ teamId, teamName }: LeaveTeamDialogProps) {
	const [open, setOpen] = useState(false);
	const trpcClient = useTRPCClient();
	const queryClient = useQueryClient();
	const navigate = useNavigate();

	const leaveMutation = useMutation({
		mutationFn: () => trpcClient.team.leave.mutate({ teamId }),
		onSuccess: () => {
			toast.success("You have left the team");
			queryClient.invalidateQueries({ queryKey: ["team"] });
			setOpen(false);
			navigate({ to: "/teams" });
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
