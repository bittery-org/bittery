import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import SignUpForm from "@/components/sign-up-form";

const searchSchema = z.object({
	redirect: z.string().optional(),
	plan: z.string().optional(),
});

export const Route = createFileRoute("/_auth/signup")({
	component: RouteComponent,
	validateSearch: searchSchema,
	head: () => ({
		meta: [{ title: "Sign Up - Bittery" }],
	}),
});

function RouteComponent() {
	const navigate = useNavigate();
	const { redirect } = Route.useSearch();

	const invitationToken = redirect?.match(/^\/invite\/(.+)$/)?.[1] || undefined;

	return (
		<SignUpForm
			onSwitchToSignIn={() => {
				if (redirect) {
					navigate({ to: "/login", search: { redirect }, resetScroll: true });
					return;
				}

				navigate({ to: "/login", resetScroll: true });
			}}
			invitationToken={invitationToken}
			redirectTo={redirect}
		/>
	);
}
