import {
	AlertCircle,
	AlertTriangle,
	Check,
	Globe,
	KeyRound,
	Laptop,
	Link2,
	type LucideIcon,
	MonitorSmartphone,
	MousePointerClick,
	Plane,
	Puzzle,
	ShieldCheck,
	Smartphone,
	Terminal,
} from "lucide-react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";

const EASE = [0.16, 1, 0.3, 1] as const;

function Tile({
	className,
	icon: Icon,
	title,
	description,
	children,
	index,
	horizontal = false,
}: {
	className?: string;
	icon: LucideIcon;
	title: string;
	description: string;
	children?: React.ReactNode;
	index: number;
	horizontal?: boolean;
}) {
	return (
		<motion.div
			initial={{ opacity: 0, y: 16 }}
			whileInView={{ opacity: 1, y: 0 }}
			viewport={{ once: true, margin: "-80px" }}
			transition={{ duration: 0.55, delay: index * 0.06, ease: EASE }}
			className={cn(
				"group relative flex overflow-hidden rounded-xl border bg-card transition-colors duration-150 hover:border-border-strong",
				horizontal
					? "flex-col gap-8 p-6 sm:p-7 lg:flex-row lg:items-center"
					: "min-h-60 flex-col p-6",
				className,
			)}
		>
			<span
				aria-hidden
				className="pointer-events-none absolute inset-x-[12%] top-0 h-px bg-linear-to-r from-transparent via-foreground/14 to-transparent opacity-0 transition-opacity duration-200 group-hover:opacity-100"
			/>
			<div className={cn(horizontal && "lg:max-w-sm lg:shrink-0")}>
				<span className="mb-4 flex size-8 items-center justify-center rounded-md border bg-foreground/3 text-muted-foreground transition-colors duration-150 group-hover:text-foreground">
					<Icon className="size-4" />
				</span>
				<h3 className="font-semibold text-[16.5px] tracking-[-0.02em]">
					{title}
				</h3>
				<p className="mt-1.5 max-w-[46ch] text-[13.5px] text-muted-foreground leading-relaxed">
					{description}
				</p>
			</div>
			{children ? (
				<div className={cn(horizontal ? "min-w-0 lg:flex-1" : "mt-auto pt-6")}>
					{children}
				</div>
			) : null}
		</motion.div>
	);
}

/* ---- Sentinel demo: distribution bar + briefing rows cycling a "fixed" state ---- */
const SENTINEL_TIMES = [0, 0.42, 0.5, 0.92, 1] as const;

function SentinelDemo() {
	return (
		<div className="space-y-2">
			<div className="flex items-center gap-3 px-0.5 pb-1">
				<div className="flex h-1.5 flex-1 gap-px overflow-hidden rounded-full bg-foreground/6">
					<span className="h-full w-[91%] bg-success" />
					<span className="h-full w-[3%] bg-destructive" />
					<motion.span
						className="h-full w-[3%] bg-warning"
						animate={{ opacity: [1, 1, 0.25, 0.25, 1] }}
						transition={{
							duration: 6,
							times: [...SENTINEL_TIMES],
							repeat: Number.POSITIVE_INFINITY,
						}}
					/>
					<span className="h-full w-[3%] bg-success/50" />
				</div>
				<span className="shrink-0 text-[10.5px] text-muted-foreground tabular-nums">
					124 monitored
				</span>
			</div>
			<div className="flex items-center gap-2.5 rounded-lg border bg-background px-3 py-2.5">
				<AlertCircle className="size-3.5 shrink-0 text-destructive" />
				<span className="min-w-0 flex-1">
					<span className="block truncate font-medium text-[12.5px]">
						2 reused passwords
					</span>
					<span className="block text-[11px] text-muted-foreground">
						High priority · jumps straight to the items
					</span>
				</span>
				<span className="rounded-[4px] border bg-foreground/3 px-1.5 py-0.5 text-[10px] text-muted-foreground">
					Fix
				</span>
			</div>
			<div className="relative flex items-center gap-2.5 rounded-lg border bg-background px-3 py-2.5">
				<motion.span
					className="flex size-3.5 shrink-0 items-center justify-center"
					animate={{ opacity: [1, 1, 0, 0, 1] }}
					transition={{
						duration: 6,
						times: [...SENTINEL_TIMES],
						repeat: Number.POSITIVE_INFINITY,
					}}
				>
					<AlertTriangle className="size-3.5 text-warning" />
				</motion.span>
				<motion.span
					aria-hidden
					className="absolute left-3 flex size-3.5 items-center justify-center"
					animate={{ opacity: [0, 0, 1, 1, 0] }}
					transition={{
						duration: 6,
						times: [...SENTINEL_TIMES],
						repeat: Number.POSITIVE_INFINITY,
					}}
				>
					<Check className="size-3.5 text-success" />
				</motion.span>
				<span className="min-w-0 flex-1">
					<span className="block truncate font-medium text-[12.5px]">
						1 weak password
					</span>
					<span className="block text-[11px] text-muted-foreground">
						Crack-time estimate: under a day
					</span>
				</span>
				<motion.span
					className="rounded-[4px] border bg-foreground/3 px-1.5 py-0.5 text-[10px] text-muted-foreground"
					animate={{ opacity: [1, 1, 0, 0, 1] }}
					transition={{
						duration: 6,
						times: [...SENTINEL_TIMES],
						repeat: Number.POSITIVE_INFINITY,
					}}
				>
					Fix
				</motion.span>
				<motion.span
					aria-hidden
					className="absolute right-3 rounded-[4px] px-1.5 py-0.5 font-medium text-[10px] text-success"
					animate={{ opacity: [0, 0, 1, 1, 0] }}
					transition={{
						duration: 6,
						times: [...SENTINEL_TIMES],
						repeat: Number.POSITIVE_INFINITY,
					}}
				>
					Fixed
				</motion.span>
			</div>
		</div>
	);
}

