import "./index.css";
import { IconLock } from "@bittery/ui/icons";
import React from "react";
import ReactDOM from "react-dom/client";
import type { AutofillIframeConfig } from "@/components/autofill-iframe-base";
import { AutofillIframeBase } from "@/components/autofill-iframe-base";
import { Favicon } from "@/components/favicon";
import { filterLoginItems } from "@/lib/item-filter";
import { I18nProvider, useI18n } from "@/providers/i18n-provider";

function AutofillIframe() {
	const { m } = useI18n();

	const config: AutofillIframeConfig = {
		itemsMessageType: "AUTOFILL_ITEMS",
		filterMessageType: "FILTER_ITEMS",
		readyMessageType: "IFRAME_READY",
		selectMessageType: "AUTOFILL_SELECT",
		filterFn: filterLoginItems,
		defaultFieldType: "username",
		emptyIcon: <IconLock size={14} />,
		emptyText: m.ext_autofill_login_empty(),
		unlockText: m.ext_autofill_login_unlock(),
		itemNounSingular: m.ext_autofill_login_singular(),
		itemNounPlural: m.ext_autofill_login_plural(),
		renderItem: (item) => {
			return (
				<div className="flex items-center gap-2.5">
					<Favicon item={item} size="sm" />
					<div className="min-w-0 flex-1">
						<p className="truncate font-medium text-sm">{item.title}</p>
						{item.username && (
							<p className="mt-0.5 truncate text-muted-foreground text-xs">
								{item.username}
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
				<AutofillIframe />
			</I18nProvider>
		</React.StrictMode>,
	);
}
