/**
 * Shared bootstrap for the in-page overlay documents.
 *
 * Every overlay frame needs exactly three things before it can paint: the theme
 * on `<html>`, the i18n provider, and a React root. Doing it here keeps the
 * entry files down to the component that is actually specific to each surface.
 *
 * Note the deliberate absence of `StrictMode`. These frames talk to the content
 * script over a `postMessage` handshake and are now pooled and reused, so the
 * double-invoked effects StrictMode adds in dev would fire the ready/select
 * protocol twice and make dev behave unlike production.
 */

import type { ReactNode } from "react";
import ReactDOM from "react-dom/client";
import { getOrCreateRoot } from "@/lib/react-root";
import { startOverlayTheme } from "@/lib/theme";
import { I18nProvider } from "@/providers/i18n-provider";

export function mountOverlayApp(children: ReactNode): void {
	// Before the first paint, so the card never flashes the wrong theme.
	startOverlayTheme();

	const root = document.getElementById("root");
	if (!root) return;

	getOrCreateRoot(root, (container) => ReactDOM.createRoot(container)).render(
		<I18nProvider>{children}</I18nProvider>,
	);
}
