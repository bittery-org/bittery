import { m as messages } from "@bittery/i18n/paraglide/messages";
import { useApiClient } from "@bittery/shared/api";
import { Button, toast } from "@bittery/ui";
import {
	IconCircleAlert as AlertCircle,
	IconCheck as Check,
	IconClock as Clock,
	IconLoaderCircle as Loader2,
	IconUsers as Users,
	IconX as X,
} from "@bittery/ui/icons";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import SignInForm from "@/components/sign-in-form";
import SignUpForm from "@/components/sign-up-form";
import { storage } from "@/lib/storage";
import { useI18n } from "@/providers/i18n-provider";

export const Route = createFileRoute("/_auth/invite/$token")({
	component: InvitationPage,
	head: () => ({
		meta: [{ title: messages.auth_invite_meta_title() }],
	}),
});

type InviteMessageCatalog = ReturnType<typeof useI18n>["m"];

function getInvitationRoleLabel(role: string, m: InviteMessageCatalog): string {
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
}

function getInvitationStatusLabel(
	status: string,
	m: InviteMessageCatalog,
): string {
	switch (status) {
		case "accepted":
			return m.auth_invite_status_accepted();
		case "declined":
			return m.auth_invite_status_declined();
		case "expired":
			return m.auth_invite_status_expired();
		case "canceled":
			return m.auth_invite_status_canceled();
		case "pending":
			return m.auth_invite_status_pending();
		default:
			return status;
	}
}

