import {
	Button,
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@bittery/ui";
import {
	IconCheckOutlineDuo18 as Check,
	IconPlusOutlineDuo18 as Plus,
	IconTagsOutlineDuo18 as Tags,
} from "@bittery/ui/icons";
import { useState } from "react";
import { useI18n } from "@/providers/i18n-provider";
import { getTagColorFromName, TagBadge } from "./tag-badge";

interface TagInputProps {
	tags: string[];
	availableTags: string[];
	onChange: (tags: string[]) => void;
	disabled?: boolean;
}

export function TagInput({
	tags,
	availableTags,
	onChange,
	disabled = false,
}: TagInputProps) {
	const { m } = useI18n();
	const [open, setOpen] = useState(false);
	const [searchValue, setSearchValue] = useState("");

	const selectedTagsSet = new Set(tags);

	const handleSelectTag = (tagName: string) => {
		if (selectedTagsSet.has(tagName)) {
			// Remove tag
			onChange(tags.filter((t) => t !== tagName));
		} else {
			// Add tag
			onChange([...tags, tagName]);
		}
	};

	const handleCreateTag = () => {
		if (!searchValue.trim()) return;

		const newTag = searchValue.trim();

		// Check if tag already exists (case-insensitive)
		const existingTag = availableTags.find(
			(t) => t.toLowerCase() === newTag.toLowerCase(),
		);

		if (existingTag) {
			// Just select the existing tag
			if (!selectedTagsSet.has(existingTag)) {
				handleSelectTag(existingTag);
			}
		} else {
			// Create new tag by adding it to selection
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
			{/* Selected tags */}
			{tags.length > 0 && (
				<div className="flex flex-wrap gap-1">
					{tags.map((tag) => (
						<TagBadge
							key={tag}
							name={tag}
							onRemove={disabled ? undefined : () => handleSelectTag(tag)}
						/>
					))}
				</div>
			)}

			{/* Tag selector */}
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					<Button
						variant="outline"
						size="sm"
						className="h-8 gap-1"
						disabled={disabled}
					>
						<Tags className="h-3.5 w-3.5" />
						<span>
							{tags.length > 0
								? tags.length === 1
									? m["vaults.detail.items.tag_input.button.count.single"]({
											count: tags.length,
										})
									: m["vaults.detail.items.tag_input.button.count.plural"]({
											count: tags.length,
										})
								: m["vaults.detail.items.tag_input.button.default"]()}
						</span>
					</Button>
				</PopoverTrigger>
				<PopoverContent className="w-64 p-0" align="start">
					<Command>
						<CommandInput
							placeholder={m[
								"vaults.detail.items.tag_input.search.placeholder"
							]()}
							value={searchValue}
							onValueChange={setSearchValue}
						/>
						<CommandList>
							{filteredTags.length === 0 && !showCreateOption && (
								<CommandEmpty>
									{m["vaults.detail.items.tag_input.empty"]()}
								</CommandEmpty>
							)}
							{showCreateOption && (
								<CommandGroup>
									<CommandItem
										onSelect={handleCreateTag}
										className="flex items-center gap-2"
									>
										<Plus className="h-4 w-4" />
										<span>
											{m["vaults.detail.items.tag_input.action.create"]({
												tag: searchValue.trim(),
											})}
										</span>
									</CommandItem>
								</CommandGroup>
							)}
							{filteredTags.length > 0 && (
								<CommandGroup
									heading={m["vaults.detail.items.tag_input.group.tags"]()}
								>
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
													<Check className="h-4 w-4 text-primary" />
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
