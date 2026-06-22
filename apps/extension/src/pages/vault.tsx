import type { DecryptedItemWithContext } from "@bittery/shared/types";
import { Badge, Button, cn, Input, Skeleton, toast } from "@bittery/ui";
import {
	IconCircleKeyOutlineDuo18,
	IconGear3OutlineDuo18,
	IconMagnifier3OutlineDuo18,
	IconMobileOutlineDuo18,
	IconPlusOutlineDuo18,
} from "@bittery/ui/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { ExtensionAccountSwitcher } from "@/components/account-switcher";
import { Favicon } from "@/components/favicon";
import { ItemDetailPanel } from "@/components/item-detail-panel";
import { storage } from "@/lib/storage";
import { useI18n } from "@/providers/i18n-provider";

type MultiAccountItem = DecryptedItemWithContext & {
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

type PopupActiveAccount = Awaited<ReturnType<typeof storage.getActiveAccount>>;

const LAST_SELECTED_ITEM_BY_SCOPE_KEY =
	"bittery_popup_last_selected_item_by_scope";

function getSelectionScope(activeAccount: PopupActiveAccount): string {
	if (!activeAccount) return "none";
	if (activeAccount.type === "all") return "all";
	return `single:${activeAccount.accountId}`;
}

function readSelectedItemForScope(scope: string): string | null {
	try {
		const raw = localStorage.getItem(LAST_SELECTED_ITEM_BY_SCOPE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const value = parsed[scope];
		return typeof value === "string" ? value : null;
	} catch {
		return null;
	}
}

function writeSelectedItemForScope(scope: string, itemId: string): void {
	try {
		const raw = localStorage.getItem(LAST_SELECTED_ITEM_BY_SCOPE_KEY);
		const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
		parsed[scope] = itemId;
		localStorage.setItem(
			LAST_SELECTED_ITEM_BY_SCOPE_KEY,
			JSON.stringify(parsed),
		);
	} catch {
		// Ignore storage failures in popup context.
	}
}

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
	item: DecryptedItemWithContext;
	isSelected: boolean;
	isAllAccountsMode: boolean;
	onClick: () => void;
}) {
	const { m } = useI18n();
	const title = item.title;
	const subtitle = item.username || item.url;
	const passkeyCount =
		item.category === "login" ? (item.passkeys?.length ?? 0) : 0;

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
				<Favicon item={item} title={title} size="sm" />
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-1.5">
						<span className="truncate font-medium text-sm">{title}</span>
						{item.category === "login" && item.totpSecret && (
							<span title={m.ext_vault_has_2fa()}>
								<IconMobileOutlineDuo18 className="size-3 shrink-0" />
							</span>
						)}
						{passkeyCount > 0 && (
							<span
								title={
									passkeyCount === 1
										? m.ext_vault_passkey_count_single({ count: passkeyCount })
										: m.ext_vault_passkey_count_plural({ count: passkeyCount })
								}
								className={cn(
									"inline-flex items-center",
									isSelected
										? "text-primary-foreground/80"
										: "text-muted-foreground",
								)}
							>
								<IconCircleKeyOutlineDuo18 className="size-3.5 shrink-0" />
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
	const { m } = useI18n();
	const [searchQuery, setSearchQuery] = useState("");
	const [manualSelectionByScope, setManualSelectionByScope] = useState<
		Record<string, string>
	>({});

	// Check if we're in "All Accounts" mode
	const { data: activeAccount } = useQuery({
		queryKey: ["accounts", "active"],
		queryFn: () => storage.getActiveAccount(),
		staleTime: 5 * 1000,
	});
	const selectionScope = useMemo(
		() => getSelectionScope(activeAccount ?? null),
		[activeAccount],
	);

	const isAllAccountsMode = activeAccount?.type === "all";
	const currentHostnameQuery = useQuery({
		queryKey: ["current-tab-hostname"],
		queryFn: async () => {
			return await new Promise<string | null>((resolve) => {
				chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
					const url = tabs[0]?.url;
					if (!url) {
						resolve(null);
						return;
					}
					try {
						resolve(new URL(url).hostname);
					} catch {
						resolve(null);
					}
				});
			});
		},
	});
	const currentHostname = currentHostnameQuery.data ?? null;

	const { data: items = [], isLoading } = useQuery<DecryptedItemWithContext[]>({
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
			toast.error(m.ext_vault_toast_desktop_fallback());
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

	const storedSelection = useMemo(
		() => readSelectedItemForScope(selectionScope),
		[selectionScope],
	);
	const selectedItemId = useMemo(() => {
		if (sortedItems.length === 0) {
			return null;
		}

		const manualSelection = manualSelectionByScope[selectionScope] ?? null;
		if (
			manualSelection &&
			sortedItems.some((item) => item.id === manualSelection)
		) {
			return manualSelection;
		}

		if (
			storedSelection &&
			sortedItems.some((item) => item.id === storedSelection)
		) {
			return storedSelection;
		}

		return sortedItems[0]?.id ?? null;
	}, [manualSelectionByScope, selectionScope, sortedItems, storedSelection]);

	// Split into favorites and regular items
	const favoriteItems = sortedItems.filter((item) => item.favorite);
	const regularItems = sortedItems.filter((item) => !item.favorite);
	const selectedItem = sortedItems.find((item) => item.id === selectedItemId);
	const handleSelectItem = useCallback(
		(itemId: string) => {
			setManualSelectionByScope((previous) => ({
				...previous,
				[selectionScope]: itemId,
			}));
			writeSelectedItemForScope(selectionScope, itemId);
		},
		[selectionScope],
	);

	const handleItemUpdated = useCallback(() => {
		// Invalidate all vault items queries
		queryClient.invalidateQueries({ queryKey: ["vault-items"] });
		queryClient.invalidateQueries({ queryKey: ["items"] });
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
							title={m.ext_vault_settings()}
						>
							<IconGear3OutlineDuo18 className="size-[18px]" />
						</Button>
						<Button size="sm" onClick={handleOpenDesktopApp}>
							<IconPlusOutlineDuo18 className="mr-2 size-4" />
							{m.ext_vault_new_item()}
						</Button>
					</div>
				</div>
			</header>

			<div className="flex flex-1 overflow-hidden">
				<aside className="flex w-[220px] shrink-0 flex-col border-r bg-muted/20">
					<div className="border-b p-3">
						<div className="relative">
							<IconMagnifier3OutlineDuo18
								className="absolute top-2.5 left-3 text-muted-foreground"
								size={16}
							/>
							<Input
								placeholder={m.ext_vault_search_placeholder()}
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
									{searchQuery
										? m.ext_vault_no_matches()
										: m.ext_vault_no_items()}
								</div>
								<p className="text-muted-foreground text-sm">
									{searchQuery
										? m.ext_vault_no_matches_hint()
										: m.ext_vault_no_items_hint()}
								</p>
								{!searchQuery && (
									<Button
										size="sm"
										variant="outline"
										onClick={handleOpenDesktopApp}
									>
										{m.ext_vault_open_desktop()}
									</Button>
								)}
							</div>
						) : (
							<div className="flex flex-col">
								{favoriteItems.length > 0 && (
									<>
										<div className="mb-2 px-2 font-semibold text-muted-foreground text-xs uppercase">
											{m.ext_vault_favorites()}
										</div>
										{favoriteItems.map((item) => (
											<ItemListRow
												key={item.id}
												item={item}
												isSelected={item.id === selectedItemId}
												isAllAccountsMode={isAllAccountsMode}
												onClick={() => handleSelectItem(item.id)}
											/>
										))}
										<div className="mt-4 mb-2 px-2 font-semibold text-muted-foreground text-xs uppercase">
											{m.ext_vault_all_items()}
										</div>
									</>
								)}
								{regularItems.map((item) => (
									<ItemListRow
										key={item.id}
										item={item}
										isSelected={item.id === selectedItemId}
										isAllAccountsMode={isAllAccountsMode}
										onClick={() => handleSelectItem(item.id)}
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
								<div className="font-semibold">{m.ext_vault_select_item()}</div>
								<p className="text-muted-foreground text-sm">
									{m.ext_vault_select_item_hint()}
								</p>
							</div>
						)}
					</div>
				</main>
			</div>
		</div>
	);
}
