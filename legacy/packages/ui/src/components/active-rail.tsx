import type { RefObject } from "react";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { cn } from "../lib/utils";

const TARGET_ATTRIBUTE = "data-active-rail";

type ActiveRailTargetProps = { "data-active-rail"?: "" };

/**
 * Marks the row an `ActiveRail` should sit against. Spread it on every row of
 * the list; only the active one carries the attribute, so the rail's lookup can
 * never match two rows.
 */
export function activeRailTarget(isActive: boolean): ActiveRailTargetProps {
	return isActive ? { [TARGET_ATTRIBUTE]: "" } : {};
}

interface ActiveRailProps {
	/**
	 * The element the rows live in. Must be `position: relative`, and is usually
	 * the list's scroll container — the rail positions itself inside it, so it
	 * scrolls with the rows and is clipped by them without extra work.
	 */
	containerRef: RefObject<HTMLElement | null>;
	/** Nudges the rail's resting position, e.g. `left-2` to sit on the row edge. */
	className?: string;
}

/**
 * The one indicator bar for a nav or item list. Instead of every active row
 * drawing its own bar, the list holds a single rail that measures the active row
 * and slides to it, so moving between rows reads as one continuous object.
 *
 * The rail is decorative: the active row still carries its own state (aria-current,
 * font weight), so nothing here is load-bearing for assistive tech.
 */
export function ActiveRail({ containerRef, className }: ActiveRailProps) {
	const [box, setBox] = useState<{ top: number; height: number } | null>(null);
	const wasVisible = useRef(false);

	// Returning the previous box unchanged is what stops measure → render →
	// measure from looping, since this runs after every commit.
	const measure = useCallback(() => {
		const container = containerRef.current;
		const target = container?.querySelector<HTMLElement>(
			`[${TARGET_ATTRIBUTE}]`,
		);
		if (!container || !target) {
			setBox(null);
			return;
		}
		const containerBox = container.getBoundingClientRect();
		const targetBox = target.getBoundingClientRect();
		const top = targetBox.top - containerBox.top + container.scrollTop;
		setBox((previous) =>
			previous?.top === top && previous.height === targetBox.height
				? previous
				: { top, height: targetBox.height },
		);
	}, [containerRef]);

	// The active row usually changes in the same render that re-renders the rail.
	useLayoutEffect(measure);

	useLayoutEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		let frame = 0;
		const schedule = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(measure);
		};

		// Rows can move without React re-rendering this component — a collapsing
		// section, a list settling after a filter. A subtree observer is the only
		// thing that catches all of them; the attribute filter keeps it cheap and
		// leaves out `style`, so the rail cannot observe its own move.
		const observer = new MutationObserver(schedule);
		observer.observe(container, {
			subtree: true,
			childList: true,
			attributeFilter: [TARGET_ATTRIBUTE, "class", "data-state"],
		});
		window.addEventListener("resize", schedule);

		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
			window.removeEventListener("resize", schedule);
		};
	}, [containerRef, measure]);

	// Appearing where nothing was active should not slide in from the top edge.
	const animate = wasVisible.current && box !== null;
	useEffect(() => {
		wasVisible.current = box !== null;
	}, [box]);

	if (!box) return null;

	return (
		<span
			aria-hidden
			className={cn(
				"pointer-events-none absolute top-0 left-0 z-20 w-0.5 rounded-full bg-primary",
				animate &&
					"transition-[transform,height] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
				className,
			)}
			style={{
				height: `${box.height}px`,
				transform: `translateY(${box.top}px)`,
			}}
		/>
	);
}
