import {
	useRuntimeClient,
	useRuntimeSession,
} from "@bittery/client-runtime/react";
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
import { IconLogOut as LogOut } from "@bittery/ui/icons";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
	TeamLeaveFailure,
	type TeamLeaveProgress,
	useRuntimeTeamLeave,
} from "@/hooks/use-runtime-team-leave";
import { useI18n } from "@/providers/i18n-provider";
import { useQueryInvalidator } from "../../providers/transitional-sync-provider";

interface LeaveTeamDialogProps {
	teamId: string;
	teamName: string;
}

export function LeaveTeamDialog({ teamId, teamName }: LeaveTeamDialogProps) {
	const [open, setOpen] = useState(false);
	const [isLeaving, setIsLeaving] = useState(false);
	const [progress, setProgress] = useState<TeamLeaveProgress | null>(null);
	const owner = useRef<AbortController | null>(null);
	const leaveTeam = useRuntimeTeamLeave();
	const client = useRuntimeClient();
	const session = useRuntimeSession();
	const invalidator = useQueryInvalidator();
	const navigate = useNavigate();
	const { m } = useI18n();

	useEffect(() => () => owner.current?.abort(), []);
	useEffect(() => {
		if (
			progress?.accountId &&
			session.state === "unlocked" &&
			session.accountId !== progress.accountId
		)
			owner.current?.abort();
	}, [progress?.accountId, session]);

	const handleResult = async (next: TeamLeaveProgress) => {
		setProgress(next);
		if (next.result.type === "rotationCompleted") {
			await client
				.acknowledgeTeamLeaveAttempt({
					accountId: next.accountId,
					startOperationId: next.startOperationId,
				})
				.catch(() => {});
			toast.success(m.team_leave_dialog_toast_left());
			await invalidator.invalidateTeam();
			setOpen(false);
			navigate({ to: "/team" });
		} else if (
			next.result.type === "rotationRefreshRequired" &&
			next.result.outcome.type === "applied"
		) {
			toast.info(m.team_leave_dialog_refresh_pending());
		}
	};

	const handleLeave = async () => {
		owner.current?.abort();
		const current = new AbortController();
		owner.current = current;
		setIsLeaving(true);
		try {
			const next = progress?.startOperationId
				? await leaveTeam.inspect(
						progress.accountId,
						progress.startOperationId,
						current.signal,
					)
				: await leaveTeam.start(teamId, current.signal);
			if (!current.signal.aborted) await handleResult(next);
		} catch (error) {
			if (!current.signal.aborted) {
				toast.error(
					error instanceof TeamLeaveFailure && error.code === "keyChanged"
						? m.team_leave_dialog_key_changed()
						: m.team_leave_dialog_toast_leave_failed(),
				);
			}
		} finally {
			if (owner.current === current) {
				owner.current = null;
				setIsLeaving(false);
			}
		}
	};

	const status = progress?.result.type;
	const rejected =
		status === "rotationRejected" ||
		status === "rotationStartRejected" ||
		status === "rotationPreparationRequiresCrypto" ||
		status === "rotationAttemptConsumed" ||
		(progress?.result.type === "rotationRefreshRequired" &&
			progress.result.outcome.type === "rejected");

	return (
		<AlertDialog
			open={open}
			onOpenChange={(next) => {
				if (!next) owner.current?.abort();
				setOpen(next);
			}}
		>
			<AlertDialogTrigger asChild>
				<Button variant="outline">
					<LogOut className="mr-2 h-4 w-4" />
					{m.team_leave_dialog_trigger()}
				</Button>
			</AlertDialogTrigger>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{m.team_leave_dialog_title()}</AlertDialogTitle>
					<AlertDialogDescription asChild>
						<div>
							{m.team_leave_dialog_description_prefix()}{" "}
							<strong>{teamName}</strong>{" "}
							{m.team_leave_dialog_description_suffix()}
							{progress && (
								<p role="status" className="mt-3">
									{rejected
										? m.team_leave_dialog_stale()
										: status === "rotationRefreshRequired"
											? m.team_leave_dialog_refresh_pending()
											: status === "rotationCompleted"
												? m.team_leave_dialog_toast_left()
												: m.team_leave_dialog_pending()}
								</p>
							)}
						</div>
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>{m.team_common_action_cancel()}</AlertDialogCancel>
					<AlertDialogAction
						disabled={isLeaving}
						onClick={(event) => {
							// Core retains accepted work, while this dialog owns only the live caller.
							event.preventDefault();
							void handleLeave();
						}}
					>
						{isLeaving
							? m.team_leave_dialog_action_leaving()
							: progress
								? m.team_leave_dialog_action_continue()
								: m.team_leave_dialog_action_confirm()}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
