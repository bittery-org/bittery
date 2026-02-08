import { useTeamAvatar } from "@bittery/core/hooks";
import { useTRPCClient } from "@bittery/shared/trpc";
import {
	Avatar,
	AvatarFallback,
	AvatarImage,
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Input,
	Label,
	Separator,
	toast,
} from "@bittery/ui";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, Settings, Upload, X } from "lucide-react";
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
}

export function TeamSettings({
	teamId,
	teamName,
	userRole,
	imageUrl,
	createdAt,
	updatedAt,
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
			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<Settings className="h-5 w-5" />
						General Settings
					</CardTitle>
					<CardDescription>
						Manage your team's basic information
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-6">
					{/* Team Name */}
					<div className="grid gap-2">
						<Label htmlFor="teamName">Team Name</Label>
						{isEditing ? (
							<div className="flex gap-2">
								<Input
									id="teamName"
									value={name}
									onChange={(e) => setName(e.target.value)}
									placeholder="Enter team name"
								/>
								<Button
									onClick={handleSave}
									disabled={updateMutation.isPending || !name.trim()}
								>
									{updateMutation.isPending ? "Saving..." : "Save"}
								</Button>
								<Button variant="outline" onClick={handleCancel}>
									Cancel
								</Button>
							</div>
						) : (
							<div className="flex items-center gap-2">
								<span className="text-lg">{teamName}</span>
								{canEdit && (
									<Button variant="outline" size="sm" onClick={handleStartEdit}>
										Edit
									</Button>
								)}
							</div>
						)}
					</div>

					<Separator />

					{/* Team Avatar */}
					<div className="grid gap-4">
						<Label>Team Avatar</Label>
						<div className="flex items-center gap-4">
							<Avatar className="h-16 w-16">
								{imageUrl && <AvatarImage src={imageUrl} alt={teamName} />}
								<AvatarFallback className="text-lg">
									{getTeamInitials()}
								</AvatarFallback>
							</Avatar>
							<div className="flex flex-col gap-2">
								<div className="flex gap-2">
									{canEdit && (
										<>
											<Button
												variant="outline"
												size="sm"
												onClick={() => fileInputRef.current?.click()}
												disabled={isUploading || isRemoving}
											>
												<Upload className="mr-2 h-4 w-4" />
												{isUploading ? "Uploading..." : "Upload"}
											</Button>
											{imageUrl && (
												<Button
													variant="outline"
													size="sm"
													onClick={handleRemoveAvatar}
													disabled={isUploading || isRemoving}
												>
													<X className="mr-2 h-4 w-4" />
													{isRemoving ? "Removing..." : "Remove"}
												</Button>
											)}
										</>
									)}
								</div>
								<p className="text-muted-foreground text-xs">
									Maximum file size: 5MB. Supported formats: PNG, JPG, GIF
								</p>
							</div>
							<input
								ref={fileInputRef}
								type="file"
								accept="image/*"
								onChange={handleFileSelect}
								className="hidden"
							/>
						</div>
					</div>

					<Separator />

					{/* Team Info */}
					<div className="grid gap-4 md:grid-cols-2">
						<div className="space-y-1">
							<Label className="text-muted-foreground text-sm">
								Created At
							</Label>
							<p className="font-medium">
								{new Date(createdAt).toLocaleDateString("en-US", {
									year: "numeric",
									month: "long",
									day: "numeric",
								})}
							</p>
						</div>
						<div className="space-y-1">
							<Label className="text-muted-foreground text-sm">
								Last Updated
							</Label>
							<p className="font-medium">
								{new Date(updatedAt).toLocaleDateString("en-US", {
									year: "numeric",
									month: "long",
									day: "numeric",
								})}
							</p>
						</div>
					</div>
				</CardContent>
			</Card>

			{/* Danger Zone */}
			<Card className="border-destructive/50">
				<CardHeader>
					<CardTitle className="flex items-center gap-2 text-destructive">
						<AlertTriangle className="h-5 w-5" />
						Danger Zone
					</CardTitle>
					<CardDescription>
						Irreversible actions that affect the team
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-6">
					{/* Leave Team (for non-owners) */}
					{!isOwner && (
						<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
							<div className="space-y-1">
								<span className="font-medium text-sm">Leave Team</span>
								<p className="text-muted-foreground text-sm">
									Remove yourself from this team. You will lose access to all
									team vaults.
								</p>
							</div>
							<LeaveTeamDialog teamId={teamId} teamName={teamName} />
						</div>
					)}

					{/* Delete Team (for owners only) */}
					{isOwner && (
						<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
							<div className="space-y-1">
								<span className="font-medium text-sm">Delete Team</span>
								<p className="text-muted-foreground text-sm">
									Permanently delete this team and all associated data. This
									action cannot be undone.
								</p>
							</div>
							<DeleteTeamDialog teamId={teamId} teamName={teamName} />
						</div>
					)}
				</CardContent>
			</Card>
		</div>
	);
}
