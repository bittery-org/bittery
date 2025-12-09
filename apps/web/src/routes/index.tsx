import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTRPC } from "@/utils/trpc";

export const Route = createFileRoute("/")({
	component: HomeComponent,
});

const TITLE_TEXT = `
 ██████╗ ███████╗████████╗████████╗███████╗██████╗
 ██╔══██╗██╔════╝╚══██╔══╝╚══██╔══╝██╔════╝██╔══██╗
 ██████╔╝█████╗     ██║      ██║   █████╗  ██████╔╝
 ██╔══██╗██╔══╝     ██║      ██║   ██╔══╝  ██╔══██╗
 ██████╔╝███████╗   ██║      ██║   ███████╗██║  ██║
 ╚═════╝ ╚══════╝   ╚═╝      ╚═╝   ╚══════╝╚═╝  ╚═╝

 ████████╗    ███████╗████████╗ █████╗  ██████╗██╗  ██╗
 ╚══██╔══╝    ██╔════╝╚══██╔══╝██╔══██╗██╔════╝██║ ██╔╝
    ██║       ███████╗   ██║   ███████║██║     █████╔╝
    ██║       ╚════██║   ██║   ██╔══██║██║     ██╔═██╗
    ██║       ███████║   ██║   ██║  ██║╚██████╗██║  ██╗
    ╚═╝       ╚══════╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝
 `;

function HomeComponent() {
	const trpc = useTRPC();
	const healthCheck = useQuery(trpc.healthCheck.queryOptions());

	return (
		<div className="container mx-auto max-w-4xl space-y-8 px-6 py-12">
			<pre className="overflow-x-auto rounded-lg bg-muted/50 p-6 font-mono text-sm">{TITLE_TEXT}</pre>
			<div className="grid gap-6">
				<div className="rounded-xl border bg-card p-6 text-card-foreground shadow-sm">
					<h2 className="mb-4 font-semibold text-lg">API Status</h2>
					<div className="flex items-center gap-3">
						<div
							className={`h-3 w-3 rounded-full ${healthCheck.data ? "bg-green-500 animate-pulse" : "bg-red-500"}`}
						/>
						<span className="text-sm">
							{healthCheck.isLoading
								? "Checking..."
								: healthCheck.data
									? "Connected to server"
									: "Disconnected"}
						</span>
					</div>
				</div>
			</div>
		</div>
	);
}
