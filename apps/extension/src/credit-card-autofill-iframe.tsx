import "./index.css";
import { detectCardBrand, maskCardNumber } from "@bittery/shared/credit-card";
import type { DecryptedItem } from "@bittery/shared/types";
import { CreditCard } from "lucide-react";
import React from "react";
import ReactDOM from "react-dom/client";
import type { AutofillIframeConfig } from "@/components/autofill-iframe-base";
import { AutofillIframeBase } from "@/components/autofill-iframe-base";
import { filterCreditCardItems } from "@/lib/item-filter";

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

const config: AutofillIframeConfig = {
	itemsMessageType: "CREDIT_CARD_ITEMS",
	filterMessageType: "FILTER_CREDIT_CARDS",
	readyMessageType: "CC_IFRAME_READY",
	selectMessageType: "CREDIT_CARD_SELECT",
	filterFn: filterCreditCardItems,
	preprocessItems: (items: DecryptedItem[]) =>
		items.filter((item) => item.category === "credit-card" && item.cardNumber),
	defaultFieldType: "cardNumber",
	emptyIcon: <CreditCard size={14} />,
	emptyText: "No saved credit cards",
	unlockText: "Click the Bittery icon to unlock and use credit card autofill",
	itemNounSingular: "card",
	itemNounPlural: "cards",
	renderItem: (item) => {
		const brand = item.cardNumber
			? detectCardBrand(item.cardNumber)
			: "unknown";
		const maskedNumber = item.cardNumber
			? maskCardNumber(item.cardNumber)
			: "••••";

		return (
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
		);
	},
};

const root = document.getElementById("root");
if (root) {
	ReactDOM.createRoot(root).render(
		<React.StrictMode>
			<AutofillIframeBase config={config} />
		</React.StrictMode>,
	);
}
