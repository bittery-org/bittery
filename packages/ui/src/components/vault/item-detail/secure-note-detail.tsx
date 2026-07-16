import { useI18n } from "@bittery/i18n/react";
import { Button } from "../../button";
import { Label } from "../../label";
import { TagInput } from "../../tag-input";
import { DetailHeader } from "./field-components";
import type { CategoryDetailProps, SecureNoteDisplayData } from "./shared";

export function SecureNoteDetail({
	data,
	icon,
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
				icon={icon}
				title={data.title}
				subtitle={m.vaults_detail_items_category_secure_note_title()}
			/>

			<div className="flex gap-2">
				{onEdit && (
					<Button size="sm" variant="outline" onClick={onEdit}>
						{m.vaults_detail_items_detail_action_edit()}
					</Button>
				)}
				{onDelete && (
					<Button
						size="sm"
						variant="ghost"
						className="text-destructive hover:bg-destructive/10 hover:text-destructive"
						onClick={onDelete}
					>
						{m.vaults_detail_items_detail_action_delete()}
					</Button>
				)}
			</div>

			<div className="overflow-hidden rounded-lg border bg-card">
				<div className="overflow-x-auto px-4 py-3">
					<pre className="m-0 inline-block min-w-full whitespace-pre font-mono text-[13px] leading-5 text-foreground">
						{data.note}
					</pre>
				</div>
			</div>

			{onTagsChange && (
				<div className="space-y-2">
					<Label>{m.vaults_detail_items_detail_tags_label()}</Label>
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
