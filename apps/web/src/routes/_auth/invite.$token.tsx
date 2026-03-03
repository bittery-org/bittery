import { useTRPC, useTRPCClient } from "@bittery/shared/trpc";
import { Button, toast } from "@bittery/ui";
import {
	IconCircleWarningOutlineDuo18 as AlertCircle,
	IconCheckOutlineDuo18 as Check,
	IconClockTimeOutlineDuo18 as Clock,
	IconLoader2OutlineDuo18 as Loader2,
	IconUsers6OutlineDuo18 as Users,
	IconXmarkOutlineDuo18 as X,
} from "@bittery/ui/icons";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import SignInForm from "@/components/sign-in-form";
import SignUpForm from "@/components/sign-up-form";
import { storage } from "@/lib/storage";

export const Route = createFileRoute("/_auth/invite/$token")({
	component: InvitationPage,
	head: () => ({
		meta: [{ title: "Team Invitation - Bittery" }],
	}),
});

function InvitationPage() {
	const { token } = Route.useParams();
	const navigate = useNavigate();
	const trpc = useTRPC();
	const trpcClient = useTRPCClient();
	const [authenticated, setAuthenticated] = useState<boolean | null>(null);
	const [view, setView] = useState<"signup" | "signin">("signup");

	useEffect(() => {
		storage.isAuthenticated().then(setAuthenticated);
	}, []);

	// Get invitation details
	const invitationQuery = useQuery(
		trpc.team.invitations.getByToken.queryOptions({ token }),
	);

	// Accept mutation
	const acceptMutation = useMutation({
		mutationFn: () => trpcClient.team.invitations.accept.mutate({ token }),
		onSuccess: (data) => {
			toast.success(`Successfully joined ${data.teamName}!`);
			navigate({ to: "/team" });
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

	// Decline mutation
	const declineMutation = useMutation({
		mutationFn: () => trpcClient.team.invitations.decline.mutate({ token }),
		onSuccess: () => {
			toast.success("Invitation declined");
			navigate({ to: "/team" });
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

	// Loading auth state
	if (authenticated === null) {
		return (
			<div className="flex w-full flex-col items-center justify-center py-12">
				<Loader2 className="h-8 w-8 animate-spin text-primary" />
				<p className="mt-4 text-muted-foreground text-sm">Loading...</p>
			</div>
		);
	}

	// Loading invitation
	if (invitationQuery.isLoading) {
		return (
			<div className="flex w-full flex-col items-center justify-center py-12">
				<Loader2 className="h-8 w-8 animate-spin text-primary" />
				<p className="mt-4 text-muted-foreground text-sm">
					Loading invitation...
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
						Invitation Not Found
					</h1>
					<p className="mx-auto mt-2 max-w-80 text-muted-foreground text-sm">
						This invitation link is invalid or has already been used.
					</p>
				</div>
				<div className="mt-6 flex justify-center">
					<Link to="/login">
						<Button variant="outline">Go to Sign In</Button>
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
						Invitation Expired
					</h1>
					<p className="mx-auto mt-2 max-w-80 text-muted-foreground text-sm">
						This invitation has expired. Please ask {invitation.invitedByName}{" "}
						to send a new invitation.
					</p>
				</div>
				<div className="mt-6 flex justify-center">
					<Link to="/login">
						<Button variant="outline">Go to Sign In</Button>
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
						Invitation Already Used
					</h1>
					<p className="mx-auto mt-2 max-w-80 text-muted-foreground text-sm">
						This invitation has already been {invitation?.status}.
					</p>
				</div>
				<div className="mt-6 flex justify-center">
					<Link to={authenticated ? "/team" : "/login"}>
						<Button variant="outline">
							{authenticated ? "Go to Teams" : "Go to Sign In"}
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
					Team Invitation
				</h1>
				<p className="mx-auto mt-2 max-w-80 text-muted-foreground text-sm">
					<span className="font-medium text-foreground">
						{invitation.invitedByName}
					</span>{" "}
					has invited you to join{" "}
					<span className="font-medium text-foreground">
						{invitation.teamName}
					</span>{" "}
					as a{" "}
					<span className="font-medium text-foreground">{invitation.role}</span>
					.
				</p>
			</div>

			<div className="mt-6 space-y-4">
				<p className="text-center text-muted-foreground text-sm">
					Would you like to accept this invitation?
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
						Decline
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
						Accept Invitation
					</Button>
				</div>
			</div>
		</div>
	);
}
