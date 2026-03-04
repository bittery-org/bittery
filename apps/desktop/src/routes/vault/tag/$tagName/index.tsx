import { IconTagOutlineDuo18 } from "@bittery/ui/icons";
import { createFileRoute } from "@tanstack/react-router";
import { useI18n } from "@/providers/i18n-provider";
import { getTagColorFromName } from "../../../../components/vault/tag-badge";

export const Route = createFileRoute("/vault/tag/$tagName/")({
	component: TagIndexComponent,
});

function TagIndexComponent() {
	const { m } = useI18n();
	const { tagName } = Route.useParams();
	const decodedTagName = decodeURIComponent(tagName);
	const tagColor = getTagColorFromName(decodedTagName);

	return (
		<div className="flex flex-1 items-center justify-center p-8 text-center">
			<div>
				<div
					className="mb-4 inline-flex rounded-full p-6"
					style={{ backgroundColor: `${tagColor}20` }}
				>
					<IconTagOutlineDuo18
						className="size-12"
						style={{ color: tagColor }}
					/>
				</div>
				<h3 className="mb-2 font-semibold text-lg">{decodedTagName}</h3>
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
