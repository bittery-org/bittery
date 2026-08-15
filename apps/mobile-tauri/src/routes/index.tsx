import { Button } from "@bittery/ui";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
	component: IndexComponent,
});

function IndexComponent() {
	return (
		<div className="flex min-h-dvh flex-col items-center justify-center gap-4">
			<h1 className="font-semibold text-2xl">Bittery</h1>
			<p className="text-muted-foreground">mobile shell — M1-C1</p>
			<Button>Continue</Button>
		</div>
	);
}