/* ---- Travel Mode demo: toggle flips, the Work vault vanishes ---- */
const TRAVEL_TIMES = [0, 0.15, 0.25, 0.75, 0.85, 1] as const;

function TravelDemo() {
	return (
		<div className="flex items-center gap-4">
			<span className="relative h-5.5 w-10 shrink-0 rounded-full bg-foreground/10">
				<motion.span
					aria-hidden
					className="absolute inset-0 rounded-full bg-linear-to-b from-primary to-primary-deep shadow-[0_0_14px_color-mix(in_oklab,var(--color-primary-deep)_40%,transparent)]"
					animate={{ opacity: [0, 0, 1, 1, 0, 0] }}
					transition={{
						duration: 7,
						times: [...TRAVEL_TIMES],
						repeat: Number.POSITIVE_INFINITY,
					}}
				/>
				<motion.span
					aria-hidden
					className="absolute top-0.5 left-0.5 size-4.5 rounded-full bg-white shadow-[0_1px_3px_oklch(0_0_0/0.4)]"
					animate={{ x: [0, 0, 18, 18, 0, 0] }}
					transition={{
						duration: 7,
						times: [...TRAVEL_TIMES],
						repeat: Number.POSITIVE_INFINITY,
						ease: "easeInOut",
					}}
				/>
			</span>
			<div className="min-w-0 flex-1 space-y-1.5">
				<div className="flex items-center gap-2 rounded-md border bg-background px-2.5 py-1.5 text-[12px]">
					<span className="flex size-4 items-center justify-center rounded-[4.5px] bg-linear-to-br from-sky-500/90 to-blue-600/90 font-semibold text-[7.5px] text-white shadow-[inset_0_0_0_1px_oklch(1_0_0/0.12)]">
						P
					</span>
					<span className="text-muted-foreground">Personal</span>
					<span className="ml-auto font-semibold text-[9.5px] text-success uppercase tracking-[0.05em]">
						Safe
					</span>
				</div>
				<motion.div
					className="flex items-center gap-2 rounded-md border bg-background px-2.5 py-1.5 text-[12px]"
					animate={{ opacity: [1, 1, 0.45, 0.45, 1, 1] }}
					transition={{
						duration: 7,
						times: [...TRAVEL_TIMES],
						repeat: Number.POSITIVE_INFINITY,
					}}
				>
					<span className="flex size-4 items-center justify-center rounded-[4.5px] bg-linear-to-br from-amber-500/90 to-orange-600/90 font-semibold text-[7.5px] text-white shadow-[inset_0_0_0_1px_oklch(1_0_0/0.12)]">
						W
					</span>
					<span className="relative text-muted-foreground">
						Work
						<motion.span
							aria-hidden
							className="absolute top-1/2 left-0 h-px w-full bg-foreground/50"
							animate={{ scaleX: [0, 0, 1, 1, 0, 0] }}
							style={{ originX: 0 }}
							transition={{
								duration: 7,
								times: [...TRAVEL_TIMES],
								repeat: Number.POSITIVE_INFINITY,
							}}
						/>
					</span>
					<span className="relative ml-auto font-semibold text-[9.5px] uppercase tracking-[0.05em]">
						<motion.span
							className="text-success"
							animate={{ opacity: [1, 1, 0, 0, 1, 1] }}
							transition={{
								duration: 7,
								times: [...TRAVEL_TIMES],
								repeat: Number.POSITIVE_INFINITY,
							}}
						>
							Safe
						</motion.span>
						<motion.span
							className="absolute right-0 text-muted-foreground"
							animate={{ opacity: [0, 0, 1, 1, 0, 0] }}
							transition={{
								duration: 7,
								times: [...TRAVEL_TIMES],
								repeat: Number.POSITIVE_INFINITY,
							}}
						>
							Hidden
						</motion.span>
					</span>
				</motion.div>
			</div>
		</div>
	);
}

