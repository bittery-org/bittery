import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import SignInForm from "@/components/sign-in-form";

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
	const navigate = useNavigate();
	const { redirect } = Route.useSearch();

	return (
		<SignInForm
			onSwitchToSignUp={() => {
				if (redirect) {
					navigate({ to: "/signup", search: { redirect } });
					return;
				}

				navigate({ to: "/signup" });
			}}
			redirectTo={redirect}
		/>
	);
}
