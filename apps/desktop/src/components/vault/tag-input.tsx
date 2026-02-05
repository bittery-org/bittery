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
	IconCheckOutlineDuo18,
	IconPlusOutlineDuo18,
	IconTagsOutlineDuo18,
} from "@bittery/ui/icons";
import { useState } from "react";
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
							onClick={onTagClick ? () => onTagClick(tag) : undefined}
						/>
					))}
				</div>
			)}

			{/* Tag selector */}
			{!disabled && (
				<Popover open={open} onOpenChange={setOpen}>
					<PopoverTrigger asChild>
						<Button variant="outline" size="sm" className="h-8 gap-1">
							<IconTagsOutlineDuo18 className="h-3.5 w-3.5" />
							<span>
								{tags.length > 0
									? `${tags.length} tag${tags.length > 1 ? "s" : ""}`
									: "Add tags"}
							</span>
						</Button>
					</PopoverTrigger>
					<PopoverContent className="w-64 p-0" align="start">
						<Command>
							<CommandInput
								placeholder="Search or create tags..."
								value={searchValue}
								onValueChange={setSearchValue}
							/>
							<CommandList>
								{filteredTags.length === 0 && !showCreateOption && (
									<CommandEmpty>No tags found.</CommandEmpty>
								)}
								{showCreateOption && (
									<CommandGroup>
										<CommandItem
											onSelect={handleCreateTag}
											className="flex items-center gap-2"
										>
											<IconPlusOutlineDuo18 className="h-4 w-4" />
											<span>Create &quot;{searchValue.trim()}&quot;</span>
										</CommandItem>
									</CommandGroup>
								)}
								{filteredTags.length > 0 && (
									<CommandGroup heading="Tags">
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
