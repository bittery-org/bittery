import "./index.css";
import { detectCardBrand, maskCardNumber } from "@bittery/shared/credit-card";
import type { DecryptedItem } from "@bittery/shared/types";
import { IconCreditCard } from "@bittery/ui/icons";
import type { AutofillIframeConfig } from "@/components/autofill-iframe-base";
import { AutofillIframeBase } from "@/components/autofill-iframe-base";
import { mountOverlayApp } from "@/components/overlay/mount";
import { OverlayChip } from "@/components/overlay/overlay-surface";
import { filterCreditCardItems } from "@/lib/item-filter";
import { useI18n } from "@/providers/i18n-provider";

/**
 * Neutral card tile. Payment-network brand colours have no token in the design
 * system and would put five more saturated fills into a surface that is meant to
 * stay neutral, so the brand is carried by the chip in the subtitle instead.
 */
function CardTile() {
	return (
		<span className="flex size-[26px] shrink-0 items-center justify-center rounded-[7px] border bg-foreground/3 text-muted-foreground">
			<IconCreditCard className="size-3.5" />
		</span>
	);
}

function CreditCardAutofillIframe() {
	const { m } = useI18n();

	const config: AutofillIframeConfig = {
		itemsMessageType: "CREDIT_CARD_ITEMS",
		filterMessageType: "FILTER_CREDIT_CARDS",
		readyMessageType: "CC_IFRAME_READY",
		selectMessageType: "CREDIT_CARD_SELECT",
		filterFn: filterCreditCardItems,
		preprocessItems: (items: DecryptedItem[]) =>
			items.filter(
				(item) => item.category === "credit-card" && item.cardNumber,
			),
		defaultFieldType: "cardNumber",
		emptyIcon: <IconCreditCard className="size-3.5" />,
		emptyText: m.ext_autofill_card_empty(),
		unlockText: m.ext_autofill_card_unlock(),
		itemNounSingular: m.ext_autofill_card_singular(),
		itemNounPlural: m.ext_autofill_card_plural(),
		renderLeading: () => <CardTile />,
		renderTitle: (item) => item.title,
		renderSubtitle: (item) => (
			<span className="inline-flex items-center gap-1.5">
				<span className="font-mono">
					{item.cardNumber ? maskCardNumber(item.cardNumber) : "••••"}
				</span>
				{item.expiryDate && (
					<span>{m.ext_autofill_card_expiry({ date: item.expiryDate })}</span>
				)}
			</span>
		),
		renderTrailing: (item) => {
			const brand = item.cardNumber
				? detectCardBrand(item.cardNumber)
				: "unknown";
			return (
				<OverlayChip className="uppercase">
					{brand === "unknown" ? m.ext_autofill_card_brand_unknown() : brand}
				</OverlayChip>
			);
		},
	};

	return <AutofillIframeBase config={config} />;
}

mountOverlayApp(<CreditCardAutofillIframe />);
