import { TeamAvatarError, useTeamAvatar } from "@bittery/core/hooks";
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
import { formatDate } from "@/lib/i18n-format";
import { useI18n } from "@/providers/i18n-provider";
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
	const { m } = useI18n();

	const isOwner = userRole === "owner";
	const canEdit = isOwner || userRole === "admin";

	const updateMutation = useMutation({
		mutationFn: (input: { teamId: string; name: string }) =>
			trpcClient.team.update.mutate(input),
		onSuccess: async () => {
			toast.success(m["team.settings.toast.name_updated"]());
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
			toast.success(m["team.settings.toast.avatar_updated"]());
		} catch (error) {
			if (error instanceof TeamAvatarError) {
				if (error.code === "INVALID_FILE_TYPE") {
					toast.error(m["team.settings.error.avatar_invalid_file_type"]());
				} else if (error.code === "FILE_TOO_LARGE") {
					toast.error(m["team.settings.error.avatar_file_too_large"]());
				} else {
					toast.error(m["team.settings.error.avatar_upload_storage_failed"]());
				}
			} else {
				toast.error(
					error instanceof Error
						? error.message
						: m["team.settings.toast.avatar_upload_failed"](),
				);
			}
		}

		// Reset input
		if (fileInputRef.current) {
			fileInputRef.current.value = "";
		}
	};

	const handleRemoveAvatar = async () => {
		try {
			await removeAvatar({ teamId });
			toast.success(m["team.settings.toast.avatar_removed"]());
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: m["team.settings.toast.avatar_remove_failed"](),
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
								<h3 className="font-semibold text-sm">
									{m["team.settings.general.title"]()}
								</h3>
								<p className="text-muted-foreground text-xs">
									{m["team.settings.general.description"]()}
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
											{isUploading
												? m["team.settings.avatar.button.uploading"]()
												: m["team.settings.avatar.button.upload"]()}
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
												{isRemoving
													? m["team.settings.avatar.button.removing"]()
													: m["team.settings.avatar.button.remove"]()}
											</Button>
										)}
									</div>
								)}
								<p className="text-center text-[10px] text-muted-foreground">
									{m["team.settings.avatar.hint"]()}
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
										{m["team.settings.field.team_name"]()}
									</Label>
									{isEditing ? (
										<div className="flex gap-2">
											<Input
												id="teamName"
												value={name}
												onChange={(e) => setName(e.target.value)}
												placeholder={m["team.settings.placeholder.team_name"]()}
												className="h-9"
											/>
											<Button
												size="sm"
												onClick={handleSave}
												disabled={updateMutation.isPending || !name.trim()}
											>
												{updateMutation.isPending
													? m["team.settings.button.saving"]()
													: m["team.settings.button.save"]()}
											</Button>
											<Button
												variant="outline"
												size="sm"
												onClick={handleCancel}
											>
												{m["team.common.action.cancel"]()}
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
													{m["team.settings.button.edit"]()}
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
												{m["team.settings.metadata.created"]()}
											</p>
											<p className="font-medium text-sm">
												{formatDate(createdAt, {
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
												{m["team.settings.metadata.last_updated"]()}
											</p>
											<p className="font-medium text-sm">
												{formatDate(updatedAt, {
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
										{m["team.settings.danger.title"]()}
									</h3>
									<p className="text-muted-foreground text-xs">
										{m["team.settings.danger.description"]()}
									</p>
								</div>
							</div>
						</div>

						<div className="space-y-4 p-6">
							{/* Leave Team (for non-owners) */}
							{!isOwner && (
								<div className="flex flex-col gap-3 rounded-lg border bg-background/70 p-4 sm:flex-row sm:items-center sm:justify-between">
									<div className="space-y-0.5">
										<span className="font-medium text-sm">
											{m["team.settings.danger.leave.title"]()}
										</span>
										<p className="text-muted-foreground text-xs">
											{m["team.settings.danger.leave.description"]()}
										</p>
									</div>
									<LeaveTeamDialog teamId={teamId} teamName={teamName} />
								</div>
							)}

							{/* Delete Team (for owners only) */}
							{isOwner && (
								<div className="flex flex-col gap-3 rounded-lg border bg-background/70 p-4 sm:flex-row sm:items-center sm:justify-between">
									<div className="space-y-0.5">
										<span className="font-medium text-sm">
											{m["team.settings.danger.delete.title"]()}
										</span>
										<p className="text-muted-foreground text-xs">
											{m["team.settings.danger.delete.description"]()}
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
