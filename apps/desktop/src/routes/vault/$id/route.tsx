import { useTRPC, useTRPCClient } from "@bittery/shared/trpc";
import { Button } from "@bittery/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createFileRoute,
	Link,
	Outlet,
	useParams,
} from "@tanstack/react-router";
import { Archive, Star } from "lucide-react";
import { Favicon } from "../../../components/vault/favicon";

export const Route = createFileRoute("/vault/$id")({
	component: RouteComponent,
});

interface ItemOverview {
	title: string;
	url?: string;
	username?: string;
	cardBrand?: string;
	maskedCardNumber?: string;
}

interface Item {
	id: string;
	vaultId: string;
	category: "login" | "secure-note" | "credit-card" | "identity";
	favorite: boolean;
	overview: ItemOverview;
	encryptedData: string;
	encryptionIv: string;
	encryptionAlgorithm: string;
	createdAt: string;
	updatedAt: string;
	deletedAt: string | null;
}

function RouteComponent() {
	const trpc = useTRPC();
	const trpcClient = useTRPCClient();
	const queryClient = useQueryClient();

	const { id, itemId } = useParams({ strict: false });

	// Fetch items for the selected vault
	const { data: rawItems = [] } = useQuery({
		...trpc.vault.listItems.queryOptions({
			vaultId: id || "",
		}),
		enabled: !!id,
	});

	// Convert raw items to Item type and sort by favorite status
	const items: Item[] = rawItems
		.map((item) => ({
			...item,
			overview: item.overview as ItemOverview,
		}))
		.sort((a, b) => {
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
			queryClient.invalidateQueries({ queryKey: [["vault", "getItem"]] });
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
										favoriteItems.map((item) => (
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
														url={item.overview.url}
														title={item.overview.title}
														category={item.category}
														cardBrand={item.overview.cardBrand}
														size="sm"
													/>
													<div className="min-w-0 flex-1">
														<div className="truncate font-medium text-sm">
															{item.overview.title}
														</div>
														{item.overview.username && (
															<div className="mt-0.5 truncate text-muted-foreground text-xs">
																{item.overview.username}
															</div>
														)}
														{item.overview.maskedCardNumber && (
															<div className="mt-0.5 truncate text-muted-foreground text-xs">
																{item.overview.maskedCardNumber}
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
										))}
									<div className="mt-4 mb-2 px-3 font-semibold text-muted-foreground text-xs uppercase">
										All Items
									</div>
								</>
							)}
							{id &&
								regularItems.map((item) => (
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
												url={item.overview.url}
												title={item.overview.title}
												category={item.category}
												cardBrand={item.overview.cardBrand}
												size="sm"
											/>
											<div className="min-w-0 flex-1">
												<div className="truncate font-medium text-sm">
													{item.overview.title}
												</div>
												{item.overview.username && (
													<div className="mt-0.5 truncate text-muted-foreground text-xs">
														{item.overview.username}
													</div>
												)}
												{item.overview.maskedCardNumber && (
													<div className="mt-0.5 truncate text-muted-foreground text-xs">
														{item.overview.maskedCardNumber}
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
								))}
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
