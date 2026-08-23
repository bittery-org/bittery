import { createFileRoute, redirect } from "@tanstack/react-router";
import { runtimeClient } from "@/lib/crypto";
import {
	evaluateRuntimeSessionAccess,
	settledRuntimeSession,
} from "@/lib/runtime-session";

export const Route = createFileRoute("/")({
	component: IndexComponent,
	// The same gate the `_app` layout uses, so the entry URL and every route below it agree
	// on one authority: the session the Runtime publishes.
	beforeLoad: async () => {
		if (typeof window === "undefined") throw redirect({ to: "/login" });
		const to = evaluateRuntimeSessionAccess(
			await settledRuntimeSession(runtimeClient.session()),
		);
		throw redirect({ to: to ?? "/home" });
	},
});

function IndexComponent() {
	return null;
}
