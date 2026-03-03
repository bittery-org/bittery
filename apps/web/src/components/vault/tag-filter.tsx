import {
	Button,
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	cn,
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@bittery/ui";
import {
	IconCheckOutlineDuo18 as Check,
	IconChevronDownOutlineDuo18 as ChevronDown,
	IconSortObjTopToBottomOutlineDuo18 as Filter,
} from "@bittery/ui/icons";
import { useState } from "react";
import { useI18n } from "@/providers/i18n-provider";
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
	const { m } = useI18n();
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
								? selectedTags.length === 1
									? m["vaults.detail.items.tag_filter.button.count.single"]({
											count: selectedTags.length,
										})
									: m["vaults.detail.items.tag_filter.button.count.plural"]({
											count: selectedTags.length,
										})
								: m["vaults.detail.items.tag_filter.button.default"]()}
						</span>
						<ChevronDown className="h-3.5 w-3.5 opacity-50" />
					</Button>
				</PopoverTrigger>
				<PopoverContent className="w-64 p-0" align="start">
					<Command>
						<CommandInput
							placeholder={m["vaults.detail.items.tag_filter.search.placeholder"]()}
							value={searchValue}
							onValueChange={setSearchValue}
						/>
						<CommandList>
							{filteredTags.length === 0 && (
								<CommandEmpty>
									{m["vaults.detail.items.tag_filter.empty"]()}
								</CommandEmpty>
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
							{m["vaults.detail.items.tag_filter.action.clear_all"]()}
						</button>
					)}
				</div>
			)}
		</div>
	);
}
