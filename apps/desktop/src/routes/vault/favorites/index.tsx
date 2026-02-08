import { IconStarOutlineDuo18 } from "@bittery/ui/icons";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/vault/favorites/")({
	component: FavoritesIndexComponent,
});

function FavoritesIndexComponent() {
	return (
		<div className="flex flex-1 items-center justify-center p-8 text-center">
			<div>
				<div className="mb-4 inline-flex rounded-full bg-muted p-6">
					<IconStarOutlineDuo18
						className="size-12 text-yellow-500"
						fill="currentColor"
					/>
				</div>
				<h3 className="mb-2 font-semibold text-lg">Favorites</h3>
				<p className="text-muted-foreground text-sm">No item selected</p>
				<p className="text-muted-foreground text-sm">
					Select an item from the list to view its details.
				</p>
			</div>
		</div>
	);
}
