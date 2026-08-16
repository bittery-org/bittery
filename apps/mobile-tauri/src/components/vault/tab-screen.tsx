import type { ReactNode } from "react";
import { BottomTabBar, type TabKey } from "./bottom-tab-bar";

interface TabScreenProps {
	title: ReactNode;
	headerEnd?: ReactNode;
	activeTab: TabKey;
	children: ReactNode;
}

/**
 * Shared shell for the five tab-root screens (D12). Same sticky-header-over-bounded-scroll shape
 * as `MobileScreen`, minus the back button, plus `BottomTabBar` pinned below the scroll region.
 * Height math mirrors `MobileScreen`'s doc comment: `__root.tsx` already pads by `--safe-top` /
 * `--safe-bottom`, so this element is sized to exactly the visible area and the tab bar and
 * content split it, rather than either one pushing the other off-screen.
 */
export function TabScreen({
	title,
	headerEnd,
	activeTab,
	children,
}: TabScreenProps) {
	return (
		<div
			className="flex w-full flex-col overflow-hidden"
			style={{
				height: "calc(100dvh - var(--safe-top) - var(--safe-bottom))",
			}}
		>
			<header className="sticky top-0 z-10 flex min-h-14 shrink-0 items-center justify-between gap-3 border-b bg-background px-4 py-2">
				<h1 className="min-w-0 truncate font-semibold text-base">{title}</h1>
				{headerEnd}
			</header>

			<div
				className="flex-1 overflow-y-auto"
				style={{ overscrollBehavior: "contain" }}
			>
				{children}
			</div>

			<BottomTabBar active={activeTab} />
		</div>
	);
}
