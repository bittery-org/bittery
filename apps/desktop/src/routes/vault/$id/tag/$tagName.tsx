import { useToggleFavorite, useVaultItems } from "@bittery/hooks";
import { maskCardNumber } from "@bittery/shared/credit-card";
import { Button } from "@bittery/ui";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Smartphone, Star, Tag } from "lucide-react";
import { Favicon } from "../../../../components/vault/favicon";
import { getTagColorFromName } from "../../../../components/vault/tag-badge";

export const Route = createFileRoute("/vault/$id/tag/$tagName")({
	component: TagRouteComponent,
});

function TagRouteComponent() {
	const { id: vaultId, tagName } = Route.useParams();
	const navigate = useNavigate();

	// Decode the tag name from URL
	const decodedTagName = decodeURIComponent(tagName);
	const tagColor = getTagColorFromName(decodedTagName);

	// Fetch and decrypt items for the selected vault
	// useVaultItems automatically handles single-account vs all-accounts mode
	const { items: decryptedItems, isLoading } = useVaultItems(vaultId || "");

	// Filter items by tag
	const filteredItems = decryptedItems.filter((item) =>
		item.tags?.includes(decodedTagName),
	);

	// Mutation to toggle favorite
	const toggleFavorite = useToggleFavorite();

	const handleToggleFavorite = (
		e: React.MouseEvent,
		itemId: string,
		currentFavorite: boolean,
	) => {
		e.preventDefault();
		e.stopPropagation();
		toggleFavorite.mutate({
			itemId,
			vaultId: vaultId || "",
			favorite: !currentFavorite,
		});
	};

	if (isLoading) {
		return (
			<div className="flex flex-1 flex-col">
				<div className="flex flex-1 items-center justify-center">
					<div className="text-muted-foreground text-sm">Loading items...</div>
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-1 flex-col">
			{/* Header */}
			<div className="flex items-center gap-4 border-b bg-background px-8 py-4">
				<Button
					variant="ghost"
					size="icon"
					onClick={() =>
						navigate({ to: "/vault/$id", params: { id: vaultId } })
					}
				>
					<ArrowLeft className="size-4" />
				</Button>
				<div
					className="flex size-10 items-center justify-center rounded-full"
					style={{
						backgroundColor: `${tagColor}20`,
						color: tagColor,
					}}
				>
					<Tag className="size-5" />
				</div>
				<div>
					<h2 className="font-semibold text-lg">{decodedTagName}</h2>
					<p className="text-muted-foreground text-sm">
						{filteredItems.length}{" "}
						{filteredItems.length === 1 ? "item" : "items"}
					</p>
				</div>
			</div>

			{/* Content */}
			<div className="flex-1 overflow-y-auto p-8">
				{filteredItems.length === 0 ? (
					<div className="flex h-full flex-col items-center justify-center text-center">
						<div
							className="mb-4 inline-flex rounded-full p-6"
							style={{ backgroundColor: `${tagColor}20` }}
						>
							<Tag size={48} style={{ color: tagColor }} />
						</div>
						<h3 className="mb-2 font-semibold text-lg">
							No items with this tag
						</h3>
						<p className="text-muted-foreground text-sm">
							Items tagged with "{decodedTagName}" will appear here
						</p>
					</div>
				) : (
					<div className="mx-auto max-w-4xl space-y-2">
						{filteredItems.map((item) => {
							const maskedCardNumber = item.cardNumber
								? maskCardNumber(item.cardNumber)
								: undefined;

							return (
								<Link
									key={item.id}
									to="/vault/$id/$itemId"
									params={{ id: vaultId, itemId: item.id }}
									className="flex items-center justify-between rounded-lg border bg-card p-4 transition-colors hover:bg-muted/30"
								>
									<div className="flex min-w-0 flex-1 items-center gap-4">
										<Favicon
											url={item.url}
											title={item.title}
											category={item.category}
											size="md"
										/>
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-2">
												<span className="font-medium">{item.title}</span>
												{item.category === "login" && item.totpSecret && (
													<span title="Has 2FA">
														<Smartphone className="size-3.5 text-primary" />
													</span>
												)}
											</div>
											{item.username && (
												<div className="mt-0.5 text-muted-foreground text-sm">
													{item.username}
												</div>
											)}
											{maskedCardNumber && (
												<div className="mt-0.5 text-muted-foreground text-sm">
													{maskedCardNumber}
												</div>
											)}
										</div>
									</div>
									<button
										type="button"
										onClick={(e) =>
											handleToggleFavorite(e, item.id, item.favorite)
										}
										className={`shrink-0 ${
											item.favorite
												? "text-yellow-500 hover:text-yellow-600"
												: "text-muted-foreground hover:text-yellow-500"
										}`}
									>
										<Star
											className="size-4"
											fill={item.favorite ? "currentColor" : "none"}
										/>
									</button>
								</Link>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}