function InvitationPage() {
	const { token } = Route.useParams();
	const navigate = useNavigate();
	const api = useApiClient();
	const { m } = useI18n();
	const [view, setView] = useState<"signup" | "signin">("signup");
	const authenticatedQuery = useQuery({
		queryKey: ["auth", "isAuthenticated"],
		queryFn: () => storage.isAuthenticated(),
	});
	const authenticated = authenticatedQuery.data ?? null;

	// Get invitation details
	const invitationQuery = useQuery({
		queryKey: ["api", "v1", "public", "invitations", token],
		queryFn: async () => (await api.teams.invitations.public(token)).data,
	});

	// Accept mutation
	const acceptMutation = useMutation({
		mutationFn: () =>
			api.teams.invitations.acceptPublic(token).then((r) => r.data),
		onSuccess: (data) => {
			toast.success(m.auth_invite_toast_joined({ teamName: data.teamName }));
			navigate({ to: "/team" });
		},
		onError: () => {
			toast.error(m.auth_invite_toast_accept_failed());
		},
	});

	// Decline mutation
	const declineMutation = useMutation({
		mutationFn: () => api.teams.invitations.declinePublic(token),
		onSuccess: () => {
			toast.success(m.auth_invite_toast_declined());
			navigate({ to: "/team" });
		},
		onError: () => {
			toast.error(m.auth_invite_toast_decline_failed());
		},
	});

	// Loading auth state
	if (authenticatedQuery.isLoading) {
		return (
			<div className="flex w-full flex-col items-center justify-center py-12">
				<Loader2 className="h-8 w-8 animate-spin text-primary" />
				<p className="mt-4 text-muted-foreground text-sm">
					{m.auth_invite_loading_auth()}
				</p>
			</div>
		);
	}

	// Loading invitation
	if (invitationQuery.isLoading) {
		return (
			<div className="flex w-full flex-col items-center justify-center py-12">
				<Loader2 className="h-8 w-8 animate-spin text-primary" />
				<p className="mt-4 text-muted-foreground text-sm">
					{m.auth_invite_loading_invitation()}
				</p>
			</div>
		);
	}

	// Error state
	if (invitationQuery.error) {
		return (
			<div className="w-full">
				<div className="text-center">
					<div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
						<AlertCircle className="h-6 w-6 text-destructive" />
					</div>
					<h1 className="font-semibold text-2xl tracking-tight">
						{m.auth_invite_not_found_title()}
					</h1>
					<p className="mx-auto mt-2 max-w-80 text-muted-foreground text-sm">
						{m.auth_invite_not_found_description()}
					</p>
				</div>
				<div className="mt-6 flex justify-center">
					<Link to="/login">
						<Button variant="outline">
							{m.auth_invite_action_go_to_sign_in()}
						</Button>
					</Link>
				</div>
			</div>
		);
	}

	const invitation = invitationQuery.data;

	// Expired state
	if (invitation?.status === "expired") {
		return (
			<div className="w-full">
				<div className="text-center">
					<div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
						<Clock className="h-6 w-6 text-muted-foreground" />
					</div>
					<h1 className="font-semibold text-2xl tracking-tight">
						{m.auth_invite_expired_title()}
					</h1>
					<p className="mx-auto mt-2 max-w-80 text-muted-foreground text-sm">
						{m.auth_invite_expired_description({
							invitedByName: invitation.invitedByName,
						})}
					</p>
				</div>
				<div className="mt-6 flex justify-center">
					<Link to="/login">
						<Button variant="outline">
							{m.auth_invite_action_go_to_sign_in()}
						</Button>
					</Link>
				</div>
			</div>
		);
	}

	// Already accepted/declined
	if (invitation?.status !== "pending") {
		return (
			<div className="w-full">
				<div className="text-center">
					<div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
						<Check className="h-6 w-6 text-muted-foreground" />
					</div>
					<h1 className="font-semibold text-2xl tracking-tight">
						{m.auth_invite_used_title()}
					</h1>
					<p className="mx-auto mt-2 max-w-80 text-muted-foreground text-sm">
						{m.auth_invite_used_description({
							status: getInvitationStatusLabel(invitation?.status ?? "", m),
						})}
					</p>
				</div>
				<div className="mt-6 flex justify-center">
					<Link to={authenticated ? "/team" : "/login"}>
						<Button variant="outline">
							{authenticated
								? m.auth_invite_action_go_to_teams()
								: m.auth_invite_action_go_to_sign_in()}
						</Button>
					</Link>
				</div>
			</div>
		);
	}

	// Not authenticated - show signup/signin forms
	if (!authenticated) {
		return (
			<div className="w-full">
				{view === "signup" ? (
					<SignUpForm
						onSwitchToSignIn={() => setView("signin")}
						invitationToken={token}
						redirectTo={`/invite/${token}`}
					/>
				) : (
					<SignInForm
						onSwitchToSignUp={() => setView("signup")}
						redirectTo={`/invite/${token}`}
					/>
				)}
			</div>
		);
	}

	// Authenticated - show accept/decline options
	return (
		<div className="w-full">
			<div className="text-center">
				<div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
					<Users className="h-7 w-7 text-primary" />
				</div>
				<h1 className="font-semibold text-2xl tracking-tight">
					{m.auth_invite_header_title()}
				</h1>
				<p className="mx-auto mt-2 max-w-80 text-muted-foreground text-sm">
					<span className="font-medium text-foreground">
						{invitation.invitedByName}
					</span>{" "}
					{m.auth_invite_header_description_join()}{" "}
					<span className="font-medium text-foreground">
						{invitation.teamName}
					</span>{" "}
					{m.auth_invite_header_description_role_prefix()}{" "}
					<span className="font-medium text-foreground">
						{getInvitationRoleLabel(invitation.role, m)}
					</span>
					{m.auth_invite_header_description_role_suffix()}
				</p>
			</div>

			<div className="mt-6 space-y-4">
				<p className="text-center text-muted-foreground text-sm">
					{m.auth_invite_prompt()}
				</p>

				<div className="flex gap-3">
					<Button
						variant="outline"
						className="h-10 flex-1"
						onClick={() => declineMutation.mutate()}
						disabled={declineMutation.isPending || acceptMutation.isPending}
					>
						{declineMutation.isPending ? (
							<Loader2 size={16} className="mr-2 animate-spin" />
						) : (
							<X size={16} className="mr-2" />
						)}
						{m.auth_invite_action_decline()}
					</Button>
					<Button
						className="h-10 flex-1"
						onClick={() => acceptMutation.mutate()}
						disabled={acceptMutation.isPending || declineMutation.isPending}
					>
						{acceptMutation.isPending ? (
							<Loader2 size={16} className="mr-2 animate-spin" />
						) : (
							<Check size={16} className="mr-2" />
						)}
						{m.auth_invite_action_accept()}
					</Button>
				</div>
			</div>
		</div>
	);
}
