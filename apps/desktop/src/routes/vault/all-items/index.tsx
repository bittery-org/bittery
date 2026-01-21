import { createFileRoute } from "@tanstack/react-router";
import { LayoutGrid } from "lucide-react";

export const Route = createFileRoute("/vault/all-items/")({
	component: AllItemsIndexComponent,
});

function AllItemsIndexComponent() {
	return (
		<div className="flex flex-1 items-center justify-center p-8 text-center">
			<div>
				<div className="mb-4 inline-flex rounded-full bg-muted p-6">
					<LayoutGrid className="size-12 text-muted-foreground" />
				</div>
				<h3 className="mb-2 font-semibold text-lg">All Objects</h3>
				<p className="text-muted-foreground text-sm">No item selected</p>
				<p className="text-muted-foreground text-sm">
					Select an item from the list to view its details.
				</p>
			</div>
		</div>
	);
}
