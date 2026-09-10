/**
 * Tag rows, shared by Browse's Tags segment, the full tag list and search results.
 */

import { getTagColorFromName } from "@bittery/ui";
import { ListCard, ListRow } from "@/components/ui";

export interface TagRow {
	name: string;
	/** Omitted where the count is not derived — the tags list itself only knows the names. */
	count?: number;
}

/** The colour comes from the shared name hash, so a tag looks the same on every device. */
export function TagDot({ name }: { name: string }) {
	return (
		<span
			aria-hidden
			className="block size-[7px] rounded-full"
			style={{ backgroundColor: getTagColorFromName(name) }}
		/>
	);
}

export function TagListCard({
	tags,
	onSelect,
}: {
	tags: ReadonlyArray<TagRow>;
	onSelect: (name: string) => void;
}) {
	return (
		<ListCard>
			{tags.map((tag) => (
				<ListRow
					key={tag.name}
					leading={<TagDot name={tag.name} />}
					title={tag.name}
					value={tag.count === undefined ? undefined : String(tag.count)}
					showChevron
					compact
					onPress={() => onSelect(tag.name)}
				/>
			))}
		</ListCard>
	);
}
