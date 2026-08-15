import { Button } from "@bittery/ui";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
	// MIGRATION SCAFFOLD — M1-C4a: land straight on the storage self-test so it is reachable
	// without a deep link. Remove this redirect together with `routes/debug.tsx` before release.
	beforeLoad: () => {
		throw redirect({ to: "/debug" });
	},
	component: IndexComponent,
});

function IndexComponent() {
	return (
		<div className="flex min-h-dvh flex-col items-center justify-center gap-4">
			<h1 className="font-semibold text-2xl">Bittery</h1>
			<p className="text-muted-foreground">mobile shell — M1-C1</p>
			<Button>Continue</Button>
			<Link to="/debug" className="text-primary text-sm underline">
				Storage self-test (M1-C4a scaffold)
			</Link>
		</div>
	);
}
