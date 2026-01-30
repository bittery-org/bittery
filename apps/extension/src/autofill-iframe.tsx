import "./index.css";
import type { DecryptedItem } from "@bittery/shared/types";
import { Card } from "@bittery/ui";
import { Lock } from "lucide-react";
import React, { useCallback, useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { Favicon } from "@/components/favicon";
import { filterLoginItems } from "@/lib/item-filter";

function AutofillIframe() {
	const [allItems, setAllItems] = useState<DecryptedItem[]>([]);
	const [filteredItems, setFilteredItems] = useState<DecryptedItem[]>([]);
	const [filterQuery, setFilterQuery] = useState("");
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [_fieldType, setFieldType] = useState<
		"username" | "email" | "password"
	>("username");
	const [needsUnlock, setNeedsUnlock] = useState(false);

	useEffect(() => {
		// Listen for items from parent
		const handleMessage = (event: MessageEvent) => {
			if (event.data.type === "AUTOFILL_ITEMS") {
				const items = event.data.items || [];
				setAllItems(items);
				setFilteredItems(items);
				setFilterQuery("");
				setFieldType(event.data.fieldType || "username");
				setSelectedIndex(0);
				setNeedsUnlock(false);
			} else if (event.data.type === "NEEDS_UNLOCK") {
				setNeedsUnlock(true);
				setAllItems([]);
				setFilteredItems([]);
				setFilterQuery("");
			} else if (event.data.type === "FILTER_ITEMS") {
				const query = event.data.query || "";
				setFilterQuery(query);
				const filtered = filterLoginItems(allItems, query);
				setFilteredItems(filtered);
				setSelectedIndex(0);
			}
		};

		window.addEventListener("message", handleMessage);

		window.parent.postMessage({ type: "IFRAME_READY" }, "*");

		return () => window.removeEventListener("message", handleMessage);
	}, [allItems]);

	const handleSelect = useCallback((item: DecryptedItem) => {
		// Send selection to parent
		window.parent.postMessage(
			{
				type: "AUTOFILL_SELECT",
				item,
			},
			"*",
		);
	}, []);

	useEffect(() => {
		// Keyboard navigation
		const handleKeyDown = (event: KeyboardEvent) => {
			if (filteredItems.length === 0) return;

			switch (event.key) {
				case "ArrowDown":
					event.preventDefault();
					setSelectedIndex((prev) => (prev + 1) % filteredItems.length);
					break;
				case "ArrowUp":
					event.preventDefault();
					setSelectedIndex(
						(prev) => (prev - 1 + filteredItems.length) % filteredItems.length,
					);
					break;
				case "Enter":
					event.preventDefault();
					if (filteredItems[selectedIndex]) {
						handleSelect(filteredItems[selectedIndex]);
					}
					break;
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [filteredItems, selectedIndex, handleSelect]);

	if (needsUnlock) {
		return (
			<Card className="mt-1 p-2.5">
				<div className="flex items-center gap-2 text-sm">
					<Lock size={14} className="text-primary" />
					<span className="font-medium">Unlock Required</span>
				</div>
				<p className="mt-1.5 text-muted-foreground text-xs">
					Click the Bittery icon to unlock and use autofill
				</p>
			</Card>
		);
	}

	if (allItems.length === 0) {
		return (
			<Card className="mt-1 p-2.5">
				<div className="flex items-center gap-2 text-muted-foreground text-sm">
					<Lock size={14} />
					<span>No saved logins for this site</span>
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
						{allItems.length} {allItems.length === 1 ? "login" : "logins"}{" "}
						available
					</p>
				</div>
			</Card>
		);
	}

	return (
		<Card className="mt-1 max-h-[280px] overflow-y-auto p-0.5">
			{filterQuery && filteredItems.length < allItems.length && (
				<div className="px-2.5 py-1.5 text-muted-foreground text-xs">
					Showing {filteredItems.length} of {allItems.length}{" "}
					{allItems.length === 1 ? "match" : "matches"}
				</div>
			)}
			<div className="space-y-0.5">
				{filteredItems.map((item, index) => (
					<button
						key={item.id}
						type="button"
						className={`w-full rounded-md px-2.5 py-2 text-left transition-colors ${
							index === selectedIndex
								? "bg-accent text-accent-foreground"
								: "hover:bg-accent/50"
						}`}
						onClick={() => handleSelect(item)}
						onMouseEnter={() => setSelectedIndex(index)}
					>
						<div className="flex items-center gap-2.5">
							<Favicon
								url={item.url}
								title={item.title}
								category={item.category}
								size="sm"
							/>
							<div className="min-w-0 flex-1">
								<p className="truncate font-medium text-sm">{item.title}</p>
								{item.username && (
									<p className="mt-0.5 truncate text-muted-foreground text-xs">
										{item.username}
									</p>
								)}
							</div>
						</div>
					</button>
				))}
			</div>

			<div className="mt-0.5 border-t px-2.5 py-1.5">
				<p className="text-center text-[10px] text-muted-foreground">
					Type to filter • ↑↓ navigate • Enter select • Esc close
				</p>
			</div>
		</Card>
	);
}

const root = document.getElementById("root");
if (root) {
	ReactDOM.createRoot(root).render(
		<React.StrictMode>
			<AutofillIframe />
		</React.StrictMode>,
	);
}
