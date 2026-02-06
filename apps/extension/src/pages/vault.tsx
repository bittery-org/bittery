import type { DecryptedItem } from "@bittery/shared/types";
import { Badge, Button, cn, Input, Skeleton, toast } from "@bittery/ui";
import {
	IconGear3OutlineDuo18,
	IconMobileOutlineDuo18,
	IconPlusOutlineDuo18,
} from "@bittery/ui/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ExtensionAccountSwitcher } from "@/components/account-switcher";
import { Favicon } from "@/components/favicon";
import { ItemDetailPanel } from "@/components/item-detail-panel";
import { storage } from "@/lib/storage";

type MultiAccountItem = DecryptedItem & {
	account?: {
		email: string;
		userId: string;
		name: string;
	};
	vault?: {
		id: string;
		name: string;
		type: string;
		icon: string | null;
		imageUrl: string | null;
	};
};

function getBaseDomain(host: string): string {
	const parts = host.split(".");
	if (parts.length <= 2) return host;
	return parts.slice(-2).join(".");
}

function hostnameMatches(
	itemUrl: string | undefined,
	targetHostname: string,
): boolean {
	if (!itemUrl) return false;

	try {
		const itemUrlObj = new URL(
			itemUrl.startsWith("http") ? itemUrl : `https://${itemUrl}`,
		);
		const itemHostname = itemUrlObj.hostname;

		if (itemHostname === targetHostname) return true;

		if (
			itemHostname.endsWith(`.${targetHostname}`) ||
			targetHostname.endsWith(`.${itemHostname}`)
		) {
			return true;
		}

		const itemBaseDomain = getBaseDomain(itemHostname);
		const hostnameBaseDomain = getBaseDomain(targetHostname);

		return itemBaseDomain === hostnameBaseDomain;
	} catch {
		return false;
	}
}

function ItemListRow({
	item,
	isSelected,
	isAllAccountsMode,
	onClick,
}: {
	item: DecryptedItem & { account?: { name: string } };
	isSelected: boolean;
	isAllAccountsMode: boolean;
	onClick: () => void;
}) {
	const title = item.title;
	const subtitle = item.username || item.url;

	return (
		<button
			className={cn(
				"mb-1 w-full cursor-pointer rounded-md px-3 py-2.5 text-left transition-colors",
				isSelected
					? "bg-primary text-primary-foreground"
					: "hover:bg-primary/10",
			)}
			onClick={onClick}
			type="button"
		>
			<div className="flex min-w-0 items-center gap-3">
				<Favicon
					url={item.url}
					title={title}
					category={item.category}
					size="sm"
				/>
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-1.5">
						<span className="truncate font-medium text-sm">{title}</span>
						{item.category === "login" && item.totpSecret && (
							<span title="Has 2FA">
								<IconMobileOutlineDuo18 className="size-3 shrink-0" />
							</span>
						)}
					</div>
					{subtitle && (
						<div
							className={cn(
								"mt-0.5 truncate text-xs",
								isSelected
									? "text-primary-foreground"
									: "text-muted-foreground",
							)}
						>
							{subtitle}
						</div>
					)}
					{isAllAccountsMode && (item as MultiAccountItem).account && (
						<div className="mt-0.5 flex items-center gap-1">
							<Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
								{(item as MultiAccountItem).account?.name}
							</Badge>
						</div>
					)}
				</div>
			</div>
		</button>
	);
}

