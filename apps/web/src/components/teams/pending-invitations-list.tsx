import { useRuntimeClient } from "@bittery/client-runtime/react";
import { formatDate } from "@bittery/i18n/format/browser";
import { Badge, Button, cn, copyWithToast, toast } from "@bittery/ui";
import {
	IconClock as Clock,
	IconCopy as Copy,
	IconArrowLeftRight as RefreshCw,
	IconX as X,
} from "@bittery/ui/icons";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/providers/i18n-provider";
import { useQueryInvalidator } from "../../providers/transitional-sync-provider";

interface Invitation {
	id: string;
	email: string;
	role: string;
	status: string;
	invitedBy: string;
	createdAt: string;
	expiresAt: string;
}

interface PendingInvitationsListProps {
	invitations: Invitation[];
	canManage: boolean;
	accountId: string;
	teamId: string;
}

export function PendingInvitationsList({
	invitations,
	canManage,
	accountId,
	teamId,
}: PendingInvitationsListProps) {
	const runtime = useRuntimeClient();
	const invalidator = useQueryInvalidator();
	const { m } = useI18n();
	const inFlight = useRef(new Map<string, Set<AbortController>>());
	useEffect(
		() => () => {
			for (const controller of inFlight.current.get(accountId) ?? [])
				controller.abort();
		},
		[accountId],
	);
	const withCurrentCaller = async <T,>(
		call: (signal: AbortSignal) => Promise<T>,
	): Promise<T> => {
		const controller = new AbortController();
		let accountFlights = inFlight.current.get(accountId);
		if (!accountFlights) {
			accountFlights = new Set();
			inFlight.current.set(accountId, accountFlights);
		}
		accountFlights.add(controller);
		try {
			return await call(controller.signal);
		} finally {
			accountFlights.delete(controller);
			if (accountFlights.size === 0) inFlight.current.delete(accountId);
		}
	};
	// Resending rotates the token, so the server hands back a brand new link that
	// exists nowhere else. Keep it visible until the admin has copied it.
	const [resentLink, setResentLink] = useState<{
		invitationId: string;
		url: string;
	} | null>(null);

	const getRoleLabel = (role: string) => {
		switch (role) {
			case "owner":
				return m.team_role_owner();
			case "admin":
				return m.team_role_admin();
			case "member":
				return m.team_role_member();
			default:
				return role;
		}
	};

	const cancelMutation = useMutation({
		mutationFn: (input: { invitationId: string }) =>
			withCurrentCaller(async (signal) => {
				const result = await runtime.cancelTeamInvitation(
					{ accountId, teamId, invitationId: input.invitationId },
					{ signal },
				);
				if (result.type === "teamInvitationAdminUncertain")
					throw new Error(m.team_invitations_action_incomplete());
				return result;
			}),
		onSuccess: async () => {
			setResentLink(null);
			toast.success(m.team_invitations_toast_cancelled());
			await invalidator.invalidateTeamInvitations();
		},
		onError: (error: Error) => {
			toast.error(error.message);
			void invalidator.invalidateTeamInvitations();
		},
	});

	const resendMutation = useMutation({
		mutationFn: (input: { invitationId: string }) =>
			withCurrentCaller(async (signal) => {
				const result = await runtime.resendTeamInvitation(
					{ accountId, teamId, invitationId: input.invitationId },
					{ signal },
				);
				if (result.type === "teamInvitationAdminUncertain")
					throw new Error(m.team_invitations_action_incomplete());
				return result;
			}),
		onSuccess: async (data) => {
			setResentLink({
				invitationId: data.invitationId,
				url: `${window.location.origin}/invite/${data.token}`,
			});
			toast.success(m.team_invitations_toast_resent());
			await invalidator.invalidateTeamInvitations();
		},
		onError: (error: Error) => {
			setResentLink(null);
			toast.error(error.message);
			void invalidator.invalidateTeamInvitations();
		},
	});

	if (invitations.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center rounded-xl border border-border/70 border-dashed py-12 text-center">
				<div className="inline-flex size-10 items-center justify-center rounded-lg border bg-muted/50 text-muted-foreground">
					<Clock className="h-5 w-5" />
				</div>
				<p className="mt-3 font-medium text-sm">
					{m.team_invitations_empty_title()}
				</p>
				<p className="mt-1 text-muted-foreground text-xs">
					{m.team_invitations_empty_description()}
				</p>
			</div>
		);
	}

	const isExpired = (expiresAt: Date) => new Date(expiresAt) < new Date();

	return (
		<div className="grid gap-3 sm:grid-cols-2">
			{invitations.map((invitation) => {
				const expired = isExpired(new Date(invitation.expiresAt));

				return (
					<div
						key={invitation.id}
						className="group relative overflow-hidden rounded-xl border border-border/70 bg-card/90 p-4 transition-all hover:-translate-y-0.5 hover:shadow-md"
					>
						{/* Top accent bar */}
						<div
							className={cn(
								"pointer-events-none",
								"absolute",
								"inset-x-0",
								"top-0",
								"h-1",
								"bg-linear-to-r",
								expired
									? "from-destructive/70 via-destructive/30 to-transparent"
									: "from-amber-500/70 via-amber-500/30 to-transparent",
							)}
						/>

						<div className="flex items-start justify-between gap-3">
							<div className="min-w-0 flex-1 space-y-1">
								<div className="flex items-center gap-2">
									<span className="truncate font-medium text-sm">
										{invitation.email}
									</span>
								</div>
								<p className="text-muted-foreground text-xs">
									{m.team_invitations_invited_by({
										name: invitation.invitedBy,
									})}
								</p>
							</div>
							<div className="flex shrink-0 items-center gap-1.5">
								<Badge variant="secondary" className="capitalize">
									{getRoleLabel(invitation.role)}
								</Badge>
								{expired ? (
									<Badge variant="destructive">
										{m.team_invitations_status_expired()}
									</Badge>
								) : (
									<Badge variant="outline">
										{m.team_invitations_status_pending()}
									</Badge>
								)}
							</div>
						</div>

						<div className="mt-3 flex items-center justify-between border-t pt-3">
							<span className="text-muted-foreground text-xs">
								{expired
									? m.team_invitations_expires_expired({
											date: formatDate(invitation.expiresAt, {
												month: "short",
												day: "numeric",
											}),
										})
									: m.team_invitations_expires_active({
											date: formatDate(invitation.expiresAt, {
												month: "short",
												day: "numeric",
											}),
										})}
							</span>

							{canManage && (
								<div className="flex items-center gap-1">
									<Button
										variant="ghost"
										size="sm"
										className="h-7 gap-1.5 px-2 text-muted-foreground text-xs hover:text-foreground"
										onClick={() =>
											resendMutation.mutate({ invitationId: invitation.id })
										}
										disabled={
											resendMutation.isPending || cancelMutation.isPending
										}
										title={m.team_invitations_action_resend_title()}
									>
										<RefreshCw className="h-3.5 w-3.5" />
										{m.team_invitations_action_resend()}
									</Button>
									<Button
										variant="ghost"
										size="sm"
										className="h-7 gap-1.5 px-2 text-destructive text-xs hover:bg-destructive/10 hover:text-destructive"
										onClick={() =>
											cancelMutation.mutate({ invitationId: invitation.id })
										}
										disabled={
											cancelMutation.isPending || resendMutation.isPending
										}
										title={m.team_invitations_action_cancel_title()}
									>
										<X className="h-3.5 w-3.5" />
										{m.team_invitations_action_cancel()}
									</Button>
								</div>
							)}
						</div>

						{resentLink?.invitationId === invitation.id && (
							<div className="mt-3 rounded-md border bg-muted/40 p-3">
								<p className="font-medium text-sm">
									{m.team_invitations_resend_link_title()}
								</p>
								<p className="mt-1 text-muted-foreground text-xs">
									{m.team_invitations_resend_link_hint()}
								</p>
								<p className="mt-2 break-all text-muted-foreground text-xs">
									{resentLink.url}
								</p>
								<Button
									type="button"
									variant="outline"
									size="sm"
									className="mt-3"
									onClick={() =>
										copyWithToast(
											resentLink.url,
											m.team_invitations_copy_label(),
											{
												showAutoClearMessage: false,
											},
										)
									}
								>
									<Copy className="mr-2 h-4 w-4" />
									{m.team_invitations_action_copy()}
								</Button>
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}
