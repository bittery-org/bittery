import { useTRPC, useTRPCClient } from "@bittery/shared/trpc";
import {
	Button,
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
	toast,
} from "@bittery/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
	AlertCircle,
	Check,
	Clock,
	Loader2,
	ShieldCheck,
	Users,
	X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { storage } from "@/lib/storage";

export const Route = createFileRoute("/invite/$token")({
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
	const [authenticated, setAuthenticated] = useState(false);

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

	// Loading state
	if (invitationQuery.isLoading) {
		return (
			<div className="flex min-h-screen w-full items-center justify-center bg-muted/30 p-4">
				<Card className="w-full max-w-md">
					<CardContent className="flex flex-col items-center justify-center py-12">
						<Loader2 className="h-8 w-8 animate-spin text-primary" />
						<p className="mt-4 text-muted-foreground">Loading invitation...</p>
					</CardContent>
				</Card>
			</div>
		);
	}

	// Error state
	if (invitationQuery.error) {
		return (
			<div className="flex min-h-screen w-full items-center justify-center bg-muted/30 p-4">
				<Card className="w-full max-w-md">
					<CardHeader className="text-center">
						<div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
							<AlertCircle className="h-6 w-6 text-destructive" />
						</div>
						<CardTitle>Invitation Not Found</CardTitle>
						<CardDescription>
							This invitation link is invalid or has already been used.
						</CardDescription>
					</CardHeader>
					<CardFooter className="justify-center">
						<Link to="/login">
							<Button variant="outline">Go to Login</Button>
						</Link>
					</CardFooter>
				</Card>
			</div>
		);
	}

	const invitation = invitationQuery.data;

	// Expired state
	if (invitation?.status === "expired") {
		return (
			<div className="flex min-h-screen w-full items-center justify-center bg-muted/30 p-4">
				<Card className="w-full max-w-md">
					<CardHeader className="text-center">
						<div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
							<Clock className="h-6 w-6 text-muted-foreground" />
						</div>
						<CardTitle>Invitation Expired</CardTitle>
						<CardDescription>
							This invitation has expired. Please ask {invitation.invitedByName}{" "}
							to send a new invitation.
						</CardDescription>
					</CardHeader>
					<CardFooter className="justify-center">
						<Link to="/login">
							<Button variant="outline">Go to Login</Button>
						</Link>
					</CardFooter>
				</Card>
			</div>
		);
	}

	// Already accepted/declined
	if (invitation?.status !== "pending") {
		return (
			<div className="flex min-h-screen w-full items-center justify-center bg-muted/30 p-4">
				<Card className="w-full max-w-md">
					<CardHeader className="text-center">
						<div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
							<Check className="h-6 w-6 text-muted-foreground" />
						</div>
						<CardTitle>Invitation Already Used</CardTitle>
						<CardDescription>
							This invitation has already been {invitation?.status}.
						</CardDescription>
					</CardHeader>
					<CardFooter className="justify-center">
						<Link to={authenticated ? "/team" : "/login"}>
							<Button variant="outline">
								{authenticated ? "Go to Teams" : "Go to Login"}
							</Button>
						</Link>
					</CardFooter>
				</Card>
			</div>
		);
	}

	// Not authenticated - prompt to sign in
	if (!authenticated) {
		return (
			<div className="flex min-h-screen w-full items-center justify-center bg-muted/30 p-4">
				<Card className="w-full max-w-md">
					<CardHeader className="text-center">
						<div className="mx-auto mb-4 flex items-center gap-2">
							<div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
								<ShieldCheck className="h-6 w-6" />
							</div>
							<span className="font-bold text-xl">Bittery</span>
						</div>
						<div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
							<Users className="h-8 w-8 text-primary" />
						</div>
						<CardTitle>You're Invited!</CardTitle>
						<CardDescription className="space-y-2">
							<span className="font-medium text-foreground">
								{invitation.invitedByName}
							</span>{" "}
							has invited you to join{" "}
							<span className="font-medium text-foreground">
								{invitation.teamName}
							</span>{" "}
							as a{" "}
							<span className="font-medium text-foreground">
								{invitation.role}
							</span>
							.
						</CardDescription>
					</CardHeader>
					<CardContent className="text-center">
						<p className="text-muted-foreground text-sm">
							Sign in or create an account with{" "}
							<span className="font-medium text-foreground">
								{invitation.email}
							</span>{" "}
							to accept this invitation.
						</p>
					</CardContent>
					<CardFooter className="justify-center gap-2">
						<Link to="/login" search={{ redirect: `/invite/${token}` }}>
							<Button>Sign In to Accept</Button>
						</Link>
					</CardFooter>
				</Card>
			</div>
		);
	}

	// Authenticated - show accept/decline options
	return (
		<div className="flex min-h-screen w-full items-center justify-center bg-muted/30 p-4">
			<Card className="w-full max-w-md">
				<CardHeader className="text-center">
					<div className="mx-auto mb-4 flex items-center gap-2">
						<div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
							<ShieldCheck className="h-6 w-6" />
						</div>
						<span className="font-bold text-xl">Bittery</span>
					</div>
					<div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
						<Users className="h-8 w-8 text-primary" />
					</div>
					<CardTitle>Team Invitation</CardTitle>
					<CardDescription className="space-y-2">
						<span className="font-medium text-foreground">
							{invitation.invitedByName}
						</span>{" "}
						has invited you to join{" "}
						<span className="font-medium text-foreground">
							{invitation.teamName}
						</span>{" "}
						as a{" "}
						<span className="font-medium text-foreground">
							{invitation.role}
						</span>
						.
					</CardDescription>
				</CardHeader>
				<CardContent className="text-center">
					<p className="text-muted-foreground text-sm">
						Would you like to accept this invitation?
					</p>
				</CardContent>
				<CardFooter className="justify-center gap-2">
					<Button
						variant="outline"
						onClick={() => declineMutation.mutate()}
						disabled={declineMutation.isPending || acceptMutation.isPending}
					>
						{declineMutation.isPending ? (
							<Loader2 className="mr-2 h-4 w-4 animate-spin" />
						) : (
							<X className="mr-2 h-4 w-4" />
						)}
						Decline
					</Button>
					<Button
						onClick={() => acceptMutation.mutate()}
						disabled={acceptMutation.isPending || declineMutation.isPending}
					>
						{acceptMutation.isPending ? (
							<Loader2 className="mr-2 h-4 w-4 animate-spin" />
						) : (
							<Check className="mr-2 h-4 w-4" />
						)}
						Accept Invitation
					</Button>
				</CardFooter>
			</Card>
		</div>
	);
}
