import "./index.css";
import type { DecryptedItem } from "@bittery/shared/types";
import { Card } from "@bittery/ui";
import { Lock, User } from "lucide-react";
import React, { useCallback, useEffect, useState } from "react";
import ReactDOM from "react-dom/client";

function IdentityAutofillIframe() {
	const [items, setItems] = useState<DecryptedItem[]>([]);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [_fieldType, setFieldType] = useState<string>("firstName");
	const [needsUnlock, setNeedsUnlock] = useState(false);

	useEffect(() => {
		// Listen for items from parent
		const handleMessage = (event: MessageEvent) => {
			if (event.data.type === "IDENTITY_ITEMS") {
				// Filter to only identity items
				const identities = (event.data.items || []).filter(
					(item: DecryptedItem) => item.category === "identity",
				);
				setItems(identities);
				setFieldType(event.data.fieldType || "firstName");
				setSelectedIndex(0);
				setNeedsUnlock(false);
			} else if (event.data.type === "NEEDS_UNLOCK") {
				setNeedsUnlock(true);
				setItems([]);
			}
		};

		window.addEventListener("message", handleMessage);

		// Signal that iframe is ready
		window.parent.postMessage({ type: "IDENTITY_IFRAME_READY" }, "*");

		return () => window.removeEventListener("message", handleMessage);
	}, []);

	const handleSelect = useCallback((item: DecryptedItem) => {
		// Send selection to parent
		window.parent.postMessage(
			{
				type: "IDENTITY_SELECT",
				item,
			},
			"*",
		);
	}, []);

	useEffect(() => {
		// Keyboard navigation
		const handleKeyDown = (event: KeyboardEvent) => {
			if (items.length === 0) return;

			switch (event.key) {
				case "ArrowDown":
					event.preventDefault();
					setSelectedIndex((prev) => (prev + 1) % items.length);
					break;
				case "ArrowUp":
					event.preventDefault();
					setSelectedIndex((prev) => (prev - 1 + items.length) % items.length);
					break;
				case "Enter":
					event.preventDefault();
					if (items[selectedIndex]) {
						handleSelect(items[selectedIndex]);
					}
					break;
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [items, selectedIndex, handleSelect]);

	// Format name display
	const formatName = (item: DecryptedItem) => {
		const parts = [item.firstName, item.middleName, item.lastName].filter(
			Boolean,
		);
		return parts.length > 0 ? parts.join(" ") : item.title;
	};

	// Format address preview
	const formatAddressPreview = (item: DecryptedItem) => {
		const address = item.addresses?.[0];
		if (!address) return null;
		const parts = [address.city, address.state].filter(Boolean);
		return parts.length > 0 ? parts.join(", ") : null;
	};

	if (needsUnlock) {
		return (
			<Card className="mt-1 p-2.5">
				<div className="flex items-center gap-2 text-sm">
					<Lock size={14} className="text-primary" />
					<span className="font-medium">Unlock Required</span>
				</div>
				<p className="mt-1.5 text-muted-foreground text-xs">
					Click the Bittery icon to unlock and use identity autofill
				</p>
			</Card>
		);
	}

	if (items.length === 0) {
		return (
			<Card className="mt-1 p-2.5">
				<div className="flex items-center gap-2 text-muted-foreground text-sm">
					<User size={14} />
					<span>No saved identities</span>
				</div>
			</Card>
		);
	}

	return (
		<Card className="mt-1 max-h-[280px] overflow-y-auto p-0.5">
			<div className="space-y-0.5">
				{items.map((item, index) => {
					const displayName = formatName(item);
					const addressPreview = formatAddressPreview(item);

					return (
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
								<div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary">
									<User size={16} />
								</div>
								<div className="min-w-0 flex-1">
									<p className="truncate font-medium text-sm">{displayName}</p>
									{item.email && (
										<p className="mt-0.5 truncate text-muted-foreground text-xs">
											{item.email}
										</p>
									)}
									{addressPreview && (
										<p className="truncate text-muted-foreground text-xs">
											{addressPreview}
										</p>
									)}
								</div>
							</div>
						</button>
					);
				})}
			</div>

			<div className="mt-0.5 border-t px-2.5 py-1.5">
				<p className="text-center text-[10px] text-muted-foreground">
					↑↓ to navigate • Enter to select • Esc to close
				</p>
			</div>
		</Card>
	);
}

const root = document.getElementById("root");
if (root) {
	ReactDOM.createRoot(root).render(
		<React.StrictMode>
			<IdentityAutofillIframe />
		</React.StrictMode>,
	);
}
