import "./index.css";
import { IconLock } from "@bittery/ui/icons";
import type { AutofillIframeConfig } from "@/components/autofill-iframe-base";
import { AutofillIframeBase } from "@/components/autofill-iframe-base";
import { Favicon } from "@/components/favicon";
import { mountOverlayApp } from "@/components/overlay/mount";
import { filterLoginItems } from "@/lib/item-filter";
import { useI18n } from "@/providers/i18n-provider";

function AutofillIframe() {
	const { m } = useI18n();

	const config: AutofillIframeConfig = {
		itemsMessageType: "AUTOFILL_ITEMS",
		filterMessageType: "FILTER_ITEMS",
		readyMessageType: "IFRAME_READY",
		selectMessageType: "AUTOFILL_SELECT",
		filterFn: filterLoginItems,
		defaultFieldType: "username",
		emptyIcon: <IconLock className="size-3.5" />,
		emptyText: m.ext_autofill_login_empty(),
		unlockText: m.ext_autofill_login_unlock(),
		itemNounSingular: m.ext_autofill_login_singular(),
		itemNounPlural: m.ext_autofill_login_plural(),
		renderLeading: (item) => (
			<Favicon item={item} size="sm" className="size-[26px] rounded-[7px]" />
		),
		renderTitle: (item) => item.title,
		renderSubtitle: (item) => item.username,
	};

	return <AutofillIframeBase config={config} />;
}

mountOverlayApp(<AutofillIframe />);
