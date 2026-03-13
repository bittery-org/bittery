import { Button, Card, Label } from "@bittery/ui";
import { useI18n } from "../../../providers/i18n-provider";
import { Favicon } from "../favicon";
import { TagInput } from "../tag-input";
import { DetailHeader } from "./field-components";
import type { CategoryDetailProps, SecureNoteDisplayData } from "./shared";

export function SecureNoteDetail({
	data,
	serverUrl,
	onEdit,
	onDelete,
	onTagsChange,
	onTagClick,
	availableTags = [],
	isUpdatingTags,
}: CategoryDetailProps<SecureNoteDisplayData>) {
	const { m } = useI18n();

	return (
		<div className="space-y-4">
			<DetailHeader
				icon={
					<Favicon
						title={data.title}
						serverUrl={serverUrl}
						category="secure-note"
						size="lg"
					/>
				}
				title={data.title}
				subtitle={m["vaults.detail.items.category.secure_note.title"]()}
			/>

			<div className="flex gap-2">
				{onEdit && (
					<Button size="sm" variant="outline" onClick={onEdit}>
						{m["vaults.detail.items.detail.action.edit"]()}
					</Button>
				)}
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
					<pre className="m-0 inline-block min-w-full whitespace-pre font-mono text-[13px] leading-5">
						{data.note}
					</pre>
				</div>
			</Card>

			{/* Tags */}
			{onTagsChange && (
				<div className="space-y-2">
					<Label>{m["vaults.detail.items.detail.tags.label"]()}</Label>
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
