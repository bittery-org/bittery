import { createFileRoute } from "@tanstack/react-router";
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
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/download")({
	component: DownloadPage,
	head: () => ({
		meta: [
			{ title: "Download — Bittery" },
			{
				name: "description",
				content:
					"Download Bittery for desktop, mobile, browser extension, or use the web app. Available on Windows, macOS, Linux, iOS, Android, and all major browsers.",
			},
		],
	}),
});

/* ------------------------------------------------------------------ */
/*  Platform SVG icons (from Simple Icons — simpleicons.org)          */
/* ------------------------------------------------------------------ */

function WindowsIcon({ className }: { className?: string }) {
	return (
		<svg role="img" viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
			<title>Windows</title>
			<path d="M0 0H11.377V11.372H0ZM12.623 0H24V11.372H12.623ZM0 12.623H11.377V24H0Zm12.623 0H24V24H12.623" />
		</svg>
	);
}

function AppleIcon({ className }: { className?: string }) {
	return (
		<svg role="img" viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
			<title>Apple</title>
			<path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
		</svg>
	);
}

function LinuxIcon({ className }: { className?: string }) {
	return (
		<svg role="img" viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
			<title>Linux</title>
			<path d="M12.504 0c-.155 0-.315.008-.48.021-4.226.333-3.105 4.807-3.17 6.298-.076 1.092-.3 1.953-1.05 3.02-.885 1.051-2.127 2.75-2.716 4.521-.278.832-.41 1.684-.287 2.489a.424.424 0 00-.11.135c-.26.268-.45.6-.663.839-.199.199-.485.267-.797.4-.313.136-.658.269-.864.68-.09.189-.136.394-.132.602 0 .199.027.4.055.536.058.399.116.728.04.97-.249.68-.28 1.145-.106 1.484.174.334.535.47.94.601.81.2 1.91.135 2.774.6.926.466 1.866.67 2.616.47.526-.116.97-.464 1.208-.946.587-.003 1.23-.269 2.26-.334.699-.058 1.574.267 2.577.2.025.134.063.198.114.333l.003.003c.391.778 1.113 1.132 1.884 1.071.771-.06 1.592-.536 2.257-1.306.631-.765 1.683-1.084 2.378-1.503.348-.199.629-.469.649-.853.023-.4-.2-.811-.714-1.376v-.097l-.003-.003c-.17-.2-.25-.535-.338-.926-.085-.401-.182-.786-.492-1.046h-.003c-.059-.054-.123-.067-.188-.135a.357.357 0 00-.19-.064c.431-1.278.264-2.55-.173-3.694-.533-1.41-1.465-2.638-2.175-3.483-.796-1.005-1.576-1.957-1.56-3.368.026-2.152.236-6.133-3.544-6.139z" />
		</svg>
	);
}

function AndroidIcon({ className }: { className?: string }) {
	return (
		<svg role="img" viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
			<title>Android</title>
			<path d="M18.4395 5.5586c-.675 1.1664-1.352 2.3318-2.0274 3.498-.0366-.0155-.0742-.0286-.1113-.043-1.8249-.6957-3.484-.8-4.42-.787-1.8551.0185-3.3544.4643-4.2597.8203-.084-.1494-1.7526-3.021-2.0215-3.4864a1.1451 1.1451 0 00-.1406-.1914c-.3312-.364-.9054-.4859-1.379-.203-.475.282-.7136.9361-.3886 1.5019 1.9466 3.3696-.0966-.2158 1.9473 3.3593.0172.031-.4946.2642-1.3926 1.0177C2.8987 12.176.452 14.772 0 18.9902h24c-.119-1.1108-.3686-2.099-.7461-3.0683-.7438-1.9118-1.8435-3.2928-2.7402-4.1836a12.1048 12.1048 0 00-2.1309-1.6875c.6594-1.122 1.312-2.2559 1.9649-3.3848.2077-.3615.1886-.7956-.0079-1.1191a1.1001 1.1001 0 00-.8515-.5332c-.5225-.0536-.9392.3128-1.0488.5449zm-.0391 8.461c.3944.5926.324 1.3306-.1563 1.6503-.4799.3197-1.188.0985-1.582-.4941-.3944-.5927-.324-1.3307.1563-1.6504.4727-.315 1.1812-.1086 1.582.4941zM7.207 13.5273c.4803.3197.5506 1.0577.1563 1.6504-.394.5926-1.1038.8138-1.584.4941-.48-.3197-.5503-1.0577-.1563-1.6504.4008-.6021 1.1087-.8106 1.584-.4941z" />
		</svg>
	);
}

