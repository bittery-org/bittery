import type { DecryptedItem } from "@bittery/shared/types";
import { Button, Card } from "@bittery/ui";
import { ShareHistoryDialog, ShareItemDialog } from "@/components/sharing";
import { useI18n } from "@/providers/i18n-provider";
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
	const { m } = useI18n();
	return (
		<div className="space-y-4">
			<div className="flex items-center gap-4">
				<Favicon title={data.title} category="secure-note" size="lg" />
				<div className="min-w-0 flex-1">
					<h2 className="truncate font-semibold text-2xl tracking-tight">
						{data.title}
					</h2>
					<p className="mt-1 text-muted-foreground text-sm">
						{m["vaults.detail.items.category.secure_note.title"]()}
					</p>
				</div>
			</div>

			<div className="flex gap-2">
				{onEdit && (
					<Button size="sm" variant="outline" onClick={onEdit}>
						{m["vaults.detail.items.detail.action.edit"]()}
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
						{m["vaults.detail.items.detail.action.delete"]()}
					</Button>
				)}
			</div>

			<Card className="gap-0 py-0">
				<div className="overflow-x-auto px-6 py-4">
					<pre className="m-0 inline-block min-w-full whitespace-pre text-[13px] leading-5">
						{data.note}
					</pre>
				</div>
			</Card>
		</div>
	);
}
