import { maskCardNumber } from "@bittery/shared/credit-card";
import { useTRPCClient } from "@bittery/shared/trpc";
import { Button } from "@bittery/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	createFileRoute,
	Link,
	Outlet,
	useParams,
} from "@tanstack/react-router";
import { Archive, Star } from "lucide-react";
import { Favicon } from "../../../components/vault/favicon";
import { useDecryptedItems } from "../../../hooks/use-decrypted-items";

export const Route = createFileRoute("/vault/$id")({
	component: RouteComponent,
});

function RouteComponent() {
	const trpcClient = useTRPCClient();
	const queryClient = useQueryClient();

	const { id, itemId } = useParams({ strict: false });

	// Fetch and decrypt items for the selected vault
	const { items: decryptedItems, isLoading } = useDecryptedItems(id || "");

	// Sort items by favorite status
	const items = [...decryptedItems].sort((a, b) => {
		// Sort favorites first
		if (a.favorite && !b.favorite) return -1;
		if (!a.favorite && b.favorite) return 1;
		return 0;
	});

	// Split into favorites and regular items
	const favoriteItems = items.filter((item) => item.favorite);
	const regularItems = items.filter((item) => !item.favorite);

	// Mutation to toggle favorite
	const toggleFavoriteMutation = useMutation({
		mutationFn: async (params: { itemId: string; favorite: boolean }) => {
			return trpcClient.vault.toggleFavorite.mutate(params);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: [
					["vault", "listItems"],
					{ input: { vaultId: id }, type: "query" },
				],
			});
			queryClient.invalidateQueries({ queryKey: ["decrypted-items", id] });
			queryClient.invalidateQueries({ queryKey: [["vault", "getItem", itemId]] });
			queryClient.invalidateQueries({ queryKey: [["decrypted-item", itemId]] });
		},
	});

	const handleToggleFavorite = (
		e: React.MouseEvent,
		itemId: string,
		currentFavorite: boolean,
	) => {
		e.preventDefault();
		e.stopPropagation();
		toggleFavoriteMutation.mutate({
			itemId,
			favorite: !currentFavorite,
		});
	};

	if (isLoading) {
		return (
			<div className="flex w-78 flex-col border-r bg-background">
				<div className="flex flex-1 items-center justify-center">
					<div className="text-muted-foreground text-sm">Loading items...</div>
				</div>
			</div>
		);
	}

	return (
		<>
			<div className="flex w-78 flex-col border-r bg-background">
				<div className="flex-1 overflow-y-auto">
					{items.length === 0 ? (
						<div className="flex h-full flex-col items-center justify-center p-8 text-center">
							<h3 className="mb-2 font-semibold">No items yet</h3>
							<p className="text-muted-foreground text-sm">
								Create your first item
							</p>
						</div>
					) : (
						<div className="flex flex-col p-2">
							{favoriteItems.length > 0 && (
								<>
									<div className="mb-2 px-3 font-semibold text-muted-foreground text-xs uppercase">
										Favorites
									</div>
									{id &&
										favoriteItems.map((item) => {
											const maskedCardNumber = item.cardNumber
												? maskCardNumber(item.cardNumber)
												: undefined;

											return (
												<Link
													to="/vault/$id/$itemId"
													params={{ id: id, itemId: item.id }}
													key={item.id}
													className={`mb-1 w-full rounded-md px-3 py-2.5 text-left transition-colors ${
														itemId === item.id
															? "bg-muted/60"
															: "hover:bg-muted/30"
													}`}
												>
													<div className="flex min-w-0 items-center gap-3">
														<Favicon
															url={item.url}
															title={item.title}
															category={item.category}
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
															{maskedCardNumber && (
																<div className="mt-0.5 truncate text-muted-foreground text-xs">
																	{maskedCardNumber}
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
												</Link>
											);
										})}
									<div className="mt-4 mb-2 px-3 font-semibold text-muted-foreground text-xs uppercase">
										All Items
									</div>
								</>
							)}
							{id &&
								regularItems.map((item) => {
									const maskedCardNumber = item.cardNumber
										? maskCardNumber(item.cardNumber)
										: undefined;

									return (
										<Link
											to="/vault/$id/$itemId"
											params={{ id: id, itemId: item.id }}
											key={item.id}
											className={`mb-1 w-full rounded-md px-3 py-2.5 text-left transition-colors ${
												itemId === item.id ? "bg-muted/60" : "hover:bg-muted/30"
											}`}
										>
											<div className="flex min-w-0 items-center gap-3">
												<Favicon
													url={item.url}
													title={item.title}
													category={item.category}
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
													{maskedCardNumber && (
														<div className="mt-0.5 truncate text-muted-foreground text-xs">
															{maskedCardNumber}
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
										</Link>
									);
								})}
						</div>
					)}
				</div>
				{id && (
					<div className="border-t p-2">
						<Button variant="ghost" size="sm" asChild>
							<Link to="/vault/$id/trash" params={{ id: id }}>
								<Archive className="size-4 text-muted-foreground" />
								<span className="text-sm">Trash</span>
							</Link>
						</Button>
					</div>
				)}
			</div>

			<div className="flex h-full flex-1 flex-col">
				<div className="flex flex-1 flex-col overflow-y-auto">
					<Outlet />
				</div>
			</div>
		</>
	);
}