function ChromeIcon({ className }: { className?: string }) {
	return (
		<svg role="img" viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
			<title>Chrome</title>
			<path d="M12 0C8.21 0 4.831 1.757 2.632 4.501l3.953 6.848A5.454 5.454 0 0 1 12 6.545h10.691A12 12 0 0 0 12 0zM1.931 5.47A11.943 11.943 0 0 0 0 12c0 6.012 4.42 10.991 10.189 11.864l3.953-6.847a5.45 5.45 0 0 1-6.865-2.29zm13.342 2.166a5.446 5.446 0 0 1 1.45 7.09l.002.001h-.002l-5.344 9.257c.206.01.413.016.621.016 6.627 0 12-5.373 12-12 0-1.54-.29-3.011-.818-4.364zM12 16.364a4.364 4.364 0 1 1 0-8.728 4.364 4.364 0 0 1 0 8.728Z" />
		</svg>
	);
}

function FirefoxIcon({ className }: { className?: string }) {
	return (
		<svg role="img" viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
			<title>Firefox</title>
			<path d="M8.824 7.287c.008 0 .004 0 0 0zm-2.8-1.4c.006 0 .003 0 0 0zm16.754 2.161c-.505-1.215-1.53-2.528-2.333-2.943.654 1.283 1.033 2.57 1.177 3.53l.002.02c-1.314-3.278-3.544-4.6-5.366-7.477-.091-.147-.184-.292-.273-.446a3.545 3.545 0 01-.13-.24 2.118 2.118 0 01-.172-.46.03.03 0 00-.027-.03.038.038 0 00-.021 0l-.006.001a.037.037 0 00-.01.005L15.624 0c-2.585 1.515-3.657 4.168-3.932 5.856a6.197 6.197 0 00-2.305.587.297.297 0 00-.147.37c.057.162.24.24.396.17a5.622 5.622 0 012.008-.523l.067-.005a5.847 5.847 0 011.957.222l.095.03a5.816 5.816 0 01.616.228c.08.036.16.073.238.112l.107.055a5.835 5.835 0 01.368.211 5.953 5.953 0 012.034 2.104c-.62-.437-1.733-.868-2.803-.681 4.183 2.09 3.06 9.292-2.737 9.02a5.164 5.164 0 01-1.513-.292 4.42 4.42 0 01-.538-.232c-1.42-.735-2.593-2.121-2.74-3.806 0 0 .537-2 3.845-2 .357 0 1.38-.998 1.398-1.287-.005-.095-2.029-.9-2.817-1.677-.422-.416-.622-.616-.8-.767a3.47 3.47 0 00-.301-.227 5.388 5.388 0 01-.032-2.842c-1.195.544-2.124 1.403-2.8 2.163h-.006c-.46-.584-.428-2.51-.402-2.913-.006-.025-.343.176-.389.206-.406.29-.787.616-1.136.974-.397.403-.76.839-1.085 1.303a9.816 9.816 0 00-1.562 3.52c-.003.013-.11.487-.19 1.073-.013.09-.026.181-.037.272a7.8 7.8 0 00-.069.667l-.002.034-.023.387-.001.06C.386 18.795 5.593 24 12.016 24c5.752 0 10.527-4.176 11.463-9.661.02-.149.035-.298.052-.448.232-1.994-.025-4.09-.753-5.844z" />
		</svg>
	);
}

function EdgeIcon({ className }: { className?: string }) {
	return (
		<svg role="img" viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
			<title>Edge</title>
			<path d="M21.86 17.86q.14 0 .25.12.1.13.1.25t-.11.33l-.32.46-.43.53-.44.5q-.21.25-.38.42l-.22.23q-.58.53-1.34 1.04-.76.51-1.6.91-.86.4-1.74.64t-1.67.24q-.9 0-1.69-.28-.8-.28-1.48-.78-.68-.5-1.22-1.17-.53-.66-.92-1.44-.38-.77-.58-1.6-.2-.83-.2-1.67 0-1 .32-1.96.33-.97.87-1.8.14.95.55 1.77.41.82 1.02 1.5.6.68 1.38 1.21.78.54 1.64.9.86.36 1.77.56.92.2 1.8.2 1.12 0 2.18-.24 1.06-.23 2.06-.72l.2-.1.2-.05zm-15.5-1.27q0 1.1.27 2.15.27 1.06.78 2.03.51.96 1.24 1.77.74.82 1.66 1.4-1.47-.2-2.8-.74-1.33-.55-2.48-1.37-1.15-.83-2.08-1.9-.92-1.07-1.58-2.33T.36 14.94Q0 13.54 0 12.06q0-.81.32-1.49.31-.68.83-1.23.53-.55 1.2-.96.66-.4 1.35-.66.74-.27 1.5-.39.78-.12 1.55-.12.7 0 1.42.1.72.12 1.4.35.68.23 1.32.57.63.35 1.16.83-.35 0-.7.07-.33.07-.65.23v-.02q-.63.28-1.2.74-.57.46-1.05 1.04-.48.58-.87 1.26-.38.67-.65 1.39-.27.71-.42 1.44-.15.72-.15 1.38zM11.96.06q1.7 0 3.33.39 1.63.38 3.07 1.15 1.43.77 2.62 1.93 1.18 1.16 1.98 2.7.49.94.76 1.96.28 1 .28 2.08 0 .89-.23 1.7-.24.8-.69 1.48-.45.68-1.1 1.22-.64.53-1.45.88-.54.24-1.11.36-.58.13-1.16.13-.42 0-.97-.03-.54-.03-1.1-.12-.55-.1-1.05-.28-.5-.19-.84-.5-.12-.09-.23-.24-.1-.16-.1-.33 0-.15.16-.35.16-.2.35-.5.2-.28.36-.68.16-.4.16-.95 0-1.06-.4-1.96-.4-.91-1.06-1.64-.66-.74-1.52-1.28-.86-.55-1.79-.89-.84-.3-1.72-.44-.87-.14-1.76-.14-1.55 0-3.06.45T.94 7.55q.71-1.74 1.81-3.13 1.1-1.38 2.52-2.35Q6.68 1.1 8.37.58q1.7-.52 3.58-.52Z" />
		</svg>
	);
}

