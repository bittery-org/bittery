import "./index.css";
import type { DecryptedItem } from "@bittery/shared/types";
import { IconUser } from "@bittery/ui/icons";
import type { AutofillIframeConfig } from "@/components/autofill-iframe-base";
import { AutofillIframeBase } from "@/components/autofill-iframe-base";
import { mountOverlayApp } from "@/components/overlay/mount";
import { filterIdentityItems } from "@/lib/item-filter";
import { useI18n } from "@/providers/i18n-provider";

const formatName = (item: DecryptedItem) => {
	const parts = [item.firstName, item.middleName, item.lastName].filter(
		Boolean,
	);
	return parts.length > 0 ? parts.join(" ") : item.title;
};

const formatAddressPreview = (item: DecryptedItem) => {
	const address = item.addresses?.[0];
	if (!address) return null;
	const parts = [address.city, address.state].filter(Boolean);
	return parts.length > 0 ? parts.join(", ") : null;
};

function IdentityAutofillIframe() {
	const { m } = useI18n();

	const config: AutofillIframeConfig = {
		itemsMessageType: "IDENTITY_ITEMS",
		filterMessageType: "FILTER_IDENTITIES",
		readyMessageType: "IDENTITY_IFRAME_READY",
		selectMessageType: "IDENTITY_SELECT",
		filterFn: filterIdentityItems,
		preprocessItems: (items: DecryptedItem[]) =>
			items.filter((item) => item.category === "identity"),
		defaultFieldType: "firstName",
		emptyIcon: <IconUser className="size-3.5" />,
		emptyText: m.ext_autofill_identity_empty(),
		unlockText: m.ext_autofill_identity_unlock(),
		itemNounSingular: m.ext_autofill_identity_singular(),
		itemNounPlural: m.ext_autofill_identity_plural(),
		renderLeading: () => (
			<span className="flex size-[26px] shrink-0 items-center justify-center rounded-[7px] border bg-foreground/3 text-muted-foreground">
				<IconUser className="size-3.5" />
			</span>
		),
		renderTitle: (item) => formatName(item),
		renderSubtitle: (item) =>
			[item.email, formatAddressPreview(item)].filter(Boolean).join(" · ") ||
			null,
	};

	return <AutofillIframeBase config={config} />;
}

mountOverlayApp(<IdentityAutofillIframe />);
