import {
	DESKTOP_DOWNLOADS,
	detectOS,
	getPrimaryDownloadForOS,
	RELEASES_PAGE_URL,
	resolveLatestRelease,
} from "@bittery/shared/releases";
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
	Download,
	ExternalLink,
	Globe,
	Monitor,
	MonitorSmartphone,
	Puzzle,
	Shield,
	Smartphone,
} from "lucide-react";
import { motion } from "motion/react";
import {
	AndroidIcon,
	AppleIcon,
	ChromeIcon,
	EdgeIcon,
	FirefoxIcon,
	LinuxIcon,
	SafariIcon,
	WindowsIcon,
} from "@/components/landing/platform-icons";
import { Button } from "@/components/ui/button";
import { seo } from "@/lib/seo";

const getLatestRelease = createServerFn({ method: "GET" }).handler(async () => {
	return resolveLatestRelease();
});

export const Route = createFileRoute("/download")({
	component: DownloadPage,
	loader: async () => {
		const latestRelease = await getLatestRelease();
		return { latestRelease };
	},
	head: () => ({
		meta: seo({
			title: "Download — Bittery",
			description:
				"Download Bittery for desktop, mobile, browser extension, or use the web app. Available on Windows, macOS, Linux, iOS, Android, and all major browsers.",
		}),
	}),
});

/* ------------------------------------------------------------------ */
/*  Data                                                              */
/* ------------------------------------------------------------------  */

interface DownloadOption {
	label: string;
	description: string;
	href: string;
	icon: React.ComponentType<{ className?: string }>;
	badge?: string;
	secondaryHref?: { label: string; href: string };
}

const extensionDownloadUrl = DESKTOP_DOWNLOADS.extension.url;

const desktopDownloads: DownloadOption[] = [
	{
		label: "macOS",
		description: "Apple Silicon",
		href: DESKTOP_DOWNLOADS.macos.url,
		icon: AppleIcon,
	},
	{
		label: "Windows",
		description: "Installer or portable .exe",
		href: DESKTOP_DOWNLOADS.windows.url,
		icon: WindowsIcon,
		secondaryHref: {
			label: "Portable .exe",
			href: DESKTOP_DOWNLOADS.windowsPortable.url,
		},
	},
	{
		label: "Linux",
		description: "AppImage & .deb packages",
		href: DESKTOP_DOWNLOADS.linuxAppImage.url,
		icon: LinuxIcon,
		secondaryHref: {
			label: ".deb package",
			href: DESKTOP_DOWNLOADS.linuxDeb.url,
		},
	},
];

const mobileDownloads: DownloadOption[] = [
	{
		label: "iOS",
		description: "iPhone & iPad",
		href: "#",
		icon: AppleIcon,
		badge: "Coming soon",
	},
	{
		label: "Android",
		description: "Google Play & APK",
		href: "#",
		icon: AndroidIcon,
		badge: "Coming soon",
	},
];

const browserDownloads: DownloadOption[] = [
	{
		label: "Chrome",
		description: "Sideload extension (.zip)",
		href: extensionDownloadUrl,
		icon: ChromeIcon,
	},
	{
		label: "Firefox",
		description: "Sideload extension (.zip)",
		href: extensionDownloadUrl,
		icon: FirefoxIcon,
	},
	{
		label: "Edge",
		description: "Sideload extension (.zip)",
		href: extensionDownloadUrl,
		icon: EdgeIcon,
	},
	{
		label: "Safari",
		description: "Mac App Store",
		href: "#",
		icon: SafariIcon,
		badge: "Coming soon",
	},
	{
		label: "Brave",
		description: "Sideload extension (.zip)",
		href: extensionDownloadUrl,
		icon: ChromeIcon,
	},
];

/* ------------------------------------------------------------------ */
/*  Components                                                        */
/* ------------------------------------------------------------------ */

