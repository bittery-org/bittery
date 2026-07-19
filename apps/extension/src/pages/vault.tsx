import { useAccountSwitcher } from "@bittery/core/hooks";
import type { DecryptedItemWithContext } from "@bittery/shared/types";
import { Button, cn, Skeleton, toast } from "@bittery/ui";
import {
	IconGlobe,
	IconLock,
	IconPasskey,
	IconPlus,
	IconSearch,
	IconSettings,
	IconSmartphone,
	IconWand,
} from "@bittery/ui/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { ExtensionAccountSwitcher } from "@/components/account-switcher";
import { Favicon } from "@/components/favicon";
import { ItemDetailPanel } from "@/components/item-detail-panel";
import { fillItemIntoActiveTab } from "@/lib/autofill-active-tab";
import { hostnameMatches } from "@/lib/hostname";
import { storage } from "@/lib/storage";
import { useI18n } from "@/providers/i18n-provider";

type PopupActiveAccount = Awaited<ReturnType<typeof storage.getActiveAccount>>;

const LAST_SELECTED_ITEM_BY_SCOPE_KEY =
	"bittery_popup_last_selected_item_by_scope";

function getSelectionScope(activeAccount: PopupActiveAccount): string {
	if (!activeAccount) return "none";
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

function GroupLabel({ children }: { children: React.ReactNode }) {
	return (
		<div className="px-2 pt-2 pb-1 font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
			{children}
		</div>
	);
}

function VaultRow({
	item,
	isSelected,
	isSuggested,
	onSelect,
	onFill,
}: {
	item: DecryptedItemWithContext;
	isSelected: boolean;
	isSuggested: boolean;
	onSelect: () => void;
	onFill: () => void;
}) {
	const { m } = useI18n();
	const title = item.title;
	const subtitle = item.username || item.url;
	const passkeyCount =
		item.category === "login" ? (item.passkeys?.length ?? 0) : 0;
	const has2fa = item.category === "login" && Boolean(item.totpSecret);

	return (
		<div className="group relative">
			<button
				type="button"
				onClick={onSelect}
				className={cn(
					"relative flex min-h-10 w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left transition-colors",
					isSelected
						? "bg-selected shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--color-primary)_14%,transparent)]"
						: "hover:bg-sidebar-accent",
				)}
			>
				{isSelected && (
					<span
						aria-hidden
						className="absolute top-[7px] bottom-[7px] left-[-4px] w-0.5 rounded-full bg-primary shadow-[0_0_8px_color-mix(in_oklab,var(--color-primary)_80%,transparent)]"
					/>
				)}
				<Favicon
					item={item}
					title={title}
					size="sm"
					className="size-[26px] rounded-[7px]"
				/>
				<span className="min-w-0 flex-1">
					<span className="flex items-center gap-1.5">
						<span className="truncate font-medium text-[12.5px] text-foreground">
							{title}
						</span>
						{passkeyCount > 0 && (
							<span
								className="inline-flex shrink-0 text-muted-foreground"
								title={
									passkeyCount === 1
										? m.ext_vault_passkey_count_single({ count: passkeyCount })
										: m.ext_vault_passkey_count_plural({ count: passkeyCount })
								}
							>
								<IconPasskey className="size-3" />
							</span>
						)}
						{has2fa && (
							<span
								className="inline-flex shrink-0 text-muted-foreground"
								title={m.ext_vault_has_2fa()}
							>
								<IconSmartphone className="size-3" />
							</span>
						)}
					</span>
					{subtitle && (
						<span className="mt-px block truncate text-[11px] text-muted-foreground">
							{subtitle}
						</span>
					)}
				</span>
			</button>
			{isSuggested && (
				<Button
					size="sm"
					onClick={onFill}
					title={m.ext_vault_fill()}
					className="absolute top-1/2 right-2 h-[22px] -translate-y-1/2 gap-1 rounded-full px-2.5 text-[11px] opacity-0 transition-opacity focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
				>
					<IconWand className="size-2.5" />
					{m.ext_vault_fill()}
				</Button>
			)}
		</div>
	);
}

function byTitle(a: DecryptedItemWithContext, b: DecryptedItemWithContext) {
	return a.title.localeCompare(b.title);
}

export function VaultPage() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { m } = useI18n();
	const { lockAllAccounts } = useAccountSwitcher();
	const [searchQuery, setSearchQuery] = useState("");
	const [manualSelectionByScope, setManualSelectionByScope] = useState<
		Record<string, string>
	>({});

	const { data: activeAccount } = useQuery({
		queryKey: ["accounts", "active"],
		queryFn: () => storage.getActiveAccount(),
		staleTime: 5 * 1000,
	});
	const selectionScope = useMemo(
		() => getSelectionScope(activeAccount ?? null),
		[activeAccount],
	);

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

	// Footer session status (drives the auto-lock countdown / desktop-sync label).
	const sessionStatusQuery = useQuery<{
		unlocked?: boolean;
		desktopMode?: boolean;
		remainingMs?: number | null;
	}>({
		queryKey: ["session-status"],
		queryFn: async () =>
			chrome.runtime.sendMessage({ type: "GET_SESSION_STATUS" }),
		refetchInterval: 15000,
	});
	const isDesktopMode = sessionStatusQuery.data?.desktopMode === true;
	const remainingMs = sessionStatusQuery.data?.remainingMs ?? null;
	const locksInMinutes =
		remainingMs != null ? Math.max(1, Math.ceil(remainingMs / 60000)) : null;

	const handleOpenDesktopApp = useCallback(async () => {
		try {
			const response = await chrome.runtime.sendMessage({
				type: "OPEN_DESKTOP_APP",
			});
			if (!response?.success) {
				throw new Error(response?.error || "Failed to open desktop app");
			}
		} catch (error) {
			console.error(error);
			toast.error(m.ext_vault_toast_desktop_open_failed());
		}
	}, [m]);

	// "New Item": in desktop mode, hand off to the desktop app's create-item
	// sheet (with the current tab's URL for prefill); standalone, open the web
	// vault since the popup has no create UI of its own.
	const handleNewItem = useCallback(async () => {
		if (isDesktopMode) {
			try {
				const [tab] = await chrome.tabs.query({
					active: true,
					currentWindow: true,
				});
				const tabUrl = tab?.url?.startsWith("http") ? tab.url : undefined;
				const response = await chrome.runtime.sendMessage({
					type: "OPEN_DESKTOP_APP",
					payload: { intent: "create_item", url: tabUrl },
				});
				if (!response?.success) {
					throw new Error(response?.error || "Failed to open desktop app");
				}
				window.close();
			} catch (error) {
				console.error(error);
				toast.error(m.ext_vault_toast_desktop_open_failed());
			}
			return;
		}

		try {
			const activeAccount = await storage.getActiveAccount();
			const accountId =
				activeAccount?.type === "single" ? activeAccount.accountId : null;
			const serverUrl = accountId
				? await storage.getServerUrl(accountId)
				: null;
			await chrome.tabs.create({ url: serverUrl || "https://app.bittery.com" });
			window.close();
		} catch (error) {
			console.error("Failed to open web vault:", error);
		}
	}, [isDesktopMode, m]);

	// "Open in app" on an item: deep-link to the item in the desktop app, or
	// to the web vault with the item selected when standalone.
	const handleOpenItemInApp = useCallback(
		async (item: DecryptedItemWithContext) => {
			if (isDesktopMode) {
				try {
					const response = await chrome.runtime.sendMessage({
						type: "OPEN_DESKTOP_APP",
						payload: {
							intent: "view_item",
							itemId: item.id,
							vaultId: item.vaultId,
						},
					});
					if (!response?.success) {
						throw new Error(response?.error || "Failed to open desktop app");
					}
					window.close();
				} catch (error) {
					console.error(error);
					toast.error(m.ext_vault_toast_desktop_open_failed());
				}
				return;
			}

			try {
				const base = (
					item.serverUrl ||
					(item.accountId
						? await storage.getServerUrl(item.accountId)
						: null) ||
					"https://app.bittery.com"
				).replace(/\/$/, "");
				await chrome.tabs.create({
					url: `${base}/vaults/${item.vaultId}?itemId=${encodeURIComponent(item.id)}`,
				});
				window.close();
			} catch (error) {
				console.error("Failed to open item in web vault:", error);
			}
		},
		[isDesktopMode, m],
	);

	const handleFill = useCallback(
		async (item: DecryptedItemWithContext) => {
			const filled = await fillItemIntoActiveTab(item);
			if (filled) {
				window.close();
				return;
			}
			toast.error(m.ext_vault_fill_failed());
		},
		[m],
	);

	const handleLockNow = useCallback(async () => {
		try {
			await lockAllAccounts.mutateAsync();
			navigate({ to: "/unlock" });
		} catch (error) {
			console.error("Failed to lock:", error);
			toast.error(m.ext_account_switcher_toast_lock_failed());
		}
	}, [lockAllAccounts, navigate, m]);

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

	// Suggested = login items matching the active tab's domain.
	const suggestedItems = useMemo(() => {
		if (!currentHostname) return [];
		return filteredItems
			.filter(
				(item) =>
					item.category === "login" &&
					hostnameMatches(item.url, currentHostname),
			)
			.sort((a, b) => {
				if (a.favorite && !b.favorite) return -1;
				if (!a.favorite && b.favorite) return 1;
				return byTitle(a, b);
			});
	}, [filteredItems, currentHostname]);

	const suggestedIds = useMemo(
		() => new Set(suggestedItems.map((item) => item.id)),
		[suggestedItems],
	);

	const favoriteItems = useMemo(
		() =>
			filteredItems
				.filter((item) => item.favorite && !suggestedIds.has(item.id))
				.sort(byTitle),
		[filteredItems, suggestedIds],
	);

	const regularItems = useMemo(
		() =>
			filteredItems
				.filter((item) => !item.favorite && !suggestedIds.has(item.id))
				.sort(byTitle),
		[filteredItems, suggestedIds],
	);

	const visibleItems = useMemo(
		() => [...suggestedItems, ...favoriteItems, ...regularItems],
		[suggestedItems, favoriteItems, regularItems],
	);

	const storedSelection = useMemo(
		() => readSelectedItemForScope(selectionScope),
		[selectionScope],
	);
	const selectedItemId = useMemo(() => {
		if (visibleItems.length === 0) return null;

		const manualSelection = manualSelectionByScope[selectionScope] ?? null;
		if (
			manualSelection &&
			visibleItems.some((item) => item.id === manualSelection)
		) {
			return manualSelection;
		}

		if (
			storedSelection &&
			visibleItems.some((item) => item.id === storedSelection)
		) {
			return storedSelection;
		}

		return visibleItems[0]?.id ?? null;
	}, [manualSelectionByScope, selectionScope, visibleItems, storedSelection]);

	const selectedItem = visibleItems.find((item) => item.id === selectedItemId);

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
		queryClient.invalidateQueries({ queryKey: ["vault-items"] });
		queryClient.invalidateQueries({ queryKey: ["items"] });
	}, [queryClient]);

	const selectedMatchesTab = Boolean(
		selectedItem &&
			selectedItem.category === "login" &&
			currentHostname &&
			hostnameMatches(selectedItem.url, currentHostname),
	);

	const footerText = isDesktopMode
		? m.ext_vault_status_synced()
		: locksInMinutes != null
			? m.ext_vault_status_locks_in({ minutes: locksInMinutes })
			: m.ext_vault_status_unlocked();

	const renderRow = (item: DecryptedItemWithContext, isSuggested: boolean) => (
		<VaultRow
			key={`${isSuggested ? "s-" : ""}${item.id}`}
			item={item}
			isSelected={item.id === selectedItemId}
			isSuggested={isSuggested}
			onSelect={() => handleSelectItem(item.id)}
			onFill={() => handleFill(item)}
		/>
	);

	return (
		<div className="flex h-full flex-col bg-background">
			<header className="flex h-12 shrink-0 items-center gap-1 border-b bg-background px-2.5 dark:bg-sidebar">
				<ExtensionAccountSwitcher />
				<span className="flex-1" />
				<Button
					size="icon"
					variant="ghost"
					className="size-7 text-muted-foreground"
					onClick={() => navigate({ to: "/settings" })}
					title={m.ext_vault_settings()}
				>
					<IconSettings className="size-3.5" />
				</Button>
				<Button size="sm" onClick={handleNewItem}>
					<IconPlus className="size-3.5" />
					{m.ext_vault_new_item()}
				</Button>
			</header>

			<div className="flex flex-1 overflow-hidden">
				<aside className="relative flex w-[244px] shrink-0 flex-col border-r bg-background dark:bg-sidebar">
					{/* Brand moment: aurora wash at the top of the list pane — dark mode only;
					    light mode stays flat like the desktop item list. */}
					<div
						aria-hidden
						className="pointer-events-none absolute inset-x-0 top-0 hidden h-[120px] dark:block dark:bg-[radial-gradient(130%_100%_at_30%_0%,color-mix(in_oklab,var(--color-primary-deep)_14%,transparent),transparent_65%)]"
					/>
					<div className="relative shrink-0 px-2 pt-2 pb-1.5">
						<div className="flex h-7 items-center gap-1.5 rounded-sm border bg-input/30 px-2 transition-colors focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/25 hover:border-border-strong">
							<IconSearch className="size-3.5 shrink-0 text-muted-foreground" />
							<input
								placeholder={m.ext_vault_search_placeholder()}
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
								className="min-w-0 flex-1 bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground"
							/>
						</div>
					</div>

					<div className="relative flex-1 overflow-y-auto px-1.5 pb-2">
						{isLoading ? (
							<div className="flex flex-col gap-1 p-1">
								{[1, 2, 3, 4, 5].map((i) => (
									<Skeleton key={i} className="h-10 w-full rounded-sm" />
								))}
							</div>
						) : visibleItems.length === 0 ? (
							<div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
								<div className="font-semibold text-sm">
									{searchQuery
										? m.ext_vault_no_matches()
										: m.ext_vault_no_items()}
								</div>
								<p className="text-muted-foreground text-xs">
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
								{suggestedItems.length > 0 && (
									<>
										<div className="flex items-center gap-1.5 px-2 pt-2 pb-1">
											<IconGlobe className="size-3 text-muted-foreground" />
											<span className="font-semibold text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
												{m.ext_vault_suggested()}
											</span>
											{currentHostname && (
												<span className="truncate font-medium text-[11px] text-muted-foreground">
													· {currentHostname}
												</span>
											)}
										</div>
										{suggestedItems.map((item) => renderRow(item, true))}
									</>
								)}

								{favoriteItems.length > 0 && (
									<>
										<GroupLabel>{m.ext_vault_favorites()}</GroupLabel>
										{favoriteItems.map((item) => renderRow(item, false))}
									</>
								)}

								{regularItems.length > 0 && (
									<>
										{(suggestedItems.length > 0 ||
											favoriteItems.length > 0) && (
											<GroupLabel>{m.ext_vault_all_items()}</GroupLabel>
										)}
										{regularItems.map((item) => renderRow(item, false))}
									</>
								)}
							</div>
						)}
					</div>
				</aside>

				<main className="flex min-w-0 flex-1 flex-col bg-background">
					<div className="flex-1 overflow-y-auto">
						{isLoading ? (
							<div className="space-y-4 p-[18px]">
								<Skeleton className="h-10 w-48 rounded-md" />
								<Skeleton className="h-4 w-64 rounded-sm" />
								<Skeleton className="h-40 w-full rounded-lg" />
							</div>
						) : selectedItem ? (
							<ItemDetailPanel
								item={selectedItem}
								onItemUpdated={handleItemUpdated}
								matchesActiveTab={selectedMatchesTab}
								onAutofill={() => handleFill(selectedItem)}
								onOpenInApp={() => handleOpenItemInApp(selectedItem)}
							/>
						) : (
							<div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
								<div className="font-semibold text-sm">
									{m.ext_vault_select_item()}
								</div>
								<p className="text-muted-foreground text-xs">
									{m.ext_vault_select_item_hint()}
								</p>
							</div>
						)}
					</div>

					<footer className="flex h-[30px] shrink-0 items-center gap-1.5 border-t bg-sidebar px-2.5 text-[11px] text-muted-foreground">
						<span
							aria-hidden
							className="size-1.5 rounded-full bg-success shadow-[0_0_6px_color-mix(in_oklab,var(--color-success)_60%,transparent)]"
						/>
						<span className="truncate">{footerText}</span>
						{!isDesktopMode && (
							<button
								type="button"
								onClick={handleLockNow}
								className="ml-auto inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-[5px] px-2 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
							>
								<IconLock className="size-3" />
								{m.ext_vault_lock_now()}
							</button>
						)}
					</footer>
				</main>
			</div>
		</div>
	);
}
