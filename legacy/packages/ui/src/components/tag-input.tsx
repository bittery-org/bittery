import { useI18n } from "@bittery/i18n/react";
import { useState } from "react";
import { IconCheck, IconPlus } from "../icons";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "./command";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { getTagColorFromName, TagBadge } from "./tag-badge";

interface TagInputProps {
	tags: string[];
	availableTags: string[];
	onChange: (tags: string[]) => void;
	disabled?: boolean;
	onTagClick?: (tagName: string) => void;
}

export function TagInput({
	tags,
	availableTags,
	onChange,
	disabled = false,
	onTagClick,
}: TagInputProps) {
	const { m } = useI18n();
	const [open, setOpen] = useState(false);
	const [searchValue, setSearchValue] = useState("");

	const selectedTagsSet = new Set(tags);

	const handleSelectTag = (tagName: string) => {
		if (selectedTagsSet.has(tagName)) {
			onChange(tags.filter((t) => t !== tagName));
		} else {
			onChange([...tags, tagName]);
		}
	};

	const handleCreateTag = () => {
		if (!searchValue.trim()) return;

		const newTag = searchValue.trim();
		const existingTag = availableTags.find(
			(t) => t.toLowerCase() === newTag.toLowerCase(),
		);

		if (existingTag) {
			if (!selectedTagsSet.has(existingTag)) {
				handleSelectTag(existingTag);
			}
		} else {
			onChange([...tags, newTag]);
		}

		setSearchValue("");
	};

	const filteredTags = availableTags.filter((tag) =>
		tag.toLowerCase().includes(searchValue.toLowerCase()),
	);

	const showCreateOption =
		searchValue.trim() &&
		!availableTags.some((t) => t.toLowerCase() === searchValue.toLowerCase());

	return (
		<div className="flex flex-wrap items-center gap-1.5">
			{tags.map((tag) => (
				<TagBadge
					key={tag}
					name={tag}
					onRemove={disabled ? undefined : () => handleSelectTag(tag)}
					onClick={onTagClick ? () => onTagClick(tag) : undefined}
				/>
			))}

			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					<button
						type="button"
						disabled={disabled}
						className="inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-0.5 font-medium text-muted-foreground text-xs outline-none transition-colors hover:border-strong hover:bg-accent hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-50"
					>
						<IconPlus className="size-3" />
						{tags.length > 0
							? m.vaults_detail_items_tag_input_button_add()
							: m.vaults_detail_items_tag_input_button_default()}
					</button>
				</PopoverTrigger>
				<PopoverContent className="w-64 p-0" align="start">
						<Command>
							<CommandInput
								placeholder={m.vaults_detail_items_tag_input_search_placeholder()}
								value={searchValue}
								onValueChange={setSearchValue}
							/>
							<CommandList>
								{filteredTags.length === 0 && !showCreateOption && (
									<CommandEmpty>
										{m.vaults_detail_items_tag_input_empty()}
									</CommandEmpty>
								)}
								{showCreateOption && (
									<CommandGroup>
										<CommandItem
											onSelect={handleCreateTag}
											className="flex items-center gap-2"
										>
											<IconPlus className="h-4 w-4" />
											<span>
												{m.vaults_detail_items_tag_input_action_create({
													tag: searchValue.trim(),
												})}
											</span>
										</CommandItem>
									</CommandGroup>
								)}
								{filteredTags.length > 0 && (
									<CommandGroup heading={m.vaults_detail_items_tag_input_group_tags()}>
										{filteredTags.map((tag) => {
											const isSelected = selectedTagsSet.has(tag);
											const color = getTagColorFromName(tag);
											return (
												<CommandItem
													key={tag}
													value={tag}
													onSelect={() => handleSelectTag(tag)}
													className="flex items-center gap-2"
												>
													<div
														className="h-3 w-3 rounded-full"
														style={{ backgroundColor: color }}
													/>
													<span className="flex-1">{tag}</span>
													{isSelected && (
														<IconCheck className="h-4 w-4 text-primary" />
													)}
												</CommandItem>
											);
										})}
									</CommandGroup>
								)}
							</CommandList>
						</Command>
				</PopoverContent>
			</Popover>
		</div>
	);
}