function SafariIcon({ className }: { className?: string }) {
	return (
		<svg role="img" viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
			<title>Safari</title>
			<path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm0 1.258a10.742 10.742 0 1 1 0 21.484 10.742 10.742 0 0 1 0-21.484zm4.625 4.154L9.86 9.86l-4.448 6.765 6.765-4.448zm-.9.9L10.45 10.45l-3.138 4.776z" />
		</svg>
	);
}

/* ------------------------------------------------------------------ */
/*  Data                                                              */
/* ------------------------------------------------------------------  */

interface DownloadOption {
	label: string;
	description: string;
	href: string;
	icon: React.ComponentType<{ className?: string }>;
	badge?: string;
}

const desktopDownloads: DownloadOption[] = [
	{
		label: "macOS",
		description: "Apple Silicon & Intel",
		href: "#",
		icon: AppleIcon,
		badge: "Universal",
	},
	{
		label: "Windows",
		description: "Windows 10 or later",
		href: "#",
		icon: WindowsIcon,
	},
	{
		label: "Linux",
		description: ".deb, .rpm & AppImage",
		href: "#",
		icon: LinuxIcon,
	},
];

const mobileDownloads: DownloadOption[] = [
	{
		label: "iOS",
		description: "iPhone & iPad",
		href: "#",
		icon: AppleIcon,
		badge: "App Store",
	},
	{
		label: "Android",
		description: "Google Play & APK",
		href: "#",
		icon: AndroidIcon,
		badge: "Play Store",
	},
];

const browserDownloads: DownloadOption[] = [
	{
		label: "Chrome",
		description: "Chrome Web Store",
		href: "#",
		icon: ChromeIcon,
	},
	{
		label: "Firefox",
		description: "Firefox Add-ons",
		href: "#",
		icon: FirefoxIcon,
	},
	{
		label: "Edge",
		description: "Edge Add-ons",
		href: "#",
		icon: EdgeIcon,
	},
	{
		label: "Safari",
		description: "Mac App Store",
		href: "#",
		icon: SafariIcon,
	},
	{
		label: "Brave",
		description: "Chrome Web Store",
		href: "#",
		icon: ChromeIcon,
	},
];

/* ------------------------------------------------------------------ */
/*  Components                                                        */
/* ------------------------------------------------------------------ */

function DownloadCard({
	option,
	index,
}: { option: DownloadOption; index: number }) {
	return (
		<motion.a
			href={option.href}
			className="group relative flex items-center gap-4 rounded-2xl border border-border/60 bg-card p-5 transition-all duration-200 hover:border-primary/25 hover:shadow-lg hover:shadow-primary/5"
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
						<span className="rounded-full bg-primary/8 px-2 py-0.5 font-medium text-primary text-[10px]">
							{option.badge}
						</span>
					)}
				</div>
				<span className="text-muted-foreground text-xs">
					{option.description}
				</span>
			</div>
			<Download className="size-4 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-primary" />
		</motion.a>
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
							Available everywhere
						</div>
						<h1 className="font-bold font-display text-3xl tracking-tight sm:text-4xl lg:text-5xl">
							Get Bittery for{" "}
							<span className="bg-linear-to-r from-primary to-chart-4 bg-clip-text text-transparent">
								every device
							</span>
						</h1>
						<p className="mx-auto mt-4 max-w-2xl text-base text-muted-foreground leading-relaxed sm:text-lg">
							Download the native app, install the browser extension, or use the
							web app. Your vault syncs seamlessly across all platforms with
							end-to-end encryption.
						</p>

						<div className="mt-8 flex flex-wrap items-center justify-center gap-3">
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
								<Button
									size="lg"
									className="gap-2 rounded-full px-7"
									asChild
								>
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
								Your passwords are encrypted on your device before they leave
								it — we never see your data, no matter which platform you use.
							</p>
						</div>
					</motion.div>
				</div>
			</section>
		</>
	);
}
