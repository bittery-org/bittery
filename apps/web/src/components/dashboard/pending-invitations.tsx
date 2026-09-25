import {
	useRuntimeClient,
	useRuntimeSession,
} from "@bittery/client-runtime/react";
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
import {
	IconCheck as Check,
	IconClock as Clock,
	IconMail as Mail,
	IconX as X,
} from "@bittery/ui/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { de as dateFnsDe, enUS as dateFnsEnUS } from "date-fns/locale";
import { useEffect, useRef } from "react";
import { useI18n } from "@/providers/i18n-provider";
import { useQueryInvalidator } from "../../providers/transitional-sync-provider";

export function PendingInvitations() {
	const runtime = useRuntimeClient();
	const session = useRuntimeSession();
	const queryClient = useQueryClient();
	const accountId = session.state === "unlocked" ? session.accountId : null;
	const activeMutation = useRef<AbortController | null>(null);
	const invalidator = useQueryInvalidator();
	const pendingQuery = useQuery({
		queryKey: ["runtime", "myTeamInvitations", accountId],
		queryFn: ({ signal }) => {
			if (!accountId) throw new Error("No unlocked Account");
			return runtime.listMyTeamInvitations({ accountId }, { signal });
		},
		enabled: !!accountId,
	});
	const { locale, m } = useI18n();
	useEffect(() => {
		if (accountId === null) activeMutation.current?.abort();
		return () => activeMutation.current?.abort();
	}, [accountId]);
	const refresh = async () => {
		await Promise.all([
			queryClient.invalidateQueries({
				queryKey: ["runtime", "myTeamInvitations", accountId],
			}),
			invalidator.invalidateTeamInvitations(),
		]);
	};

	// Invitations are addressed by id here: only the SHA-256 digest of the token
	// is stored server-side, so the pending list cannot hand back the raw token.
	const acceptMutation = useMutation({
		mutationFn: async (input: { invitationId: string }) => {
			if (!accountId) throw new Error(m.team_page_error_load_failed());
			const controller = new AbortController();
			activeMutation.current = controller;
			try {
				const result = await runtime.acceptMyTeamInvitation(
					{ accountId, invitationId: input.invitationId },
					{ signal: controller.signal },
				);
				return result;
			} finally {
				if (activeMutation.current === controller)
					activeMutation.current = null;
			}
		},
		onSuccess: (data) => {
			switch (data.type) {
				case "myTeamInvitationAccepted":
					toast.success(
						m.dashboard_pending_toast_joined({ teamName: data.teamName }),
					);
					break;
				case "myTeamInvitationAcceptRefreshRequired":
					toast.warning(
						m.dashboard_pending_toast_accept_refresh_required({
							teamName: data.teamName,
						}),
					);
					break;
				case "myTeamInvitationUncertain":
					toast.warning(m.dashboard_pending_toast_uncertain());
					break;
			}
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
		onSettled: refresh,
	});

	const declineMutation = useMutation({
		mutationFn: async (input: { invitationId: string }) => {
			if (!accountId) throw new Error(m.team_page_error_load_failed());
			const controller = new AbortController();
			activeMutation.current = controller;
			try {
				const result = await runtime.declineMyTeamInvitation(
					{ accountId, invitationId: input.invitationId },
					{ signal: controller.signal },
				);
				return result;
			} finally {
				if (activeMutation.current === controller)
					activeMutation.current = null;
			}
		},
		onSuccess: (data) => {
			if (data.type === "myTeamInvitationDeclined") {
				toast.success(m.dashboard_pending_toast_declined());
			} else {
				toast.warning(m.dashboard_pending_toast_uncertain());
			}
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
		onSettled: refresh,
	});

	if (pendingQuery.isLoading || !pendingQuery.data?.length) {
		return null;
	}
	const pendingCount = pendingQuery.data.length;
	const pendingDescription =
		pendingCount === 1
			? m.dashboard_pending_description_single({ count: pendingCount })
			: m.dashboard_pending_description_plural({ count: pendingCount });

	return (
		<Card className="overflow-hidden py-0">
			<CardHeader className="border-b py-5">
				<CardTitle className="flex items-center gap-2">
					<Mail className="size-4" />
					{m.dashboard_pending_title()}
				</CardTitle>
				<CardDescription>{pendingDescription}</CardDescription>
			</CardHeader>
			<CardContent className="space-y-3 p-4">
				<div className="space-y-3">
					{pendingQuery.data.map((invitation) => (
						<div
							key={invitation.id}
							className="flex flex-col gap-3 rounded-md border bg-foreground/3 p-3 sm:flex-row sm:items-center sm:justify-between"
						>
							<div className="space-y-1">
								<div className="flex flex-wrap items-center gap-2">
									<span className="font-medium">{invitation.teamName}</span>
									<Badge variant="secondary">{invitation.role}</Badge>
								</div>
								<div className="flex flex-wrap items-center gap-3 text-muted-foreground text-sm">
									<span>
										{m.dashboard_pending_invited_by({
											invitedBy: invitation.invitedBy,
										})}
									</span>
									<span className="flex items-center gap-1">
										<Clock className="h-3 w-3" />
										{m.dashboard_pending_expires({
											time: formatDistanceToNow(
												new Date(invitation.expiresAt),
												{
													addSuffix: true,
													locale: locale === "de" ? dateFnsDe : dateFnsEnUS,
												},
											),
										})}
									</span>
								</div>
							</div>
							<div className="flex gap-2">
								<Button
									size="sm"
									variant="outline"
									onClick={() =>
										declineMutation.mutate({ invitationId: invitation.id })
									}
									disabled={
										declineMutation.isPending || acceptMutation.isPending
									}
									data-testid="invitation-decline-button"
								>
									<X className="h-4 w-4" />
								</Button>
								<Button
									size="sm"
									onClick={() =>
										acceptMutation.mutate({ invitationId: invitation.id })
									}
									disabled={
										acceptMutation.isPending || declineMutation.isPending
									}
								>
									<Check className="mr-1 h-4 w-4" />
									{m.dashboard_pending_action_accept()}
								</Button>
							</div>
						</div>
					))}
				</div>
			</CardContent>
		</Card>
	);
}
