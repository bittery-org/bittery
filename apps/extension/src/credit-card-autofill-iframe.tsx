import "./index.css";
import type { DecryptedItem } from "@bittery/shared/types";
import { maskCardNumber, detectCardBrand } from "@bittery/shared/credit-card";
import { Card } from "@bittery/ui";
import { CreditCard, Lock } from "lucide-react";
import React, { useCallback, useEffect, useState } from "react";
import ReactDOM from "react-dom/client";

// Card brand icons (simple SVG representations)
const CardBrandIcon = ({ brand }: { brand: string }) => {
	const getBrandColor = () => {
		switch (brand) {
			case "visa":
				return "#1A1F71";
			case "mastercard":
				return "#EB001B";
			case "amex":
				return "#006FCF";
			case "discover":
				return "#FF6600";
			default:
				return "#6B7280";
		}
	};

	return (
		<div
			className="flex h-8 w-10 items-center justify-center rounded border bg-white"
			style={{ borderColor: getBrandColor() }}
		>
			<span
				className="font-bold text-[8px] uppercase"
				style={{ color: getBrandColor() }}
			>
				{brand === "unknown" ? "Card" : brand.substring(0, 4)}
			</span>
		</div>
	);
};

function CreditCardAutofillIframe() {
	const [items, setItems] = useState<DecryptedItem[]>([]);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [_fieldType, setFieldType] = useState<string>("cardNumber");
	const [needsUnlock, setNeedsUnlock] = useState(false);

	useEffect(() => {
		// Listen for items from parent
		const handleMessage = (event: MessageEvent) => {
			if (event.data.type === "CREDIT_CARD_ITEMS") {
				// Filter to only credit card items
				const creditCards = (event.data.items || []).filter(
					(item: DecryptedItem) => item.category === "credit-card" && item.cardNumber
				);
				setItems(creditCards);
				setFieldType(event.data.fieldType || "cardNumber");
				setSelectedIndex(0);
				setNeedsUnlock(false);
			} else if (event.data.type === "NEEDS_UNLOCK") {
				setNeedsUnlock(true);
				setItems([]);
			}
		};

		window.addEventListener("message", handleMessage);

		// Signal that iframe is ready
		window.parent.postMessage({ type: "CC_IFRAME_READY" }, "*");

		return () => window.removeEventListener("message", handleMessage);
	}, []);

	const handleSelect = useCallback((item: DecryptedItem) => {
		// Send selection to parent
		window.parent.postMessage(
			{
				type: "CREDIT_CARD_SELECT",
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

	if (needsUnlock) {
		return (
			<Card className="mt-1 p-2.5">
				<div className="flex items-center gap-2 text-sm">
					<Lock size={14} className="text-primary" />
					<span className="font-medium">Unlock Required</span>
				</div>
				<p className="mt-1.5 text-muted-foreground text-xs">
					Click the Bittery icon to unlock and use credit card autofill
				</p>
			</Card>
		);
	}

	if (items.length === 0) {
		return (
			<Card className="mt-1 p-2.5">
				<div className="flex items-center gap-2 text-muted-foreground text-sm">
					<CreditCard size={14} />
					<span>No saved credit cards</span>
				</div>
			</Card>
		);
	}

	return (
		<Card className="mt-1 max-h-[280px] overflow-y-auto p-0.5">
			<div className="space-y-0.5">
				{items.map((item, index) => {
					const brand = item.cardNumber ? detectCardBrand(item.cardNumber) : "unknown";
					const maskedNumber = item.cardNumber ? maskCardNumber(item.cardNumber) : "••••";

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
								<CardBrandIcon brand={brand} />
								<div className="min-w-0 flex-1">
									<p className="truncate font-medium text-sm">{item.title}</p>
									<div className="mt-0.5 flex items-center gap-2">
										<span className="font-mono text-muted-foreground text-xs">
											{maskedNumber}
										</span>
										{item.expiryDate && (
											<span className="text-muted-foreground text-xs">
												Exp: {item.expiryDate}
											</span>
										)}
									</div>
									{item.cardholderName && (
										<p className="mt-0.5 truncate text-muted-foreground text-xs">
											{item.cardholderName}
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
			<CreditCardAutofillIframe />
		</React.StrictMode>,
	);
}
