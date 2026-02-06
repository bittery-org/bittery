import type { DecryptedItem } from "@bittery/shared/types";
import { Card } from "@bittery/ui";
import { Lock } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

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
	filterFn: (items: DecryptedItem[], query: string) => DecryptedItem[];
	/** Optional preprocessing of items before storing (e.g. filter to category) */
	preprocessItems?: (items: DecryptedItem[]) => DecryptedItem[];
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
	renderItem: (item: DecryptedItem) => ReactNode;
}

export function AutofillIframeBase({
	config,
}: {
	config: AutofillIframeConfig;
}) {
	const [allItems, setAllItems] = useState<DecryptedItem[]>([]);
	const [filteredItems, setFilteredItems] = useState<DecryptedItem[]>([]);
	const [filterQuery, setFilterQuery] = useState("");
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [_fieldType, setFieldType] = useState<string>(config.defaultFieldType);
	const [needsUnlock, setNeedsUnlock] = useState(false);
	const allItemsRef = useRef<DecryptedItem[]>([]);

	// Listen for items from parent — uses allItemsRef to avoid infinite loop
	// (do NOT put allItems in the dependency array)
	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
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
		window.parent.postMessage({ type: config.readyMessageType }, "*");

		return () => window.removeEventListener("message", handleMessage);
	}, []);

	const handleSelect = useCallback((item: DecryptedItem) => {
		window.parent.postMessage({ type: config.selectMessageType, item }, "*");
	}, []);

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
	}, [filteredItems, selectedIndex, handleSelect]);

	// Communicate content height to parent iframe
	useEffect(() => {
		const sendHeight = () => {
			const height = document.documentElement.scrollHeight;
			window.parent.postMessage({ type: "RESIZE_IFRAME", height }, "*");
		};

		const observer = new ResizeObserver(sendHeight);
		observer.observe(document.body);

		return () => observer.disconnect();
	}, []);

	if (needsUnlock) {
		return (
			<Card className="mt-1 p-2.5">
				<div className="flex items-center gap-2 text-sm">
					<Lock size={14} className="text-primary" />
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
							className={`w-full rounded-md px-2.5 py-2 text-left transition-colors ${
								index === selectedIndex
									? "bg-accent text-accent-foreground"
									: "hover:bg-accent/50"
							}`}
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
