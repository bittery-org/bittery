import { Button, Card, Label } from "@bittery/ui";
import { Favicon } from "../favicon";
import { TagInput } from "../tag-input";
import type { CategoryDetailProps, SecureNoteDisplayData } from "./shared";

export function SecureNoteDetail({
	data,
	onEdit,
	onDelete,
	onTagsChange,
	onTagClick,
	availableTags = [],
	isUpdatingTags,
}: CategoryDetailProps<SecureNoteDisplayData>) {
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

			{/* Tags */}
			{onTagsChange && (
				<div className="space-y-2">
					<Label>Tags</Label>
					<TagInput
						tags={data.tags || []}
						availableTags={availableTags}
						onChange={onTagsChange}
						onTagClick={onTagClick}
						disabled={isUpdatingTags}
					/>
				</div>
			)}

			<Card>
				<div className="whitespace-pre-wrap p-6 leading-relaxed">
					{data.note}
				</div>
			</Card>
		</div>
	);
}
