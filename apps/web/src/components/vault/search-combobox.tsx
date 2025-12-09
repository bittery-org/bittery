import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { FileText, FolderClosed, Key, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { useTRPC } from "@/utils/trpc";

export function SearchCombobox() {
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const navigate = useNavigate();
	const trpc = useTRPC();

	// Use the new search endpoint
	const { data: searchResults } = useQuery({
		...trpc.vault.search.queryOptions({
			query: search,
		}),
		enabled: search.length > 0,
	});

	const filteredVaults = searchResults?.vaults || [];
	const filteredItems = searchResults?.items || [];

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
				className="w-[var(--radix-popover-trigger-width)] p-0"
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
								{filteredItems.map((item) => (
									<CommandItem
										key={item.id}
										value={item.id}
										onSelect={() => handleSelectItem(item.vaultId, item.id)}
										className="cursor-pointer"
									>
										{item.category === "login" ? (
											<Key className="mr-2 size-4" />
										) : (
											<FileText className="mr-2 size-4" />
										)}
										<div className="flex flex-col">
											<span>{item.overview.title}</span>
											{item.overview.username && (
												<span className="text-muted-foreground text-xs">
													{item.overview.username}
												</span>
											)}
											<span className="text-muted-foreground text-xs">
												in {item.vaultName}
											</span>
										</div>
									</CommandItem>
								))}
							</CommandGroup>
						)}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
