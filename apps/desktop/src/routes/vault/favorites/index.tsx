import { IconStarOutlineDuo18 } from "@bittery/ui/icons";
import { createFileRoute } from "@tanstack/react-router";
import { useI18n } from "@/providers/i18n-provider";

export const Route = createFileRoute("/vault/favorites/")({
	component: FavoritesIndexComponent,
});

function FavoritesIndexComponent() {
	const { m } = useI18n();

	return (
		<div className="flex flex-1 items-center justify-center p-8 text-center">
			<div>
				<div className="mb-4 inline-flex rounded-full bg-muted p-6">
					<IconStarOutlineDuo18
						className="size-12 text-yellow-500"
						fill="currentColor"
					/>
				</div>
				<h3 className="mb-2 font-semibold text-lg">
					{m.vaults_favorites_title()}
				</h3>
				<p className="text-muted-foreground text-sm">
					{m.vaults_shared_empty_no_item_selected()}
				</p>
				<p className="text-muted-foreground text-sm">
					{m.vaults_shared_empty_select_item_to_view_details()}
				</p>
			</div>
		</div>
	);
}
