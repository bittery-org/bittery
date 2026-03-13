import type { DecryptedItemWithContext } from "@bittery/shared/types";
import { Card, cn } from "@bittery/ui";
import { IconLockOutlineDuo18 } from "@bittery/ui/icons";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { getIframeNonceFromLocation } from "@/content-script/iframe-messages";

export interface AutofillIframeConfig {
	/** Message type for receiving items (e.g. "AUTOFILL_ITEMS") */
	itemsMessageType: string;
	/** Message type for filter queries (e.g. "FILTER_ITEMS") */
	filterMessageType: string;
	/** Message type to signal iframe readiness (e.g. "IFRAME_READY") */
	readyMessageType: string;
	/** Message type for item selection (e.g. "AUTOFILL_SELECT") */
	selectMessageType: string;
	/** Filter function for search queries */
	filterFn: (
		items: DecryptedItemWithContext[],
		query: string,
	) => DecryptedItemWithContext[];
	/** Optional preprocessing of items before storing (e.g. filter to category) */
	preprocessItems?: (
		items: DecryptedItemWithContext[],
	) => DecryptedItemWithContext[];
	/** Default field type for the iframe */
	defaultFieldType: string;
	/** Icon shown in the empty state */
	emptyIcon: ReactNode;
	/** Text shown when no items exist */
	emptyText: string;
	/** Text shown in the unlock required state */
	unlockText: string;
	/** Singular noun for items (e.g. "login") */
	itemNounSingular: string;
	/** Plural noun for items (e.g. "logins") */
	itemNounPlural: string;
	/** Renders the content inside each item button */
	renderItem: (item: DecryptedItemWithContext) => ReactNode;
}

