import { useTRPCClient } from "@bittery/shared/trpc";
import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
	Input,
	Label,
	toast,
} from "@bittery/ui";
import { IconPlusOutlineDuo18 as Plus } from "@bittery/ui/icons";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useQueryInvalidator } from "../../providers/sync-provider";

export function CreateTeamDialog() {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const trpcClient = useTRPCClient();
	const invalidator = useQueryInvalidator();

	const createMutation = useMutation({
		mutationFn: (input: { name: string }) =>
			trpcClient.team.create.mutate(input),
		onSuccess: async () => {
			toast.success("Team created");
			await invalidator.invalidateTeam();
			setOpen(false);
			setName("");
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!name.trim()) return;
		createMutation.mutate({ name: name.trim() });
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button>
					<Plus className="mr-2 h-4 w-4" />
					Create Team
				</Button>
			</DialogTrigger>
			<DialogContent>
				<form onSubmit={handleSubmit}>
					<DialogHeader>
						<DialogTitle>Create Team</DialogTitle>
						<DialogDescription>
							Create a new team to collaborate with others.
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-4 py-4">
						<div className="grid gap-2">
							<Label htmlFor="name">Team Name</Label>
							<Input
								id="name"
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="My Team"
								autoFocus
							/>
						</div>
					</div>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => setOpen(false)}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={createMutation.isPending}>
							{createMutation.isPending ? "Creating..." : "Create"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
