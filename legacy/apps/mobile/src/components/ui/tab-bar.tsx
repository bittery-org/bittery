/**
 * Flush bottom bar — hairline top border over a blurred canvas, not a floating pill. The
 * active tab is a primary-coloured icon and label; there is no pill, no background swap.
 *
 * `position: fixed` so the bar overlays the scroller (content can pass under the blur)
 * and so tab switches do not change the page's height. `view-transition-name: tab-bar`
 * (`.tab-bar` in styles.css) carves it out of the root snapshot.
 *
 * The blur is texture, not transparency: the bar stays a legible surface at 88% opacity and
 * the content scrolling underneath is only ever suggested.
 */

import { cn } from "@bittery/ui/lib/utils";
import type { ComponentType } from "react";
import { Pressable } from "./pressable";
import { iconClass } from "./theme";

export interface TabDefinition<Key extends string> {
	key: Key;
	label: string;
	icon: ComponentType<{ className?: string }>;
	onSelect: () => void;
}

export function TabBar<Key extends string>({
	tabs,
	active,
	ariaLabel,
}: {
	tabs: ReadonlyArray<TabDefinition<Key>>;
	active: Key;
	ariaLabel: string;
}) {
	return (
		<nav
			aria-label={ariaLabel}
			className="tab-bar fixed right-0 bottom-0 left-0 z-20 border-border/80 border-t bg-background/88 supports-[backdrop-filter]:backdrop-blur-xl"
			style={{
				paddingBottom: "var(--safe-bottom)",
				paddingLeft: "var(--safe-left)",
				paddingRight: "var(--safe-right)",
			}}
		>
			<div className="flex items-stretch">
				{tabs.map((tab) => {
					const isActive = tab.key === active;
					const Icon = tab.icon;
					return (
						<Pressable
							key={tab.key}
							onClick={tab.onSelect}
							aria-current={isActive ? "page" : undefined}
							className={cn(
								"flex flex-1 flex-col items-center justify-center gap-1 rounded-none pt-2 pb-1.5",
								isActive ? "text-primary" : "text-muted-foreground",
							)}
							style={{ minHeight: "var(--tab-bar-height)" }}
						>
							<Icon
								className={cn(
									iconClass.bar,
									"transition-transform duration-150 ease-native",
									isActive && "scale-105",
								)}
							/>
							<span
								className={cn(
									"max-w-full truncate text-2xs",
									isActive ? "font-semibold" : "font-medium",
								)}
							>
								{tab.label}
							</span>
						</Pressable>
					);
				})}
			</div>
		</nav>
	);
}