function DownloadCard({
	option,
	index,
}: {
	option: DownloadOption;
	index: number;
}) {
	const isComingSoon = option.href === "#";

	return (
		<motion.div
			className={`group relative flex items-center gap-4 rounded-2xl border border-border/60 bg-card p-5 transition-all duration-200 ${
				isComingSoon
					? "opacity-75"
					: "hover:border-primary/25 hover:shadow-lg hover:shadow-primary/5"
			}`}
			initial={{ opacity: 0, y: 12 }}
			whileInView={{ opacity: 1, y: 0 }}
			viewport={{ once: true, margin: "-60px" }}
			transition={{ duration: 0.4, delay: index * 0.06 }}
		>
			<div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-muted/60 transition-colors group-hover:bg-primary/10 group-hover:text-primary">
				<option.icon className="size-6 transition-colors group-hover:text-primary" />
			</div>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="font-semibold text-foreground text-sm">
						{option.label}
					</span>
					{option.badge && (
						<span className="rounded-full bg-primary/8 px-2 py-0.5 font-medium text-[10px] text-primary">
							{option.badge}
						</span>
					)}
				</div>
				<span className="text-muted-foreground text-xs">
					{option.description}
					{option.secondaryHref && (
						<>
							{" · "}
							<a
								href={option.secondaryHref.href}
								className="relative z-10 text-primary hover:underline"
								onClick={(event) => event.stopPropagation()}
							>
								{option.secondaryHref.label}
							</a>
						</>
					)}
				</span>
			</div>
			{!isComingSoon && (
				<a
					href={option.href}
					target="_blank"
					rel="noopener noreferrer"
					className="absolute inset-0 rounded-2xl"
					aria-label={`Download Bittery for ${option.label}`}
				>
					<span className="sr-only">Download Bittery for {option.label}</span>
				</a>
			)}
			{!isComingSoon && (
				<Download className="size-4 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-primary" />
			)}
		</motion.div>
	);
}

function SectionBlock({
	icon: Icon,
	title,
	subtitle,
	children,
	delay = 0,
}: {
	icon: React.ComponentType<{ className?: string }>;
	title: string;
	subtitle: string;
	children: React.ReactNode;
	delay?: number;
}) {
	return (
		<motion.div
			initial={{ opacity: 0, y: 16 }}
			whileInView={{ opacity: 1, y: 0 }}
			viewport={{ once: true, margin: "-80px" }}
			transition={{ duration: 0.5, delay }}
		>
			<div className="mb-6 flex items-center gap-3">
				<div className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
					<Icon className="size-5" />
				</div>
				<div>
					<h3 className="font-display font-semibold text-foreground text-lg">
						{title}
					</h3>
					<p className="text-muted-foreground text-xs">{subtitle}</p>
				</div>
			</div>
			{children}
		</motion.div>
	);
}

/* ------------------------------------------------------------------ */
/*  Page                                                              */
/* ------------------------------------------------------------------ */

