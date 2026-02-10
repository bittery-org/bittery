import { createFileRoute } from "@tanstack/react-router";
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
		<div className="flex min-h-screen w-full items-center justify-center bg-muted/30 p-4 lg:p-8">
			<div className="grid w-full max-w-6xl items-start gap-12 lg:grid-cols-2 lg:items-center">
				<div className="order-2 mx-auto w-full max-w-md lg:order-1 lg:mr-0 lg:ml-auto">
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

				<div className="order-1 mx-auto flex max-w-lg flex-col justify-start space-y-6 p-4 lg:order-2 lg:mx-0 lg:p-12">
					<div className="mb-4 flex items-center gap-3 text-primary">
						<img src="/logo.png" alt="Bittery Logo" className="h-16 w-auto" />
					</div>
					<div className="space-y-4">
						<h1 className="font-bold text-4xl tracking-tighter md:text-5xl">
							Secure by design. <br />
							<span className="text-primary">Private by default.</span>
						</h1>
						<p className="text-lg text-muted-foreground">
							Experience the next generation of password management. End-to-end
							encryption that ensures only you hold the keys to your digital
							vault.
						</p>
					</div>
					<div className="grid gap-3 pt-2">
						{[
							"Zero-knowledge architecture",
							"Secure Remote Password (SRP) protocol",
							"Client-side AES-256 encryption",
							"Emergency access kit",
						].map((item) => (
							<div
								key={item}
								className="flex items-center gap-3 font-medium text-sm"
							>
								<div className="h-1.5 w-1.5 rounded-full bg-primary" />
								{item}
							</div>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}
