import "./index.css";
import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { Lock } from "lucide-react";
import { Card } from "@bittery/ui";
import { Favicon } from "@/components/favicon";

interface AutofillItem {
	id: string;
	name: string;
	title: string;
	username?: string;
	password?: string;
	websiteUrl?: string;
}

function AutofillIframe() {
	const [items, setItems] = useState<AutofillItem[]>([]);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [fieldType, setFieldType] = useState<"username" | "email" | "password">("username");
	const [needsUnlock, setNeedsUnlock] = useState(false);

	useEffect(() => {
		// Listen for items from parent
		const handleMessage = (event: MessageEvent) => {
			if (event.data.type === "AUTOFILL_ITEMS") {
				setItems(event.data.items || []);
				setFieldType(event.data.fieldType || "username");
				setSelectedIndex(0);
				setNeedsUnlock(false);
			} else if (event.data.type === "NEEDS_UNLOCK") {
				setNeedsUnlock(true);
				setItems([]);
			}
		};

		window.addEventListener("message", handleMessage);
		
		window.parent.postMessage({ type: "IFRAME_READY" }, "*");
		
		return () => window.removeEventListener("message", handleMessage);
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
					handleSelect(items[selectedIndex]);
					break;
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [items, selectedIndex]);

	const handleSelect = (item: AutofillItem) => {
		// Send selection to parent
		window.parent.postMessage(
			{
				type: "AUTOFILL_SELECT",
				item,
			},
			"*",
		);
	};

	if (needsUnlock) {
		return (
			<Card className="mt-1 p-2.5">
				<div className="flex items-center gap-2 text-sm">
					<Lock size={14} className="text-primary" />
					<span className="font-medium">Unlock Required</span>
				</div>
				<p className="text-muted-foreground text-xs mt-1.5">
					Click the Bittery icon to unlock and use autofill
				</p>
			</Card>
		);
	}

	if (items.length === 0) {
		return (
			<Card className="mt-1 p-2.5">
				<div className="flex items-center gap-2 text-muted-foreground text-sm">
					<Lock size={14} />
					<span>No saved logins for this site</span>
				</div>
			</Card>
		);
	}

	return (
		<Card className="mt-1 max-h-[280px] overflow-y-auto p-0.5">
			<div className="space-y-0.5">
				{items.map((item, index) => (
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
								url={item.websiteUrl}
								title={item.title || item.name}
								category="login"
								size="sm"
							/>
							<div className="flex-1 min-w-0">
								<p className="truncate font-medium text-sm">{item.title || item.name}</p>
								{item.username && (
									<p className="truncate text-muted-foreground text-xs mt-0.5">
										{item.username}
									</p>
								)}
							</div>
						</div>
					</button>
				))}
			</div>

			<div className="mt-0.5 border-t px-2.5 py-1.5">
				<p className="text-center text-muted-foreground text-[10px]">
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
			<AutofillIframe />
		</React.StrictMode>
	);
}
