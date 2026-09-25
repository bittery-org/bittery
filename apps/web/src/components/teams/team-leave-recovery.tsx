import { useRuntimeClient } from "@bittery/client-runtime/react";
import { Button } from "@bittery/ui";
import { useEffect, useRef, useState } from "react";
import {
	type TeamLeaveProgress,
	useRuntimeTeamLeave,
} from "@/hooks/use-runtime-team-leave";
import { useI18n } from "@/providers/i18n-provider";
import { useQueryInvalidator } from "@/providers/transitional-sync-provider";

/** Reads the original retained Operation from Core after a route remount or Session renewal. */
export function TeamLeaveRecovery({ accountId }: { accountId: string }) {
	const client = useRuntimeClient();
	const leave = useRuntimeTeamLeave();
	const invalidator = useQueryInvalidator();
	const { m } = useI18n();
	const [attempts, setAttempts] = useState<
		Array<{ teamId: string; startOperationId: string }>
	>([]);
	const [progress, setProgress] = useState<Record<string, TeamLeaveProgress>>(
		{},
	);
	const [working, setWorking] = useState<string | null>(null);
	const [completed, setCompleted] = useState(false);
	const [failed, setFailed] = useState(false);
	const owner = useRef<AbortController | null>(null);

	useEffect(() => {
		const current = new AbortController();
		owner.current = current;
		client
			.listTeamLeaveAttempts({ accountId }, { signal: current.signal })
			.then((retained) => {
				if (!current.signal.aborted) setAttempts(retained);
			})
			.catch(() => {
				if (!current.signal.aborted) setFailed(true);
			});
		return () => owner.current?.abort();
	}, [accountId, client]);

	const inspect = async (startOperationId: string) => {
		owner.current?.abort();
		const current = new AbortController();
		owner.current = current;
		setWorking(startOperationId);
		setFailed(false);
		try {
			const next = await leave.inspect(
				accountId,
				startOperationId,
				current.signal,
			);
			if (current.signal.aborted) return;
			setProgress((old) => ({ ...old, [startOperationId]: next }));
			if (next.result.type === "rotationCompleted") {
				await client
					.acknowledgeTeamLeaveAttempt(
						{
							accountId,
							startOperationId,
						},
						{ signal: current.signal },
					)
					.catch(() => {});
				setCompleted(true);
				setAttempts((old) =>
					old.filter(
						(attempt) => attempt.startOperationId !== startOperationId,
					),
				);
				await invalidator.invalidateTeam();
			} else if (next.result.type === "rotationRejected") {
				await client
					.acknowledgeTeamLeaveAttempt(
						{
							accountId,
							startOperationId,
						},
						{ signal: current.signal },
					)
					.catch(() => {});
				setAttempts((old) =>
					old.filter(
						(attempt) => attempt.startOperationId !== startOperationId,
					),
				);
				setFailed(true);
			}
		} catch {
			if (!current.signal.aborted) setFailed(true);
		} finally {
			if (owner.current === current) {
				owner.current = null;
				setWorking(null);
			}
		}
	};

	if (!attempts.length && !completed && !failed) return null;
	return (
		<div className="rounded-lg border bg-card p-3 text-sm" role="status">
			<p className="font-medium">{m.team_leave_recovery_title()}</p>
			{completed && (
				<p className="mt-1 text-muted-foreground">
					{m.team_leave_dialog_toast_left()}
				</p>
			)}
			{failed && (
				<p className="mt-1 text-destructive">
					{m.team_leave_dialog_toast_leave_failed()}
				</p>
			)}
			{attempts.map((attempt) => {
				const result = progress[attempt.startOperationId]?.result;
				const rejected =
					result?.type === "rotationRejected" ||
					result?.type === "rotationStartRejected" ||
					result?.type === "rotationAttemptConsumed" ||
					result?.type === "rotationPreparationRequiresCrypto" ||
					(result?.type === "rotationRefreshRequired" &&
						result.outcome.type === "rejected");
				return (
					<div
						key={attempt.startOperationId}
						className="mt-2 flex items-center justify-between gap-3"
					>
						<p className="text-muted-foreground">
							{rejected
								? m.team_leave_dialog_stale()
								: result?.type === "rotationRefreshRequired"
									? m.team_leave_dialog_refresh_pending()
									: m.team_leave_dialog_pending()}
						</p>
						<Button
							data-start-operation-id={attempt.startOperationId}
							variant="outline"
							disabled={working !== null}
							onClick={() => inspect(attempt.startOperationId)}
						>
							{working === attempt.startOperationId
								? m.team_leave_dialog_action_leaving()
								: m.team_leave_dialog_action_continue()}
						</Button>
					</div>
				);
			})}
		</div>
	);
}
