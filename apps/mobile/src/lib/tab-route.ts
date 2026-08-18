/**
 * Which vault paths are the three tab roots, and which view-transition type a
 * navigation between two locations should request.
 *
 * The tab bar lives on the `/vault` layout and stays mounted while this
 * function returns a key. Pushed screens (`MobileScreen`) have no bar.
 */

export type TabKey = "items" | "browse" | "settings";

export type RouteTransitionType = "tab" | "push" | "pop" | "fade";

export interface TransitionLocation {
	pathname: string;
	state?: { __TSR_index?: number };
}

export interface TransitionEnv {
	/** Skip the snapshot entirely — `prefers-reduced-motion`. */
	reducedMotion?: boolean;
	/**
	 * Full-screen slides are two document snapshots. On a 2 GB WebView that
	 * drops frames, so push/pop become the same cross-fade the untyped
	 * fallback already uses. Tab fades stay — they only paint the pane.
	 */
	lowEnd?: boolean;
}

function normalizePath(pathname: string): string {
	if (pathname.length > 1 && pathname.endsWith("/")) {
		return pathname.slice(0, -1);
	}
	return pathname;
}

export function tabKeyForPath(pathname: string): TabKey | null {
	const path = normalizePath(pathname);
	if (path === "/vault/all-items") return "items";
	if (path === "/vault/settings") return "settings";
	if (path === "/vault") return "browse";
	return null;
}

function isVaultPath(pathname: string): boolean {
	const path = normalizePath(pathname);
	return path === "/vault" || path.startsWith("/vault/");
}

function historyIndex(location: TransitionLocation): number | undefined {
	const index = location.state?.__TSR_index;
	return typeof index === "number" ? index : undefined;
}

function detectReducedMotion(): boolean {
	return (
		typeof window !== "undefined" &&
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
	);
}

function detectLowEnd(): boolean {
	if (typeof navigator === "undefined") return false;
	const memory = (navigator as Navigator & { deviceMemory?: number })
		.deviceMemory;
	return typeof memory === "number" && memory <= 2;
}

/**
 * Types handed to `document.startViewTransition({ types })`. Returning `false`
 * skips the View Transition so the router commits the new location with a cut.
 *
 * TanStack already drops types (and falls back to an untyped cross-fade) when
 * the WebView cannot match `:active-view-transition-type()`. A WebView without
 * the API at all never calls this — the router just commits.
 */
export function routeTransitionTypes(
	info: {
		fromLocation?: TransitionLocation;
		toLocation: TransitionLocation;
	},
	env: TransitionEnv = {},
): RouteTransitionType[] | false {
	const reducedMotion = env.reducedMotion ?? detectReducedMotion();
	if (reducedMotion) return false;

	const from = info.fromLocation;
	if (!from) return false;

	const lowEnd = env.lowEnd ?? detectLowEnd();
	const fromTab = tabKeyForPath(from.pathname);
	const toTab = tabKeyForPath(info.toLocation.pathname);

	if (fromTab && toTab) {
		return fromTab === toTab ? false : ["tab"];
	}

	const fromVault = isVaultPath(from.pathname);
	const toVault = isVaultPath(info.toLocation.pathname);
	const fromIndex = historyIndex(from);
	const toIndex = historyIndex(info.toLocation);

	if (toTab && fromVault && !fromTab) {
		// Arriving at a tab from a pushed screen: Back is a pop (index
		// drops); tapping a tab is a fade even though navigate() still pushes.
		if (
			typeof fromIndex === "number" &&
			typeof toIndex === "number" &&
			toIndex < fromIndex
		) {
			return lowEnd ? ["fade"] : ["pop"];
		}
		return ["tab"];
	}

	if (fromTab && toVault && !toTab) {
		return lowEnd ? ["fade"] : ["push"];
	}

	if (fromVault && toVault) {
		if (typeof fromIndex === "number" && typeof toIndex === "number") {
			if (toIndex < fromIndex) return lowEnd ? ["fade"] : ["pop"];
			if (toIndex > fromIndex) return lowEnd ? ["fade"] : ["push"];
		}
		return ["fade"];
	}

	return ["fade"];
}