export function VaultPage() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [searchQuery, setSearchQuery] = useState("");
	const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
	const [currentHostname, setCurrentHostname] = useState<string | null>(null);

	// Check if we're in "All Accounts" mode
	const { data: activeAccount } = useQuery({
		queryKey: ["accounts", "active"],
		queryFn: () => storage.getActiveAccount(),
		staleTime: 5 * 1000,
	});

	const isAllAccountsMode = activeAccount?.type === "all";

	useEffect(() => {
		chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
			const url = tabs[0]?.url;
			if (url) {
				try {
					setCurrentHostname(new URL(url).hostname);
				} catch {
					setCurrentHostname(null);
				}
			}
		});
	}, []);

	const { data: items = [], isLoading } = useQuery<DecryptedItem[]>({
		queryKey: ["vault-items"],
		queryFn: async () => {
			const response = await chrome.runtime.sendMessage({
				type: "GET_VAULT_ITEMS",
			});
			return response.items || [];
		},
	});

	const handleOpenDesktopApp = async () => {
		try {
			const response = await chrome.runtime.sendMessage({
				type: "OPEN_DESKTOP_APP",
			});
			if (!response?.success) {
				throw new Error(response?.error || "Failed to open desktop app");
			}
		} catch (error) {
			console.error(error);

			//   window.open(DESKTOP_APP_URL, "_blank", "noopener,noreferrer");
			toast.error(
				"Couldn't open the desktop app directly. Opening the web fallback.",
			);
		}
	};

	const normalizedQuery = searchQuery.trim().toLowerCase();

	const filteredItems = useMemo(() => {
		if (!normalizedQuery) return items;
		return items.filter((item) => {
			const fields = [
				item.title,
				item.username,
				item.url,
				item.notes,
				item.note,
			].filter(Boolean) as string[];
			return fields.some((value) =>
				value.toLowerCase().includes(normalizedQuery),
			);
		});
	}, [items, normalizedQuery]);

	// Sort items by relevance (matching URL), then favorite status, then alphabetically
	const sortedItems = useMemo(() => {
		return [...filteredItems].sort((a, b) => {
			const aMatches = currentHostname
				? hostnameMatches(a.url, currentHostname)
				: false;
			const bMatches = currentHostname
				? hostnameMatches(b.url, currentHostname)
				: false;

			// Matching items first
			if (aMatches && !bMatches) return -1;
			if (!aMatches && bMatches) return 1;

			// Then favorites
			if (a.favorite && !b.favorite) return -1;
			if (!a.favorite && b.favorite) return 1;

			return a.title.localeCompare(b.title);
		});
	}, [filteredItems, currentHostname]);

	useEffect(() => {
		if (sortedItems.length === 0) {
			setSelectedItemId(null);
			return;
		}

		if (!selectedItemId) {
			setSelectedItemId(sortedItems[0]?.id ?? null);
			return;
		}

		const stillVisible = sortedItems.some((item) => item.id === selectedItemId);
		if (!stillVisible) {
			setSelectedItemId(sortedItems[0]?.id ?? null);
		}
	}, [sortedItems, selectedItemId]);

	// Split into favorites and regular items
	const favoriteItems = sortedItems.filter((item) => item.favorite);
	const regularItems = sortedItems.filter((item) => !item.favorite);
	const selectedItem = sortedItems.find((item) => item.id === selectedItemId);

	const handleItemUpdated = useCallback(() => {
		// Invalidate all vault items queries
		queryClient.invalidateQueries({ queryKey: ["vault-items"] });
		queryClient.invalidateQueries({ queryKey: ["items-unified"] });
	}, [queryClient]);

	return (
		<div className="flex h-full flex-col">
			<header className="border-b bg-background px-4 py-3">
				<div className="flex items-center justify-between gap-3">
					<ExtensionAccountSwitcher />
					<div className="flex items-center gap-2">
						<Button
							size="icon"
							variant="ghost"
							onClick={() => navigate({ to: "/settings" })}
							title="Settings"
						>
							<IconGear3OutlineDuo18 className="size-[18px]" />
						</Button>
						<Button size="sm" onClick={handleOpenDesktopApp}>
							<IconPlusOutlineDuo18 className="mr-2 size-4" />
							New Item
						</Button>
					</div>
				</div>
			</header>

			<div className="flex flex-1 overflow-hidden">
				<aside className="flex w-[220px] shrink-0 flex-col border-r bg-muted/20">
					<div className="border-b p-3">
						<div className="relative">
							<Search
								className="absolute top-2.5 left-3 text-muted-foreground"
								size={16}
							/>
							<Input
								placeholder="Search items..."
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
								className="h-9 pl-9"
							/>
						</div>
					</div>

					<div className="flex-1 overflow-y-auto p-2">
						{isLoading ? (
							<div className="flex flex-col gap-2">
								{[1, 2, 3, 4, 5].map((i) => (
									<Skeleton key={i} className="h-[52px] w-full rounded-md" />
								))}
							</div>
						) : sortedItems.length === 0 ? (
							<div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
								<div className="font-semibold">
									{searchQuery ? "No matches found" : "No items yet"}
								</div>
								<p className="text-muted-foreground text-sm">
									{searchQuery
										? "Try a different search term."
										: "Create your first item in the desktop app."}
								</p>
								{!searchQuery && (
									<Button
										size="sm"
										variant="outline"
										onClick={handleOpenDesktopApp}
									>
										Open Desktop App
									</Button>
								)}
							</div>
						) : (
							<div className="flex flex-col">
								{favoriteItems.length > 0 && (
									<>
										<div className="mb-2 px-2 font-semibold text-muted-foreground text-xs uppercase">
											Favorites
										</div>
										{favoriteItems.map((item) => (
											<ItemListRow
												key={item.id}
												item={item}
												isSelected={item.id === selectedItemId}
												isAllAccountsMode={isAllAccountsMode}
												onClick={() => setSelectedItemId(item.id)}
											/>
										))}
										<div className="mt-4 mb-2 px-2 font-semibold text-muted-foreground text-xs uppercase">
											All Items
										</div>
									</>
								)}
								{regularItems.map((item) => (
									<ItemListRow
										key={item.id}
										item={item}
										isSelected={item.id === selectedItemId}
										isAllAccountsMode={isAllAccountsMode}
										onClick={() => setSelectedItemId(item.id)}
									/>
								))}
							</div>
						)}
					</div>
				</aside>

				<main className="flex-1 overflow-y-auto bg-background">
					<div className="p-5">
						{isLoading ? (
							<div className="space-y-4">
								<Skeleton className="h-10 w-48" />
								<Skeleton className="h-4 w-64" />
								<Skeleton className="h-40 w-full" />
							</div>
						) : selectedItem ? (
							<ItemDetailPanel
								item={selectedItem}
								onItemUpdated={handleItemUpdated}
							/>
						) : (
							<div className="flex h-full flex-col items-center justify-center gap-3 text-center">
								<div className="font-semibold">Select an item</div>
								<p className="text-muted-foreground text-sm">
									Choose an item from the list to see its details.
								</p>
							</div>
						)}
					</div>
				</main>
			</div>
		</div>
	);
}
