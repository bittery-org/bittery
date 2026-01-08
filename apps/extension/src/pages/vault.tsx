import { Button, Input, Skeleton } from "@bittery/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Plus, Search, Star } from "lucide-react";
import { useState } from "react";
import { Favicon } from "@/components/favicon";

export function VaultPage() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [searchQuery, setSearchQuery] = useState("");

	const { data: items, isLoading } = useQuery({
		queryKey: ["vault-items"],
		queryFn: async () => {
			const response = await chrome.runtime.sendMessage({
				type: "GET_VAULT_ITEMS",
			});
			return response.items || [];
		},
	});

	const handleToggleFavorite = async (
		e: React.MouseEvent,
		itemId: string,
		currentFavorite: boolean,
	) => {
		e.stopPropagation();
		await chrome.runtime.sendMessage({
			type: "TOGGLE_FAVORITE",
			itemId,
			favorite: !currentFavorite,
		});
		queryClient.invalidateQueries({ queryKey: ["vault-items"] });
	};

	const filteredItems =
		items?.filter(
			(item: any) =>
				item.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
				item.username?.toLowerCase().includes(searchQuery.toLowerCase()) ||
				item.websiteUrl?.toLowerCase().includes(searchQuery.toLowerCase()),
		) || [];

	// Sort items by favorite status
	const sortedItems = [...filteredItems].sort((a, b) => {
		if (a.favorite && !b.favorite) return -1;
		if (!a.favorite && b.favorite) return 1;
		return 0;
	});

	// Split into favorites and regular items
	const favoriteItems = sortedItems.filter((item: any) => item.favorite);
	const regularItems = sortedItems.filter((item: any) => !item.favorite);

	return (
		<div className="flex h-[400px] flex-col">
			<div className="border-b bg-background p-4">
				<div className="mb-3 flex items-center justify-between">
					<h1 className="font-semibold text-lg">Vault</h1>
					<Button asChild size="icon" variant="ghost">
						<a href="http://localhost:3001" target="_blank" rel="noreferrer">
							<Plus size={18} />
						</a>
					</Button>
				</div>
				<div className="relative">
					<Search
						className="absolute top-2.5 left-3 text-muted-foreground"
						size={16}
					/>
					<Input
						placeholder="Search vault..."
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className="pl-9"
					/>
				</div>
			</div>

			<div className="flex-1 overflow-y-auto">
				{isLoading ? (
					<div className="flex flex-col p-2">
						{[1, 2, 3].map((i) => (
							<Skeleton key={i} className="mb-1 h-[52px] w-full rounded-md" />
						))}
					</div>
				) : filteredItems.length === 0 ? (
					<div className="flex h-full flex-col items-center justify-center p-8 text-center">
						<h3 className="mb-2 font-semibold">No items yet</h3>
						<p className="text-muted-foreground text-sm">
							{searchQuery ? "No items found" : "Create your first item"}
						</p>
					</div>
				) : (
					<div className="flex flex-col p-2">
						{favoriteItems.length > 0 && (
							<>
								<div className="mb-2 px-3 font-semibold text-muted-foreground text-xs uppercase">
									Favorites
								</div>
								{favoriteItems.map((item: any) => (
									<button
										key={item.id}
										className="mb-1 w-full rounded-md px-3 py-2.5 text-left transition-colors hover:bg-muted/30"
										onClick={() => navigate({ to: `/item/${item.id}` })}
										type="button"
									>
										<div className="flex min-w-0 items-center gap-3">
											<Favicon
												url={item.websiteUrl}
												title={item.title}
												category="login"
												size="sm"
											/>
											<div className="min-w-0 flex-1">
												<div className="truncate font-medium text-sm">
													{item.title}
												</div>
												{item.username && (
													<div className="mt-0.5 truncate text-muted-foreground text-xs">
														{item.username}
													</div>
												)}
											</div>
											<button
												type="button"
												onClick={(e) =>
													handleToggleFavorite(e, item.id, item.favorite)
												}
												className="shrink-0 text-yellow-500 hover:text-yellow-600"
											>
												<Star className="size-4" fill="currentColor" />
											</button>
										</div>
									</button>
								))}
								<div className="mt-4 mb-2 px-3 font-semibold text-muted-foreground text-xs uppercase">
									All Items
								</div>
							</>
						)}
						{regularItems.map((item: any) => (
							<button
								key={item.id}
								className="mb-1 w-full rounded-md px-3 py-2.5 text-left transition-colors hover:bg-muted/30"
								onClick={() => navigate({ to: `/item/${item.id}` })}
								type="button"
							>
								<div className="flex min-w-0 items-center gap-3">
									<Favicon
										url={item.websiteUrl}
										title={item.title}
										category="login"
										size="sm"
									/>
									<div className="min-w-0 flex-1">
										<div className="truncate font-medium text-sm">
											{item.title}
										</div>
										{item.username && (
											<div className="mt-0.5 truncate text-muted-foreground text-xs">
												{item.username}
											</div>
										)}
									</div>
									<button
										type="button"
										onClick={(e) =>
											handleToggleFavorite(e, item.id, item.favorite)
										}
										className="shrink-0 text-muted-foreground hover:text-yellow-500"
									>
										<Star className="size-4" />
									</button>
								</div>
							</button>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