export function AutofillIframeBase({
	config,
}: {
	config: AutofillIframeConfig;
}) {
	const nonce = getIframeNonceFromLocation() ?? "";
	const [allItems, setAllItems] = useState<DecryptedItemWithContext[]>([]);
	const [filteredItems, setFilteredItems] = useState<
		DecryptedItemWithContext[]
	>([]);
	const [filterQuery, setFilterQuery] = useState("");
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [_fieldType, setFieldType] = useState<string>(config.defaultFieldType);
	const [needsUnlock, setNeedsUnlock] = useState(false);
	const allItemsRef = useRef<DecryptedItemWithContext[]>([]);

	// Listen for items from parent — uses allItemsRef to avoid infinite loop
	// (do NOT put allItems in the dependency array)
	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			if (event.data?.nonce !== nonce) {
				return;
			}

			if (event.data.type === config.itemsMessageType) {
				const items = config.preprocessItems
					? config.preprocessItems(event.data.items || [])
					: event.data.items || [];
				allItemsRef.current = items;
				setAllItems(items);
				setFilteredItems(items);
				setFilterQuery("");
				setFieldType(event.data.fieldType || config.defaultFieldType);
				setSelectedIndex(0);
				setNeedsUnlock(false);
			} else if (event.data.type === "NEEDS_UNLOCK") {
				setNeedsUnlock(true);
				allItemsRef.current = [];
				setAllItems([]);
				setFilteredItems([]);
				setFilterQuery("");
			} else if (event.data.type === config.filterMessageType) {
				const query = event.data.query || "";
				setFilterQuery(query);
				const filtered = config.filterFn(allItemsRef.current, query);
				setFilteredItems(filtered);
				setSelectedIndex(0);
			}
		};

		window.addEventListener("message", handleMessage);
		window.parent.postMessage({ type: config.readyMessageType, nonce }, "*");

		return () => window.removeEventListener("message", handleMessage);
	}, [
		config.defaultFieldType,
		config.filterFn,
		config.filterMessageType,
		config.itemsMessageType,
		nonce,
		config.preprocessItems,
		config.readyMessageType,
	]);

	const handleSelect = useCallback(
		(item: DecryptedItemWithContext) => {
			window.parent.postMessage(
				{ type: config.selectMessageType, item, nonce },
				"*",
			);
		},
		[config.selectMessageType, nonce],
	);

	// Keyboard navigation via native keydown and forwarded KEYBOARD_NAV messages
	useEffect(() => {
		const navigate = (key: string) => {
			if (filteredItems.length === 0) return;
			switch (key) {
				case "ArrowDown":
					setSelectedIndex((prev) => (prev + 1) % filteredItems.length);
					break;
				case "ArrowUp":
					setSelectedIndex(
						(prev) => (prev - 1 + filteredItems.length) % filteredItems.length,
					);
					break;
				case "Enter":
					if (filteredItems[selectedIndex]) {
						handleSelect(filteredItems[selectedIndex]);
					}
					break;
			}
		};

		const handleKeyDown = (event: KeyboardEvent) => {
			if (
				event.key === "ArrowDown" ||
				event.key === "ArrowUp" ||
				event.key === "Enter"
			) {
				event.preventDefault();
				navigate(event.key);
			}
		};

		const handleMessage = (event: MessageEvent) => {
			if (event.data?.nonce !== nonce) {
				return;
			}
			if (event.data.type === "KEYBOARD_NAV") {
				navigate(event.data.key);
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		window.addEventListener("message", handleMessage);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
			window.removeEventListener("message", handleMessage);
		};
	}, [filteredItems, selectedIndex, handleSelect, nonce]);

	// Communicate content height to parent iframe
	useEffect(() => {
		const sendHeight = () => {
			const height = document.documentElement.scrollHeight;
			window.parent.postMessage({ type: "RESIZE_IFRAME", height, nonce }, "*");
		};

		const observer = new ResizeObserver(sendHeight);
		observer.observe(document.body);

		return () => observer.disconnect();
	}, [nonce]);

	if (needsUnlock) {
		return (
			<Card className="mt-1 p-2.5">
				<div className="flex items-center gap-2 text-sm">
					<IconLockOutlineDuo18 size={14} className="text-primary" />
					<span className="font-medium">Unlock Required</span>
				</div>
				<p className="mt-1.5 text-muted-foreground text-xs">
					{config.unlockText}
				</p>
			</Card>
		);
	}

	if (allItems.length === 0) {
		return (
			<Card className="mt-1 p-2.5">
				<div className="flex items-center gap-2 text-muted-foreground text-sm">
					{config.emptyIcon}
					<span>{config.emptyText}</span>
				</div>
			</Card>
		);
	}

	if (filteredItems.length === 0 && filterQuery) {
		return (
			<Card className="mt-1 p-2.5">
				<div className="flex flex-col gap-1 text-sm">
					<span className="font-medium">No matches for "{filterQuery}"</span>
					<p className="text-muted-foreground text-xs">
						{allItems.length}{" "}
						{allItems.length === 1
							? config.itemNounSingular
							: config.itemNounPlural}{" "}
						available
					</p>
				</div>
			</Card>
		);
	}

	return (
		<Card className="mt-1 flex max-h-[220px] flex-col gap-0 overflow-hidden p-0.5">
			{filterQuery && filteredItems.length < allItems.length && (
				<div className="shrink-0 px-2.5 py-1.5 text-muted-foreground text-xs">
					Showing {filteredItems.length} of {allItems.length}{" "}
					{allItems.length === 1 ? "match" : "matches"}
				</div>
			)}
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="space-y-0.5">
					{filteredItems.map((item, index) => (
						<button
							key={item.id}
							type="button"
							ref={
								index === selectedIndex
									? (el) => el?.scrollIntoView({ block: "nearest" })
									: undefined
							}
							className={cn(
								"w-full",
								"rounded-md",
								"px-2.5",
								"py-2",
								"text-left",
								"transition-colors",
								index === selectedIndex
									? "bg-accent text-accent-foreground"
									: "hover:bg-accent/50",
							)}
							onClick={() => handleSelect(item)}
							onMouseEnter={() => setSelectedIndex(index)}
						>
							{config.renderItem(item)}
						</button>
					))}
				</div>
			</div>

			<div className="shrink-0 border-t px-2.5 py-1.5">
				<p className="text-center text-[10px] text-muted-foreground">
					Type to filter • ↑↓ navigate • Enter select • Esc close
				</p>
			</div>
		</Card>
	);
}
