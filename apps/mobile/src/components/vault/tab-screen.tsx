import type { ReactNode } from "react";
import { AccountSwitcher } from "@/components/account-switcher";
import { AppBar, Screen, ScreenScroll } from "@/components/ui";
import { BottomTabBar, type TabKey } from "./bottom-tab-bar";

interface TabScreenProps {
	title: ReactNode;
	subtitle?: ReactNode;
	/** App-bar trailing actions. The account avatar is added automatically as the last one. */
	actions?: ReactNode;
	/** Sits between the app bar and the scroll region: segmented controls, chips, a search field. */
	toolbar?: ReactNode;
	activeTab: TabKey;
	/** The sanctioned top wash. Items and Browse only — Settings stays neutral. */
	aurora?: boolean;
	/** A FAB or any other overlay pinned to the screen rather than to the scroller. */
	overlay?: ReactNode;
	children: ReactNode;
}

/**
 * Shell for the three tab-root screens: large title + account avatar over a bounded scroll
 * region, with the tab bar pinned below.
 *
 * The account avatar lives here rather than on each screen so the switcher is reachable
 * from every tab, which is how it works on `apps/mobile` — before this the Tauri app had no
 * switcher at all and the header carried a bare email string and a loose Lock button.
 */
export function TabScreen({
	title,
	subtitle,
	actions,
	toolbar,
	activeTab,
	aurora = false,
	overlay,
	children,
}: TabScreenProps) {
	return (
		<Screen aurora={aurora}>
			<AppBar
				largeTitle={title}
				subtitle={subtitle}
				bordered={false}
				actions={
					<>
						{actions}
						<AccountSwitcher />
					</>
				}
			/>
			{toolbar ? (
				<div className="relative z-10 shrink-0 px-4 pb-3">{toolbar}</div>
			) : null}

			<ScreenScroll inset="tabBar">{children}</ScreenScroll>

			{overlay}
			<BottomTabBar active={activeTab} />
		</Screen>
	);
}
