import { useVaultSearch } from "@bittery/core/hooks";
import { getDomainFromUrl } from "@bittery/shared/favicon";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandItem,
	CommandList,
} from "@bittery/ui";
import {
	IconMagnifier3OutlineDuo18,
	IconTagOutlineDuo18,
} from "@bittery/ui/icons";
import { cn } from "@bittery/ui/lib/utils";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../providers/i18n-provider";
import { Favicon } from "./favicon";
import { getTagColorFromName } from "./tag-badge";
import { VaultAvatar } from "./vault-avatar";

export function SearchCombobox() {
	const { m } = useI18n();
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const navigate = useNavigate();
	const inputRef = useRef<HTMLInputElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);

	// Use client-side search through decrypted items
	const searchResults = useVaultSearch(search);

	const filteredVaults = searchResults.vaults;
	const filteredItems = searchResults.items;
	const filteredTags = searchResults.tags;

	const hasResults =
		filteredVaults.length > 0 ||
		filteredItems.length > 0 ||
		filteredTags.length > 0;

	// Handle keyboard shortcut (Cmd/Ctrl + K)
	useEffect(() => {
		const down = (e: KeyboardEvent) => {
			if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				inputRef.current?.focus();
			}
		};

		document.addEventListener("keydown", down);
		return () => document.removeEventListener("keydown", down);
	}, []);

	// Close dropdown when clicking outside
	useEffect(() => {
		const handleClickOutside = (e: MouseEvent) => {
			if (
				containerRef.current &&
				!containerRef.current.contains(e.target as Node)
			) {
				setOpen(false);
			}
		};

		document.addEventListener("mousedown", handleClickOutside);
		return () => document.removeEventListener("mousedown", handleClickOutside);
	}, []);

	const handleSelectVault = (vaultId: string) => {
		navigate({ to: "/vault/$id", params: { id: vaultId } });
		setOpen(false);
		setSearch("");
		inputRef.current?.blur();
	};

	const handleSelectItem = (vaultId: string, itemId: string) => {
		navigate({ to: "/vault/$id/$itemId", params: { id: vaultId, itemId } });
		setOpen(false);
		setSearch("");
		inputRef.current?.blur();
	};

	const handleSelectTag = (tagName: string) => {
		navigate({
			to: "/vault/tag/$tagName",
			params: { tagName: encodeURIComponent(tagName) },
		});
		setOpen(false);
		setSearch("");
		inputRef.current?.blur();
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Escape") {
			setOpen(false);
			setSearch("");
			inputRef.current?.blur();
		}
	};

	return (
		<div ref={containerRef} className="relative w-full">
			<Command shouldFilter={false} className="overflow-visible">
				<div className="flex h-9 w-full items-center rounded-md border border-input bg-transparent px-3 text-sm shadow-xs">
					<IconMagnifier3OutlineDuo18 className="mr-2 size-4 shrink-0 text-muted-foreground" />
					<input
						ref={inputRef}
						value={search}
						onChange={(e) => {
							setSearch(e.target.value);
							setOpen(true);
						}}
						onFocus={() => setOpen(true)}
						onKeyDown={handleKeyDown}
						className="flex-1 bg-transparent placeholder:text-muted-foreground focus:outline-none"
						placeholder={m["vaults.search_combobox.placeholder"]()}
					/>
					<kbd className="pointer-events-none ml-auto inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-medium font-mono text-[10px] text-muted-foreground">
						<span className="text-xs">⌘</span>K
					</kbd>
				</div>

				<div
					className={cn(
						"absolute top-full left-0 z-50 mt-1 w-full rounded-md border bg-popover shadow-md",
						open && (hasResults || search.length > 0) ? "block" : "hidden",
					)}
				>
					<CommandList>
						<CommandEmpty>{m["vaults.search_combobox.empty"]()}</CommandEmpty>

						{filteredItems.length > 0 && (
							<CommandGroup heading={m["vaults.detail.tab.items"]()}>
								{filteredItems.map((item) => {
									const domain = item.url
										? getDomainFromUrl(item.url)
										: undefined;
									return (
										<CommandItem
											key={item.id}
											value={item.id}
											onSelect={() => handleSelectItem(item.vaultId, item.id)}
											className="cursor-pointer py-1.5"
										>
											<div className="flex min-w-0 flex-1 items-center gap-2">
												<Favicon
													item={item}
													cardBrand={item.cardBrand}
													size="sm"
													className="size-6 shrink-0 rounded-md text-[10px]"
												/>
												<span className="shrink-0 font-medium">
													{item.title}
												</span>
												{item.category === "login" &&
													(item.username || domain) && (
														<span className="min-w-0 truncate text-muted-foreground text-xs">
															{[item.username, domain]
																.filter(Boolean)
																.join(" · ")}
														</span>
													)}
											</div>
										</CommandItem>
									);
								})}
							</CommandGroup>
						)}

						{filteredVaults.length > 0 && (
							<CommandGroup heading={m["nav.item.vaults"]()}>
								{filteredVaults.map((vault) => (
									<CommandItem
										key={vault.id}
										value={vault.id}
										onSelect={() => handleSelectVault(vault.id)}
										className="cursor-pointer py-1.5"
									>
										<div className="flex min-w-0 flex-1 items-center gap-2">
											<VaultAvatar
												name={vault.name}
												icon={vault.icon}
												imageUrl={vault.imageUrl}
												size="xs"
												className="size-6 shrink-0"
											/>
											<span className="font-medium">{vault.name}</span>
											{vault.teamName && (
												<span className="text-muted-foreground text-xs">
													{vault.teamName}
												</span>
											)}
										</div>
									</CommandItem>
								))}
							</CommandGroup>
						)}

						{filteredTags.length > 0 && (
							<CommandGroup
								heading={m["vaults.detail.items.detail.tags.label"]()}
							>
								{filteredTags.map((tag) => {
									const tagColor = getTagColorFromName(tag);
									return (
										<CommandItem
											key={tag}
											value={`tag-${tag}`}
											onSelect={() => handleSelectTag(tag)}
											className="cursor-pointer py-1.5"
										>
											<div className="flex min-w-0 flex-1 items-center gap-2">
												<div
													className="flex size-6 shrink-0 items-center justify-center rounded-md"
													style={{ backgroundColor: `${tagColor}20` }}
												>
													<IconTagOutlineDuo18
														className="size-3.5"
														style={{ color: tagColor }}
													/>
												</div>
												<span className="font-medium">{tag}</span>
											</div>
										</CommandItem>
									);
								})}
							</CommandGroup>
						)}
					</CommandList>
				</div>
			</Command>
		</div>
	);
}
