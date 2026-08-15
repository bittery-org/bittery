import { IconArrowLeft } from "@bittery/ui/icons";
import type { ReactNode } from "react";

interface MobileScreenProps {
	title: ReactNode;
	backLabel: string;
	onBack: () => void;
	headerEnd?: ReactNode;
	children: ReactNode;
}

/**
 * Shared full-screen shell for pushed vault screens: a sticky top bar (back button + title,
 * optional trailing action) over an independently scrolling content region.
 *
 * Height is `100dvh` minus the safe-area insets rather than `h-dvh` — `__root.tsx` already pads
 * its wrapper by `--safe-top` / `--safe-bottom`, so a bare `h-dvh` here would double-count that
 * inset and push the bottom of the screen off-screen. Subtracting the same insets back out makes
 * this element exactly the visible area below the status bar and above the gesture/nav bar,
 * which is what the content scroller needs to be bounded — without that, "scrolling" here would
 * really be the whole page scrolling under the sticky header, defeating both the `sticky` header
 * and the requested `overscroll-behavior: contain`.
 */
export function MobileScreen({
	title,
	backLabel,
	onBack,
	headerEnd,
	children,
}: MobileScreenProps) {
	return (
		<div
			className="flex w-full flex-col overflow-hidden"
			style={{
				height: "calc(100dvh - var(--safe-top) - var(--safe-bottom))",
			}}
		>
			<header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-1 border-b bg-background px-1.5">
				<button
					type="button"
					onClick={onBack}
					aria-label={backLabel}
					className="flex size-11 shrink-0 items-center justify-center rounded-md text-foreground active:bg-foreground/5"
				>
					<IconArrowLeft className="size-5" />
				</button>
				<h1 className="min-w-0 flex-1 truncate font-semibold text-base">
					{title}
				</h1>
				{headerEnd}
			</header>

			<div
				className="flex-1 overflow-y-auto"
				style={{ overscrollBehavior: "contain" }}
			>
				{children}
			</div>
		</div>
	);
}
