import type { DecryptedItem } from "@bittery/shared/types";
import { Button, Card } from "@bittery/ui";
import { ShareHistoryDialog, ShareItemDialog } from "@/components/sharing";
import { Favicon } from "../favicon";
import type { CategoryDetailProps, SecureNoteDisplayData } from "./shared";

interface SecureNoteDetailProps
	extends CategoryDetailProps<SecureNoteDisplayData> {
	item?: DecryptedItem;
}

export function SecureNoteDetail({
	data,
	onEdit,
	onDelete,
	item,
}: SecureNoteDetailProps) {
	return (
		<div className="space-y-4">
			<div className="flex items-center gap-4">
				<Favicon title={data.title} category="secure-note" size="lg" />
				<div className="min-w-0 flex-1">
					<h2 className="truncate font-semibold text-2xl tracking-tight">
						{data.title}
					</h2>
					<p className="mt-1 text-muted-foreground text-sm">Secure Note</p>
				</div>
			</div>

			<div className="flex gap-2">
				{onEdit && (
					<Button size="sm" variant="outline" onClick={onEdit}>
						Edit
					</Button>
				)}
				{item && <ShareItemDialog item={item} />}
				{item && <ShareHistoryDialog itemId={item.id} />}
				{onDelete && (
					<Button
						size="sm"
						variant="ghost"
						className="text-destructive hover:bg-destructive/10 hover:text-destructive"
						onClick={onDelete}
					>
						Delete
					</Button>
				)}
			</div>

			<Card>
				<div className="whitespace-pre-wrap p-6 leading-relaxed">
					{data.note}
				</div>
			</Card>
		</div>
	);
}
