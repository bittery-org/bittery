import { createFileRoute } from "@tanstack/react-router";
import { createRouteGuard } from "@/lib/route-guards";

export const Route = createFileRoute("/_app/security")({
	beforeLoad: createRouteGuard({
		requiresMode: "cloud",
		requiresEntitlements: ["sentinel"],
	}),
	head: () => ({
		meta: [{ title: "Sentinel - Bittery" }],
	}),
});
