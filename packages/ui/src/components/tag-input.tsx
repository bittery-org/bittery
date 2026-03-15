import { useI18n } from "@bittery/i18n/react";
import { useState } from "react";
import { IconCheckOutlineDuo18, IconPlusOutlineDuo18, IconTagsOutlineDuo18 } from "../icons";
import { Button } from "./button";
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
		<div className="space-y-2">
			{tags.length > 0 && (
				<div className="flex flex-wrap gap-1">
					{tags.map((tag) => (
						<TagBadge
							key={tag}
							name={tag}
							onRemove={disabled ? undefined : () => handleSelectTag(tag)}
							onClick={onTagClick ? () => onTagClick(tag) : undefined}
						/>
					))}
				</div>
			)}

			{!disabled && (
				<Popover open={open} onOpenChange={setOpen}>
					<PopoverTrigger asChild>
						<Button variant="outline" size="sm" className="h-8 gap-1">
							<IconTagsOutlineDuo18 className="h-3.5 w-3.5" />
							<span>
								{tags.length > 0
									? tags.length === 1
										? m.vaults_detail_items_tag_input_button_count_single({
												count: tags.length,
											})
										: m.vaults_detail_items_tag_input_button_count_plural({
												count: tags.length,
											})
									: m.vaults_detail_items_tag_input_button_default()}
							</span>
						</Button>
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
											<IconPlusOutlineDuo18 className="h-4 w-4" />
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
														<IconCheckOutlineDuo18 className="h-4 w-4 text-primary" />
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
			)}
		</div>
	);
}
