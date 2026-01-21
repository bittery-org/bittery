import { createFileRoute } from "@tanstack/react-router";
import { Tag } from "lucide-react";
import { getTagColorFromName } from "../../../../components/vault/tag-badge";

export const Route = createFileRoute("/vault/tag/$tagName/")({
	component: TagIndexComponent,
});

function TagIndexComponent() {
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
					<Tag className="size-12" style={{ color: tagColor }} />
				</div>
				<h3 className="mb-2 font-semibold text-lg">{decodedTagName}</h3>
				<p className="text-muted-foreground text-sm">No item selected</p>
				<p className="text-muted-foreground text-sm">
					Select an item from the list to view its details.
				</p>
			</div>
		</div>
	);
}