/* ---- Autofill demo: dots type in, the badge pops ---- */
function AutofillDemo() {
	const dotCount = 12;
	return (
		<div className="rounded-lg border bg-background p-3.5">
			<p className="mb-1 text-[10px] text-muted-foreground tracking-[0.03em]">
				Password
			</p>
			<div className="flex h-8.5 items-center gap-2 rounded-md border border-primary/50 bg-foreground/3 px-2.5 shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-primary)_13%,transparent)]">
				<span className="flex items-center gap-[3px]" aria-hidden>
					{Array.from({ length: dotCount }, (_, i) => i).map((i) => (
						<motion.i
							key={i}
							className="size-[4.5px] rounded-full bg-foreground"
							animate={{ opacity: [0, 0, 1, 1, 0] }}
							transition={{
								duration: 5,
								times: [0, 0.08 + i * 0.02, 0.12 + i * 0.02, 0.9, 1],
								repeat: Number.POSITIVE_INFINITY,
							}}
						/>
					))}
				</span>
				<motion.span
					className="ml-auto inline-flex items-center gap-1 font-semibold text-[10px] text-primary"
					animate={{
						opacity: [0, 0, 1, 1, 0],
						scale: [0.85, 0.85, 1, 1, 0.85],
					}}
					transition={{
						duration: 5,
						times: [0, 0.36, 0.42, 0.9, 1],
						repeat: Number.POSITIVE_INFINITY,
					}}
				>
					<Check className="size-2.5" />
					Filled by Bittery
				</motion.span>
			</div>
			<p className="mt-2 text-[10.5px] text-muted-foreground">
				github.com · matched exactly
			</p>
		</div>
	);
}

/* ---- Passkey demo: quiet pulse halo ---- */
function PasskeyDemo() {
	return (
		<div className="flex items-center gap-3 rounded-lg border bg-background p-3">
			<span className="relative flex size-9 shrink-0 items-center justify-center rounded-lg bg-linear-to-br from-primary to-primary-deep shadow-[inset_0_0_0_1px_oklch(1_0_0/0.16)]">
				<motion.span
					aria-hidden
					className="absolute inset-0 rounded-lg shadow-[0_0_18px_color-mix(in_oklab,var(--color-primary-deep)_45%,transparent)]"
					animate={{ opacity: [0.4, 1, 0.4] }}
					transition={{
						duration: 3.2,
						repeat: Number.POSITIVE_INFINITY,
						ease: "easeInOut",
					}}
				/>
				<KeyRound className="size-4 text-white" />
			</span>
			<span className="min-w-0 flex-1">
				<span className="block font-medium text-[12.5px]">figma.com</span>
				<span className="block text-[11px] text-muted-foreground">
					Passkey · synced to 5 devices
				</span>
			</span>
			<span className="font-semibold text-[11px] text-success">Active</span>
		</div>
	);
}

