import "./index.css";
import type { DecryptedItem } from "@bittery/shared/types";
import { IconUserOutlineDuo18 } from "@bittery/ui/icons";
import React from "react";
import ReactDOM from "react-dom/client";
import type { AutofillIframeConfig } from "@/components/autofill-iframe-base";
import { AutofillIframeBase } from "@/components/autofill-iframe-base";
import { filterIdentityItems } from "@/lib/item-filter";
import { I18nProvider, useI18n } from "@/providers/i18n-provider";

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
		emptyIcon: <IconUserOutlineDuo18 size={14} />,
		emptyText: m.ext_autofill_identity_empty(),
		unlockText: m.ext_autofill_identity_unlock(),
		itemNounSingular: m.ext_autofill_identity_singular(),
		itemNounPlural: m.ext_autofill_identity_plural(),
		renderItem: (item) => {
			const displayName = formatName(item);
			const addressPreview = formatAddressPreview(item);

			return (
				<div className="flex items-center gap-2.5">
					<div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary">
						<IconUserOutlineDuo18 size={16} />
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
			);
		},
	};

	return <AutofillIframeBase config={config} />;
}

const root = document.getElementById("root");
if (root) {
	ReactDOM.createRoot(root).render(
		<React.StrictMode>
			<I18nProvider>
				<IdentityAutofillIframe />
			</I18nProvider>
		</React.StrictMode>,
	);
}
