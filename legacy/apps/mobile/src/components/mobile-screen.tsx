import type { ReactNode } from "react";
import { AppBar, Screen, ScreenScroll } from "@/components/ui";

interface MobileScreenProps {
	title: ReactNode;
	subtitle?: ReactNode;
	backLabel: string;
	onBack: () => void;
	headerEnd?: ReactNode;
	/** Sits between the app bar and the scroll region: a search field, a segmented control. */
	toolbar?: ReactNode;
	/** A FAB or any other overlay pinned to the screen rather than to the scroller. */
	overlay?: ReactNode;
	/** Turns the scroll region off for screens that manage their own layout (detail headers). */
	scroll?: boolean;
	children: ReactNode;
}

/**
 * Shell for every pushed screen: a translucent app bar with a back affordance over an
 * independently scrolling content region. No tab bar — a pushed screen is a stack, and a
 * tab bar under a back button is the classic "web app in a shell" tell.
 */
export function MobileScreen({
	title,
	subtitle,
	backLabel,
	onBack,
	headerEnd,
	toolbar,
	overlay,
	scroll = true,
	children,
}: MobileScreenProps) {
	return (
		<Screen>
			<AppBar
				title={title}
				subtitle={subtitle}
				onBack={onBack}
				backLabel={backLabel}
				actions={headerEnd}
			/>
			{toolbar ? (
				<div className="relative z-10 shrink-0 px-4 py-3">{toolbar}</div>
			) : null}

			{scroll ? (
				<ScreenScroll inset="plain">{children}</ScreenScroll>
			) : (
				<div className="relative z-10 flex min-h-0 flex-1 flex-col">
					{children}
				</div>
			)}

			{overlay}
		</Screen>
	);
}
