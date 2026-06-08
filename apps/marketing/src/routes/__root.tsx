/** biome-ignore-all lint/security/noDangerouslySetInnerHtml: This is required for theming */
import { TanStackDevtools } from "@tanstack/react-devtools";
import {
	createRootRoute,
	HeadContent,
	Outlet,
	Scripts,
} from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { Footer } from "@/components/landing/footer";
import { Header } from "@/components/landing/header";
import { ThemeContext } from "@/lib/theme-context";
import appCss from "../styles.css?url";

const getThemeCookie = createServerFn({ method: "GET" }).handler(async () => {
	const cookieHeader = getRequestHeader("Cookie") ?? "";
	const match = cookieHeader.match(/(?:^|;\s*)theme=(dark|light)/);
	return (match?.[1] as "dark" | "light") ?? null;
});

export const Route = createRootRoute({
	component: RootComponent,
	loader: async () => {
		const theme = await getThemeCookie();
		return { theme };
	},
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
				title: "Bittery — Zero-Knowledge Password Manager",
			},
			{
				name: "description",
				content:
					"Open-source, zero-knowledge password manager with AES-256-GCM encryption. Self-host or use our cloud. Available on web, desktop, mobile, and browser extensions.",
			},
			{
				name: "apple-mobile-web-app-title",
				content: "bittery",
			},
		],
		links: [
			{
				rel: "preconnect",
				href: "https://fonts.googleapis.com",
			},
			{
				rel: "preconnect",
				href: "https://fonts.gstatic.com",
				crossOrigin: "anonymous",
			},
			{
				rel: "stylesheet",
				href: "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=Syne:wght@500;600;700;800&display=swap",
			},
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

	shellComponent: RootDocument,
});

function RootComponent() {
	const { theme } = Route.useLoaderData();
	return (
		<ThemeContext.Provider value={theme}>
			<div>
				<Header />
				<main>
					<Outlet />
				</main>
				<Footer />
			</div>
		</ThemeContext.Provider>
	);
}

function RootDocument({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				<HeadContent />
			</head>
			<body className="grain antialiased">
				<script
					dangerouslySetInnerHTML={{
						__html: `(function(){try{var c=document.cookie.match(/(?:^|;\\s*)theme=(dark|light)/);var t=c?c[1]:null;if(!t){t=matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';document.cookie='theme='+t+';path=/;max-age=31536000;SameSite=Lax'}if(t==='dark')document.documentElement.classList.add('dark')}catch(e){}})()`,
					}}
				/>
				{children}
				<TanStackDevtools
					config={{
						position: "bottom-right",
					}}
					plugins={[
						{
							name: "Tanstack Router",
							render: <TanStackRouterDevtoolsPanel />,
						},
					]}
				/>
				<Scripts />
			</body>
		</html>
	);
}
