import type { AppRpcOptionsProxy } from "@bittery/shared/rpc-client";
import { Toaster } from "@bittery/ui";
import type { QueryClient } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import {
	createRootRouteWithContext,
	HeadContent,
	Outlet,
	Scripts,
} from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { ThemeProvider } from "next-themes";
import appCss from "../index.css?url";
import { initializeStorage } from "../lib/storage";
import { useI18n } from "../providers/i18n-provider";

export interface RouterAppContext {
	rpc: AppRpcOptionsProxy;
	queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterAppContext>()({
	// The single choke point for storage readiness. `AccountStore` keys everything by
	// accountId, so the web active account must be seeded before any route guard, loader
	// or component makes an account-scoped call. Root `beforeLoad` runs ahead of all of
	// them, and `initializeStorage` is memoised so repeated navigations are free.
	beforeLoad: () => initializeStorage(),
	head: () => ({
		meta: [
			{
				charSet: "utf-8",
			},
			{
				name: "viewport",
				content: "width=device-width, initial-scale=1",
			},
			{
				title: "Bittery",
			},
			{
				name: "description",
				content:
					"Bittery is a zero-knowledge password manager. Your passwords are encrypted client-side and never leave your device unencrypted.",
			},
			{
				name: "apple-mobile-web-app-title",
				content: "bittery",
			},
		],
		links: [
			{
				rel: "stylesheet",
				href: appCss,
			},
			{
				rel: "icon",
				type: "image/png",
				href: "/favicon-96x96.png",
				sizes: "96x96",
			},
			{
				rel: "icon",
				type: "image/svg+xml",
				href: "/favicon.svg",
			},
			{
				rel: "shortcut icon",
				href: "/favicon.ico",
			},
			{
				rel: "apple-touch-icon",
				sizes: "180x180",
				href: "/apple-touch-icon.png",
			},
			{
				rel: "manifest",
				href: "/site.webmanifest",
			},
		],
	}),
	component: RootDocument,
});

function RootDocument() {
	const { locale } = useI18n();
	// Both devtools launchers are fixed overlays pinned to the bottom corners,
	// where they sit on top of real controls and swallow their clicks; automated
	// runs against the dev server turn them off.
	const isDev =
		import.meta.env.DEV && import.meta.env.VITE_DISABLE_DEVTOOLS !== "true";

	return (
		<html lang={locale} suppressHydrationWarning>
			<head>
				<HeadContent />
			</head>
			<body>
				<ThemeProvider
					attribute="class"
					defaultTheme="system"
					enableSystem
					disableTransitionOnChange
				>
					<Outlet />
					<Toaster />
				</ThemeProvider>
				{isDev && <TanStackRouterDevtools position="bottom-left" />}
				{isDev && (
					<ReactQueryDevtools position="bottom" buttonPosition="bottom-right" />
				)}
				<Scripts />
			</body>
		</html>
	);
}
