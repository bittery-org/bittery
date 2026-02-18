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

	return showSignIn ? (
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
	);
}
