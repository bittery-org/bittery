import { createFileRoute } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import SignInForm from "@/components/sign-in-form";
import SignUpForm from "@/components/sign-up-form";

const searchSchema = z.object({
	redirect: z.string().optional(),
});

export const Route = createFileRoute("/_auth/login")({
	component: RouteComponent,
	validateSearch: searchSchema,
	head: () => ({
		meta: [{ title: "Sign In - Bittery" }],
	}),
});

function RouteComponent() {
	const { redirect } = Route.useSearch();
	const [showSignIn, setShowSignIn] = useState(true);

	// Extract invitation token from redirect URL if present
	const invitationToken = redirect?.match(/^\/invite\/(.+)$/)?.[1] || undefined;

	return (
		<div className="relative flex min-h-svh flex-col bg-gray-50 dark:bg-gray-950">
			{/* Logo — top left */}
			<div className="relative z-10 px-5 pt-5 sm:px-8 sm:pt-6">
				<img src="/logo.png" alt="Bittery" className="h-10 w-auto" />
			</div>

			{/* Main content */}
			<main className="relative z-10 flex flex-1 flex-col items-center justify-center px-4 py-8 sm:px-6">
				<div className="w-full max-w-[420px]">
					{showSignIn ? (
						<SignInForm
							onSwitchToSignUp={() => setShowSignIn(false)}
							redirectTo={redirect}
						/>
					) : (
						<SignUpForm
							onSwitchToSignIn={() => setShowSignIn(true)}
							invitationToken={invitationToken}
							redirectTo={redirect}
						/>
					)}
				</div>
			</main>

			{/* Footer */}
			<footer className="relative z-10">
				<div className="mx-auto flex max-w-lg flex-col items-center gap-3 px-4 py-4 sm:flex-row sm:justify-between">
					<p className="text-muted-foreground/60 text-xs">Bittery</p>
					<div className="flex items-center gap-4">
						<a
							href="https://github.com/nicepkg/bittery"
							target="_blank"
							rel="noopener noreferrer"
							className="flex items-center gap-1 text-muted-foreground/60 text-xs transition-colors hover:text-muted-foreground"
						>
							GitHub
							<ExternalLink size={10} />
						</a>
						<span className="text-muted-foreground/20">|</span>
						<a
							href="https://github.com/nicepkg/bittery/issues"
							target="_blank"
							rel="noopener noreferrer"
							className="flex items-center gap-1 text-muted-foreground/60 text-xs transition-colors hover:text-muted-foreground"
						>
							Help
							<ExternalLink size={10} />
						</a>
					</div>
				</div>
			</footer>
		</div>
	);
}
