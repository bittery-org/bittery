import type { AppRouter } from "@bittery/api/routers/index";
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
import type { TRPCOptionsProxy } from "@trpc/tanstack-react-query";
import appCss from "../index.css?url";
import { useI18n } from "../providers/i18n-provider";

export interface RouterAppContext {
	trpc: TRPCOptionsProxy<AppRouter>;
	queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterAppContext>()({
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
	const isDev = import.meta.env.DEV;

	return (
		<html lang={locale}>
			<head>
				<HeadContent />
			</head>
			<body>
				<Outlet />
				<Toaster richColors />
				{isDev && <TanStackRouterDevtools position="bottom-left" />}
				{isDev && (
					<ReactQueryDevtools position="bottom" buttonPosition="bottom-right" />
				)}
				<Scripts />
			</body>
		</html>
	);
}
