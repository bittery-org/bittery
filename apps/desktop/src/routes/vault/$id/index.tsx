import { createFileRoute } from "@tanstack/react-router";
import { Lock } from "lucide-react";

export const Route = createFileRoute("/vault/$id/")({
	component: VaultComponent,
});

function VaultComponent() {
	return (
		<div className="flex flex-1 items-center justify-center p-8 text-center">
			<div>
				<div className="mb-4 inline-flex rounded-full bg-muted p-6">
					<Lock size={48} className="text-muted-foreground" />
				</div>
				<h3 className="mb-2 font-semibold text-lg">No Item Selected</h3>
				<p className="text-muted-foreground text-sm">
					Please select an item from the list to view its details.
				</p>
			</div>
		</div>
	);
}