function DownloadPage() {
	const { latestRelease } = Route.useLoaderData();
	const os = detectOS();
	const primaryDownload = getPrimaryDownloadForOS(os);

	return (
		<>
			{/* ─── Hero ──────────────────────────────────────────── */}
			<section className="relative overflow-hidden pt-28 pb-16 sm:pt-36 sm:pb-20">
				{/* Ambient gradients */}
				<div className="pointer-events-none absolute inset-0 overflow-hidden">
					<div className="absolute top-0 right-0 h-150 w-150 translate-x-1/3 -translate-y-1/3 rounded-full bg-primary/4 blur-3xl" />
					<div className="absolute bottom-0 left-0 h-100 w-100 -translate-x-1/3 translate-y-1/3 rounded-full bg-primary/3 blur-3xl" />
				</div>

				<div className="relative mx-auto max-w-5xl px-4 text-center">
					<motion.div
						initial={{ opacity: 0, y: 20 }}
						animate={{ opacity: 1, y: 0 }}
						transition={{ duration: 0.6, ease: "easeOut" }}
					>
						<div className="mb-5 inline-flex items-center gap-2 rounded-full border border-primary/15 bg-primary/8 px-3 py-1 font-medium text-primary text-xs">
							<MonitorSmartphone className="size-3.5" />
							{latestRelease
								? `Latest release ${latestRelease.tagName}`
								: "Desktop apps available"}
						</div>
						<h1 className="font-bold font-display text-3xl tracking-tight sm:text-4xl lg:text-5xl">
							Get Bittery for{" "}
							<span className="bg-linear-to-r from-primary to-chart-4 bg-clip-text text-transparent">
								every device
							</span>
						</h1>
						<p className="mx-auto mt-4 max-w-2xl text-base text-muted-foreground leading-relaxed sm:text-lg">
							Download native desktop apps and the browser extension, use the
							web app during hosted beta, or self-host Bittery on your own
							infrastructure.
						</p>

						<div className="mt-8 flex flex-wrap items-center justify-center gap-3">
							{primaryDownload ? (
								<Button size="lg" className="gap-2 rounded-full px-7" asChild>
									<a
										href={primaryDownload.url}
										target="_blank"
										rel="noopener noreferrer"
									>
										<Download className="size-4" />
										Download for{" "}
										{os === "macos"
											? "macOS"
											: os === "windows"
												? "Windows"
												: "Linux"}
									</a>
								</Button>
							) : (
								<Button size="lg" className="gap-2 rounded-full px-7" asChild>
									<a
										href={RELEASES_PAGE_URL}
										target="_blank"
										rel="noopener noreferrer"
									>
										<Download className="size-4" />
										Download Desktop
									</a>
								</Button>
							)}
							<Button
								size="lg"
								variant="outline"
								className="gap-2 rounded-full px-7"
								asChild
							>
								<a
									href={RELEASES_PAGE_URL}
									target="_blank"
									rel="noopener noreferrer"
								>
									All downloads
									<ExternalLink className="size-4" />
								</a>
							</Button>
							<Button
								size="lg"
								variant="outline"
								className="gap-2 rounded-full px-7"
								asChild
							>
								<a href="#web-app">
									<Globe className="size-4" />
									Use Web App
								</a>
							</Button>
						</div>
					</motion.div>
				</div>
			</section>

			{/* ─── Download sections ─────────────────────────────── */}
			<section className="px-4 pt-16 pb-24 sm:pb-32">
				<div className="mx-auto max-w-4xl space-y-16">
					{/* Desktop */}
					<SectionBlock
						icon={Monitor}
						title="Desktop"
						subtitle="Windows, macOS & Linux"
						delay={0}
					>
						<div className="grid gap-3 sm:grid-cols-3">
							{desktopDownloads.map((opt, i) => (
								<DownloadCard key={opt.label} option={opt} index={i} />
							))}
						</div>
					</SectionBlock>

					{/* Mobile */}
					<SectionBlock
						icon={Smartphone}
						title="Mobile"
						subtitle="iOS & Android"
						delay={0.1}
					>
						<div className="grid gap-3 sm:grid-cols-2">
							{mobileDownloads.map((opt, i) => (
								<DownloadCard key={opt.label} option={opt} index={i} />
							))}
						</div>
					</SectionBlock>

					{/* Browser Extensions */}
					<SectionBlock
						icon={Puzzle}
						title="Browser Extensions"
						subtitle="Autofill passwords in any browser"
						delay={0.2}
					>
						<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
							{browserDownloads.map((opt, i) => (
								<DownloadCard key={opt.label} option={opt} index={i} />
							))}
						</div>
					</SectionBlock>

					{/* Web App */}
					<motion.div
						id="web-app"
						className="scroll-mt-24"
						initial={{ opacity: 0, y: 16 }}
						whileInView={{ opacity: 1, y: 0 }}
						viewport={{ once: true, margin: "-80px" }}
						transition={{ duration: 0.5, delay: 0.3 }}
					>
						<div className="relative overflow-hidden rounded-2xl border border-border/60 bg-linear-to-br from-card via-card to-primary/3 p-8 sm:rounded-3xl sm:p-10">
							<div className="absolute top-0 right-0 h-64 w-64 translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/4 blur-3xl" />

							<div className="relative flex flex-col items-center gap-6 text-center sm:flex-row sm:text-left">
								<div className="flex size-16 shrink-0 items-center justify-center rounded-2xl bg-primary/12 text-primary">
									<Globe className="size-8" />
								</div>
								<div className="flex-1">
									<h3 className="font-display font-semibold text-xl">
										Web App
									</h3>
									<p className="mt-1 text-muted-foreground text-sm leading-relaxed">
										Access your vault from any modern browser — no installation
										required. Works on any device with a web browser.
									</p>
								</div>
								<Button size="lg" className="gap-2 rounded-full px-7" asChild>
									<a
										href="https://app.bittery.com"
										target="_blank"
										rel="noopener noreferrer"
									>
										Open Web App
										<ExternalLink className="size-4" />
									</a>
								</Button>
							</div>
						</div>
					</motion.div>

					{/* Security note */}
					<motion.div
						className="flex items-start gap-4 rounded-2xl border border-emerald-500/15 bg-emerald-500/5 p-6"
						initial={{ opacity: 0, y: 12 }}
						whileInView={{ opacity: 1, y: 0 }}
						viewport={{ once: true, margin: "-60px" }}
						transition={{ duration: 0.4, delay: 0.1 }}
					>
						<div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10">
							<Shield className="size-5 text-emerald-600 dark:text-emerald-400" />
						</div>
						<div>
							<h4 className="font-semibold text-foreground text-sm">
								End-to-end encrypted on every platform
							</h4>
							<p className="mt-1 text-muted-foreground text-sm leading-relaxed">
								Every Bittery app uses the same zero-knowledge architecture.
								Your passwords are encrypted on your device before they leave it
								— we never see your data, no matter which platform you use.
							</p>
						</div>
					</motion.div>
				</div>
			</section>
		</>
	);
}
