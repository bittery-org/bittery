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
	cn,
} from "@bittery/ui";
import { Check, ChevronDown, Filter } from "lucide-react";
import { useState } from "react";
import { getTagColorFromName, TagBadge } from "./tag-badge";

interface TagFilterProps {
	tags: string[];
	selectedTags: string[];
	onSelectionChange: (tags: string[]) => void;
	disabled?: boolean;
}

export function TagFilter({
	tags,
	selectedTags,
	onSelectionChange,
	disabled = false,
}: TagFilterProps) {
	const [open, setOpen] = useState(false);
	const [searchValue, setSearchValue] = useState("");

	const handleToggleTag = (tag: string) => {
		if (selectedTags.includes(tag)) {
			onSelectionChange(selectedTags.filter((t) => t !== tag));
		} else {
			onSelectionChange([...selectedTags, tag]);
		}
	};

	const handleClearAll = () => {
		onSelectionChange([]);
	};

	const filteredTags = tags.filter((tag) =>
		tag.toLowerCase().includes(searchValue.toLowerCase()),
	);

	return (
		<div className="flex items-center gap-2">
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					<Button
						variant="outline"
						size="sm"
						className={cn(
							"h-9 gap-1",
							selectedTags.length > 0 && "border-primary/50 bg-primary/5",
						)}
						disabled={disabled || tags.length === 0}
					>
						<Filter className="h-3.5 w-3.5" />
						<span>
							{selectedTags.length > 0
								? `${selectedTags.length} tag${selectedTags.length > 1 ? "s" : ""}`
								: "Tags"}
						</span>
						<ChevronDown className="h-3.5 w-3.5 opacity-50" />
					</Button>
				</PopoverTrigger>
				<PopoverContent className="w-64 p-0" align="start">
					<Command>
						<CommandInput
							placeholder="Search tags..."
							value={searchValue}
							onValueChange={setSearchValue}
						/>
						<CommandList>
							{filteredTags.length === 0 && (
								<CommandEmpty>No tags found.</CommandEmpty>
							)}
							{filteredTags.length > 0 && (
								<CommandGroup>
									{filteredTags.map((tag) => {
										const isSelected = selectedTags.includes(tag);
										const color = getTagColorFromName(tag);
										return (
											<CommandItem
												key={tag}
												value={tag}
												onSelect={() => handleToggleTag(tag)}
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

			{/* Selected tag pills */}
			{selectedTags.length > 0 && (
				<div className="flex flex-wrap items-center gap-1">
					{selectedTags.map((tag) => (
						<TagBadge
							key={tag}
							name={tag}
							size="sm"
							onRemove={() => handleToggleTag(tag)}
						/>
					))}
					{selectedTags.length > 1 && (
						<button
							type="button"
							onClick={handleClearAll}
							className="ml-1 text-muted-foreground text-xs hover:text-foreground"
						>
							Clear all
						</button>
					)}
				</div>
			)}
		</div>
	);
}
