import type { ItemCategory } from "@bittery/shared/types";
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
import { useNavigate } from "@tanstack/react-router";
import {
	CreditCard,
	FileText,
	FolderClosed,
	Key,
	Search,
	Smartphone,
	User,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useVaultSearch } from "../../hooks/use-vault-search";

const getCategoryIcon = (category: ItemCategory) => {
	switch (category) {
		case "login":
			return Key;
		case "totp":
			return Smartphone;
		case "credit-card":
			return CreditCard;
		case "identity":
			return User;
		case "secure-note":
		default:
			return FileText;
	}
};

export function SearchCombobox() {
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const navigate = useNavigate();

	// Use client-side search through decrypted items
	const searchResults = useVaultSearch(search);

	const filteredVaults = searchResults.vaults;
	const filteredItems = searchResults.items;

	// Handle keyboard shortcut (Cmd/Ctrl + K)
	useEffect(() => {
		const down = (e: KeyboardEvent) => {
			if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				setOpen((open) => !open);
			}
		};

		document.addEventListener("keydown", down);
		return () => document.removeEventListener("keydown", down);
	}, []);

	const handleSelectVault = (vaultId: string) => {
		navigate({ to: "/vault/$id", params: { id: vaultId } });
		setOpen(false);
		setSearch("");
	};

	const handleSelectItem = (vaultId: string, itemId: string) => {
		navigate({ to: "/vault/$id/$itemId", params: { id: vaultId, itemId } });
		setOpen(false);
		setSearch("");
	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					variant="outline"
					role="combobox"
					aria-expanded={open}
					className="w-full justify-start text-muted-foreground"
				>
					<Search className="mr-2 size-4" />
					<span>Search vaults and items...</span>
					<kbd className="pointer-events-none ml-auto inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-medium font-mono text-[10px] text-muted-foreground opacity-100">
						<span className="text-xs">⌘</span>K
					</kbd>
				</Button>
			</PopoverTrigger>
			<PopoverContent
				className="w-(--radix-popover-trigger-width) p-0"
				align="start"
			>
				<Command shouldFilter={false}>
					<CommandInput
						placeholder="Search vaults and items..."
						value={search}
						onValueChange={setSearch}
					/>
					<CommandList>
						<CommandEmpty>No results found.</CommandEmpty>

						{filteredVaults.length > 0 && (
							<CommandGroup heading="Vaults">
								{filteredVaults.map((vault) => (
									<CommandItem
										key={vault.id}
										value={vault.id}
										onSelect={() => handleSelectVault(vault.id)}
										className="cursor-pointer"
									>
										<FolderClosed className="mr-2 size-4" />
										<span>{vault.name}</span>
									</CommandItem>
								))}
							</CommandGroup>
						)}

						{filteredItems.length > 0 && (
							<CommandGroup heading="Items">
								{filteredItems.map((item) => {
									const CategoryIcon = getCategoryIcon(item.category);
									return (
										<CommandItem
											key={item.id}
											value={item.id}
											onSelect={() => handleSelectItem(item.vaultId, item.id)}
											className="cursor-pointer"
										>
											<CategoryIcon className="mr-2 size-4" />
											<div className="flex flex-col">
												<span>{item.title}</span>
												{item.username && (
													<span className="text-muted-foreground text-xs">
														{item.username}
													</span>
												)}
												<span className="text-muted-foreground text-xs">
													in {item.vaultName}
												</span>
											</div>
										</CommandItem>
									);
								})}
							</CommandGroup>
						)}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
