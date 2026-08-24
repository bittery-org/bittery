import { useApiClient } from "@bittery/shared/api";
import { apiQueries } from "@bittery/shared/api-query";
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
import { useMutation, useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { de as dateFnsDe, enUS as dateFnsEnUS } from "date-fns/locale";
import { useI18n } from "@/providers/i18n-provider";
import { useQueryInvalidator } from "../../providers/transitional-sync-provider";

export function PendingInvitations() {
	const api = useApiClient();
	const invalidator = useQueryInvalidator();
	const pendingQuery = useQuery(apiQueries.teams.pendingInvitations(api));
	const { locale, m } = useI18n();

	// Invitations are addressed by id here: only the SHA-256 digest of the token
	// is stored server-side, so the pending list cannot hand back the raw token.
	const acceptMutation = useMutation({
		mutationFn: (input: { invitationId: string }) =>
			api.teams.invitations.acceptMine(input.invitationId).then((r) => r.data),
		onSuccess: async (data) => {
			toast.success(
				m.dashboard_pending_toast_joined({ teamName: data.teamName }),
			);
			await invalidator.invalidateTeamInvitations();
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

	const declineMutation = useMutation({
		mutationFn: (input: { invitationId: string }) =>
			api.teams.invitations.declineMine(input.invitationId),
		onSuccess: async () => {
			toast.success(m.dashboard_pending_toast_declined());
			await invalidator.invalidateTeamInvitations();
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
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
									disabled={declineMutation.isPending}
									data-testid="invitation-decline-button"
								>
									<X className="h-4 w-4" />
								</Button>
								<Button
									size="sm"
									onClick={() =>
										acceptMutation.mutate({ invitationId: invitation.id })
									}
									disabled={acceptMutation.isPending}
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
