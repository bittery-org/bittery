import { useTeamAvatar } from "@bittery/core/hooks";
import { useTRPCClient } from "@bittery/shared/trpc";
import {
	Avatar,
	AvatarFallback,
	AvatarImage,
	Button,
	Card,
	CardContent,
	Input,
	Label,
	Separator,
	toast,
} from "@bittery/ui";
import {
	IconTriangleWarningOutlineDuo18 as AlertTriangle,
	IconCalendarOutlineDuo18 as Calendar,
	IconGear3OutlineDuo18 as Settings,
	IconUpload4OutlineDuo18 as Upload,
	IconXmarkOutlineDuo18 as X,
} from "@bittery/ui/icons";
import { useMutation } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useQueryInvalidator } from "../../providers/sync-provider";
import { DeleteTeamDialog } from "./delete-team-dialog";
import { LeaveTeamDialog } from "./leave-team-dialog";

interface TeamSettingsProps {
	teamId: string;
	teamName: string;
	userRole: string;
	imageUrl?: string | null;
	createdAt: Date | string;
	updatedAt: Date | string;
	isSelfHostedMode?: boolean;
}

export function TeamSettings({
	teamId,
	teamName,
	userRole,
	imageUrl,
	createdAt,
	updatedAt,
	isSelfHostedMode = false,
}: TeamSettingsProps) {
	const [isEditing, setIsEditing] = useState(false);
	const [name, setName] = useState(teamName);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const trpcClient = useTRPCClient();
	const invalidator = useQueryInvalidator();
	const { uploadAvatar, removeAvatar, isUploading, isRemoving } =
		useTeamAvatar();

	const isOwner = userRole === "owner";
	const canEdit = isOwner || userRole === "admin";

	const updateMutation = useMutation({
		mutationFn: (input: { teamId: string; name: string }) =>
			trpcClient.team.update.mutate(input),
		onSuccess: async () => {
			toast.success("Team name updated");
			await invalidator.invalidateTeam();
			setIsEditing(false);
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

	const handleStartEdit = () => {
		setName(teamName);
		setIsEditing(true);
	};

	const handleSave = () => {
		if (!name.trim()) return;
		updateMutation.mutate({ teamId, name: name.trim() });
	};

	const handleCancel = () => {
		setName(teamName);
		setIsEditing(false);
	};

	const handleFileSelect = async (
		event: React.ChangeEvent<HTMLInputElement>,
	) => {
		const file = event.target.files?.[0];
		if (!file) return;

		try {
			await uploadAvatar({ teamId, file });
			toast.success("Team avatar updated");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to upload avatar",
			);
		}

		// Reset input
		if (fileInputRef.current) {
			fileInputRef.current.value = "";
		}
	};

	const handleRemoveAvatar = async () => {
		try {
			await removeAvatar({ teamId });
			toast.success("Team avatar removed");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to remove avatar",
			);
		}
	};

	const getTeamInitials = () => {
		return teamName
			.split(" ")
			.map((word) => word[0])
			.join("")
			.toUpperCase()
			.slice(0, 2);
	};

	return (
		<div className="space-y-6">
			{/* General Settings */}
			<Card className="overflow-hidden border-border/70 pt-0">
				<CardContent className="p-0">
					{/* Settings header */}
					<div className="border-b bg-muted/30 px-6 py-4">
						<div className="flex items-center gap-2.5">
							<div className="inline-flex size-8 items-center justify-center rounded-lg border bg-background text-muted-foreground">
								<Settings className="h-4 w-4" />
							</div>
							<div>
								<h3 className="font-semibold text-sm">General Settings</h3>
								<p className="text-muted-foreground text-xs">
									Manage your team's identity and basic information.
								</p>
							</div>
						</div>
					</div>

					<div className="space-y-6 p-6">
						{/* Team Avatar & Name Row */}
						<div className="flex flex-col gap-6 sm:flex-row sm:items-start">
							{/* Avatar Section */}
							<div className="flex flex-col items-center gap-3">
								<Avatar className="h-20 w-20 rounded-xl border shadow-sm">
									{imageUrl && <AvatarImage src={imageUrl} alt={teamName} />}
									<AvatarFallback className="rounded-xl text-xl">
										{getTeamInitials()}
									</AvatarFallback>
								</Avatar>
								{canEdit && (
									<div className="flex gap-1.5">
										<Button
											variant="outline"
											size="sm"
											className="h-7 px-2.5 text-xs"
											onClick={() => fileInputRef.current?.click()}
											disabled={isUploading || isRemoving}
										>
											<Upload className="mr-1.5 h-3.5 w-3.5" />
											{isUploading ? "..." : "Upload"}
										</Button>
										{imageUrl && (
											<Button
												variant="outline"
												size="sm"
												className="h-7 px-2.5 text-xs"
												onClick={handleRemoveAvatar}
												disabled={isUploading || isRemoving}
											>
												<X className="mr-1.5 h-3.5 w-3.5" />
												{isRemoving ? "..." : "Remove"}
											</Button>
										)}
									</div>
								)}
								<p className="text-center text-[10px] text-muted-foreground">
									Max 5 MB · PNG, JPG, GIF
								</p>
								<input
									ref={fileInputRef}
									type="file"
									accept="image/*"
									onChange={handleFileSelect}
									className="hidden"
								/>
							</div>

							{/* Name Section */}
							<div className="flex-1 space-y-4">
								<div className="space-y-2">
									<Label
										htmlFor="teamName"
										className="font-medium text-muted-foreground text-xs uppercase tracking-[0.12em]"
									>
										Team Name
									</Label>
									{isEditing ? (
										<div className="flex gap-2">
											<Input
												id="teamName"
												value={name}
												onChange={(e) => setName(e.target.value)}
												placeholder="Enter team name"
												className="h-9"
											/>
											<Button
												size="sm"
												onClick={handleSave}
												disabled={updateMutation.isPending || !name.trim()}
											>
												{updateMutation.isPending ? "Saving..." : "Save"}
											</Button>
											<Button
												variant="outline"
												size="sm"
												onClick={handleCancel}
											>
												Cancel
											</Button>
										</div>
									) : (
										<div className="flex items-center gap-2.5">
											<span className="font-medium text-lg">{teamName}</span>
											{canEdit && (
												<Button
													variant="outline"
													size="sm"
													className="h-7 px-2.5 text-xs"
													onClick={handleStartEdit}
												>
													Edit
												</Button>
											)}
										</div>
									)}
								</div>

								<Separator />

								{/* Team Metadata */}
								<div className="grid gap-4 sm:grid-cols-2">
									<div className="flex items-center gap-3 rounded-lg border bg-background/70 p-3">
										<div className="inline-flex size-8 items-center justify-center rounded-md bg-muted/60 text-muted-foreground">
											<Calendar className="h-4 w-4" />
										</div>
										<div>
											<p className="text-[10px] text-muted-foreground uppercase tracking-[0.12em]">
												Created
											</p>
											<p className="font-medium text-sm">
												{new Date(createdAt).toLocaleDateString("en-US", {
													month: "short",
													day: "numeric",
													year: "numeric",
												})}
											</p>
										</div>
									</div>
									<div className="flex items-center gap-3 rounded-lg border bg-background/70 p-3">
										<div className="inline-flex size-8 items-center justify-center rounded-md bg-muted/60 text-muted-foreground">
											<Calendar className="h-4 w-4" />
										</div>
										<div>
											<p className="text-[10px] text-muted-foreground uppercase tracking-[0.12em]">
												Last Updated
											</p>
											<p className="font-medium text-sm">
												{new Date(updatedAt).toLocaleDateString("en-US", {
													month: "short",
													day: "numeric",
													year: "numeric",
												})}
											</p>
										</div>
									</div>
								</div>
							</div>
						</div>
					</div>
				</CardContent>
			</Card>

			{/* Danger Zone */}
			{!isSelfHostedMode && (
				<Card className="overflow-hidden border-destructive/30 pt-0">
					<CardContent className="p-0">
						<div className="border-destructive/20 border-b bg-destructive/5 px-6 py-4">
							<div className="flex items-center gap-2.5">
								<div className="inline-flex size-8 items-center justify-center rounded-lg border border-destructive/25 bg-destructive/10 text-destructive">
									<AlertTriangle className="h-4 w-4" />
								</div>
								<div>
									<h3 className="font-semibold text-destructive text-sm">
										Danger Zone
									</h3>
									<p className="text-muted-foreground text-xs">
										Irreversible actions that affect this team.
									</p>
								</div>
							</div>
						</div>

						<div className="space-y-4 p-6">
							{/* Leave Team (for non-owners) */}
							{!isOwner && (
								<div className="flex flex-col gap-3 rounded-lg border bg-background/70 p-4 sm:flex-row sm:items-center sm:justify-between">
									<div className="space-y-0.5">
										<span className="font-medium text-sm">Leave Team</span>
										<p className="text-muted-foreground text-xs">
											Remove yourself and lose access to all team vaults.
										</p>
									</div>
									<LeaveTeamDialog teamId={teamId} teamName={teamName} />
								</div>
							)}

							{/* Delete Team (for owners only) */}
							{isOwner && (
								<div className="flex flex-col gap-3 rounded-lg border bg-background/70 p-4 sm:flex-row sm:items-center sm:justify-between">
									<div className="space-y-0.5">
										<span className="font-medium text-sm">Delete Team</span>
										<p className="text-muted-foreground text-xs">
											Permanently delete this team and all associated data.
										</p>
									</div>
									<DeleteTeamDialog teamId={teamId} teamName={teamName} />
								</div>
							)}
						</div>
					</CardContent>
				</Card>
			)}
		</div>
	);
}
