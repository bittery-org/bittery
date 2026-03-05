import { IconGrid2OutlineDuo18 } from "@bittery/ui/icons";
import { createFileRoute } from "@tanstack/react-router";
import { useI18n } from "@/providers/i18n-provider";

export const Route = createFileRoute("/vault/all-items/")({
	component: AllItemsIndexComponent,
});

function AllItemsIndexComponent() {
	const { m } = useI18n();

	return (
		<div className="flex flex-1 items-center justify-center p-8 text-center">
			<div>
				<div className="mb-4 inline-flex rounded-full bg-muted p-6">
					<IconGrid2OutlineDuo18 className="size-12 text-muted-foreground" />
				</div>
				<h3 className="mb-2 font-semibold text-lg">
					{m["vaults.sidebar.link.all_objects"]()}
				</h3>
				<p className="text-muted-foreground text-sm">
					{m["vaults.shared.empty.no_item_selected"]()}
				</p>
				<p className="text-muted-foreground text-sm">
					{m["vaults.shared.empty.select_item_to_view_details"]()}
				</p>
			</div>
		</div>
	);
}
