import { Button, Card, Label } from "@bittery/ui";
import { Favicon } from "../favicon";
import { TagInput } from "../tag-input";
import { DetailHeader } from "./field-components";
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
			<DetailHeader
				icon={<Favicon title={data.title} category="secure-note" size="lg" />}
				title={data.title}
				subtitle="Secure Note"
			/>

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

			<Card className="gap-0 py-0">
				<div className="overflow-x-auto px-6 py-4">
					<pre className="m-0 inline-block min-w-full whitespace-pre font-mono text-[13px] leading-5">
						{data.note}
					</pre>
				</div>
			</Card>

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
		</div>
	);
}