/* ---- Share demo: expiry bar drains ---- */
function ShareDemo() {
	return (
		<div className="overflow-hidden rounded-lg border bg-background">
			<div className="flex items-center gap-2.5 px-3 py-2.5 text-[12px]">
				<Link2 className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="truncate font-mono text-[11px] text-muted-foreground">
					bittery.com/s/x7Kf…q2
				</span>
				<span className="ml-auto shrink-0 font-semibold text-[10px] text-warning">
					One-time link
				</span>
			</div>
			<motion.div
				aria-hidden
				className="h-0.5 bg-linear-to-r from-primary to-primary-deep"
				animate={{ scaleX: [1, 0] }}
				style={{ originX: 0 }}
				transition={{
					duration: 8,
					repeat: Number.POSITIVE_INFINITY,
					ease: "linear",
				}}
			/>
		</div>
	);
}

/* ---- Platforms demo: iconified chips + live sync line ---- */
const PLATFORMS: { label: string; icon: LucideIcon }[] = [
	{ label: "Web", icon: Globe },
	{ label: "macOS", icon: Laptop },
	{ label: "Windows", icon: MonitorSmartphone },
	{ label: "Linux", icon: Terminal },
	{ label: "iOS", icon: Smartphone },
	{ label: "Android", icon: Smartphone },
	{ label: "Extension", icon: Puzzle },
];

function PlatformsDemo() {
	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center gap-2">
				{PLATFORMS.map((platform) => (
					<span
						key={platform.label}
						className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-2 font-medium text-[12.5px] text-muted-foreground transition-colors duration-150 hover:border-border-strong hover:text-foreground"
					>
						<platform.icon className="size-3.5" />
						{platform.label}
					</span>
				))}
			</div>
			<p className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
				<motion.span
					aria-hidden
					className="size-[6px] rounded-full bg-success shadow-[0_0_8px_color-mix(in_oklab,var(--color-success)_70%,transparent)]"
					animate={{ opacity: [1, 0.35, 1] }}
					transition={{
						duration: 2.4,
						repeat: Number.POSITIVE_INFINITY,
						ease: "easeInOut",
					}}
				/>
				All devices in sync · end-to-end encrypted, no exceptions
			</p>
		</div>
	);
}

export function BentoGrid() {
	return (
		<section id="features" className="px-4 py-24">
			<div className="mx-auto max-w-5xl">
				<div className="mb-12 max-w-xl">
					<p className="mb-3 font-semibold text-[12px] text-primary uppercase tracking-[0.08em]">
						Features
					</p>
					<h2 className="font-semibold text-[30px] leading-[1.1] tracking-[-0.035em] sm:text-[40px]">
						Sweating the pixels.
						<br />
						Sweating the crypto.
					</h2>
					<p className="mt-3.5 text-[16px] text-muted-foreground">
						Every detail is deliberate — from the hairline borders to the 96-bit
						IVs. The same care you can see went into everything you can't.
					</p>
				</div>

				<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-6">
					<Tile
						index={0}
						className="lg:col-span-4"
						icon={ShieldCheck}
						title="Sentinel — your whole security posture, live"
						description="A prioritized briefing, not a wall of warnings. Sentinel scores every vault, flags weak, reused and aging passwords, and tells you exactly what to fix first."
					>
						<SentinelDemo />
					</Tile>
					<Tile
						index={1}
						className="lg:col-span-2"
						icon={Plane}
						title="Travel Mode"
						description="Cross a border. Leave nothing to find. Marked vaults vanish from every device until you're through."
					>
						<TravelDemo />
					</Tile>
					<Tile
						index={2}
						className="lg:col-span-2"
						icon={MousePointerClick}
						title="Autofill that can't be phished"
						description="Isolated in its own Shadow DOM and iframe, matched by exact hostname. Fills, never leaks."
					>
						<AutofillDemo />
					</Tile>
					<Tile
						index={3}
						className="lg:col-span-2"
						icon={KeyRound}
						title="Passkeys, ready"
						description="Passwords, passkeys, and everything after — one vault for the whole messy decade in between."
					>
						<PasskeyDemo />
					</Tile>
					<Tile
						index={4}
						className="lg:col-span-2"
						icon={Link2}
						title="Share a secret, not a screenshot"
						description="Expiring links, one-time views, verified recipients — with an access log you can revoke from."
					>
						<ShareDemo />
					</Tile>
					<Tile
						index={5}
						horizontal
						className="lg:col-span-6"
						icon={Globe}
						title="Everywhere you are — one vault, every device"
						description="One encrypted vault on web, desktop and mobile, with autofill in your browser. Every change syncs across all of them in seconds."
					>
						<PlatformsDemo />
					</Tile>
				</div>
			</div>
		</section>
	);
}
