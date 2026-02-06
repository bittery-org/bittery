import "./index.css";
import { Lock } from "lucide-react";
import React from "react";
import ReactDOM from "react-dom/client";
import type { AutofillIframeConfig } from "@/components/autofill-iframe-base";
import { AutofillIframeBase } from "@/components/autofill-iframe-base";
import { Favicon } from "@/components/favicon";
import { filterLoginItems } from "@/lib/item-filter";

const config: AutofillIframeConfig = {
	itemsMessageType: "AUTOFILL_ITEMS",
	filterMessageType: "FILTER_ITEMS",
	readyMessageType: "IFRAME_READY",
	selectMessageType: "AUTOFILL_SELECT",
	filterFn: filterLoginItems,
	defaultFieldType: "username",
	emptyIcon: <Lock size={14} />,
	emptyText: "No saved logins for this site",
	unlockText: "Click the Bittery icon to unlock and use autofill",
	itemNounSingular: "login",
	itemNounPlural: "logins",
	renderItem: (item) => (
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
	),
};

const root = document.getElementById("root");
if (root) {
	ReactDOM.createRoot(root).render(
		<React.StrictMode>
			<AutofillIframeBase config={config} />
		</React.StrictMode>,
	);
}
