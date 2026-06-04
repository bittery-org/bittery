import {
	Check,
	Globe,
	Monitor,
	Puzzle,
	RefreshCw,
	Smartphone,
} from "lucide-react";
import { animate, motion, useMotionValue, useTransform } from "motion/react";
import { useEffect, useState } from "react";
import desktopImg from "../../assets/desktop.png";
import extensionImg from "../../assets/extension.png";
import mobileImg from "../../assets/mobile.png";
import webImg from "../../assets/web.png";
import { cn } from "../../lib/utils";

/* ------------------------------------------------------------------ */
/*  Platform tabs                                                     */
/* ------------------------------------------------------------------ */

const platforms = [
	{
		id: "desktop",
		icon: Monitor,
		name: "Desktop",
		subtitle: "Windows, macOS, Linux",
		image: desktopImg,
	},
	{
		id: "web",
		icon: Globe,
		name: "Web",
		subtitle: "Any modern browser",
		image: webImg,
	},
	{
		id: "mobile",
		icon: Smartphone,
		name: "Mobile",
		subtitle: "iOS & Android",
		image: mobileImg,
	},
	{
		id: "extension",
		icon: Puzzle,
		name: "Extension",
		subtitle: "Chrome, Edge, Brave",
		image: extensionImg,
	},
];

/* ------------------------------------------------------------------ */
/*  Sync animation — animated counter                                 */
/* ------------------------------------------------------------------ */

function SyncIndicator() {
	const count = useMotionValue(0);
	const rounded = useTransform(count, (latest) => Math.round(latest));
	const [display, setDisplay] = useState(0);

	useEffect(() => {
		const unsub = rounded.on("change", (v) => setDisplay(v));
		const controls = animate(count, 142, {
			duration: 2,
			ease: "easeOut",
		});
		return () => {
			unsub();
			controls.stop();
		};
	}, [count, rounded]);

	return (
		<motion.div
			className="flex items-center gap-3 rounded-xl border border-border/60 bg-card px-4 py-3"
			initial={{ opacity: 0, y: 10 }}
			whileInView={{ opacity: 1, y: 0 }}
			viewport={{ once: true }}
			transition={{ delay: 0.6 }}
		>
			<div className="flex size-8 items-center justify-center rounded-lg bg-emerald-500/10">
				<Check className="size-4 text-emerald-500" />
			</div>
			<div>
				<div className="font-semibold text-sm">
					<span>{display}</span> items synced
				</div>
				<div className="text-muted-foreground/60 text-xs">
					All devices up to date
				</div>
			</div>
			<div className="ml-auto">
				<RefreshCw className="size-3.5 text-muted-foreground/30" />
			</div>
		</motion.div>
	);
}

/* ------------------------------------------------------------------ */
/*  Main section                                                      */
/* ------------------------------------------------------------------ */

export function PlatformSection() {
	const [active, setActive] = useState("desktop");
	const activeImage =
		platforms.find((p) => p.id === active)?.image ?? desktopImg;

	return (
		<section className="relative overflow-hidden px-4 py-24 sm:py-32">
			{/* Ambient background glow — layered soft blobs */}
			<div className="pointer-events-none absolute inset-0 -z-10">
				<div className="absolute top-[40%] left-[45%] h-125 w-175 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/4 blur-[120px]" />
				<div className="absolute top-[55%] left-[55%] h-100 w-125 -translate-x-1/2 -translate-y-1/2 rounded-full bg-chart-4/[0.035] blur-[100px]" />
			</div>

			<div className="mx-auto max-w-6xl">
				{/* Header */}
				<motion.div
					className="mb-14 text-center sm:mb-20"
					initial={{ opacity: 0, y: 16 }}
					whileInView={{ opacity: 1, y: 0 }}
					viewport={{ once: true, margin: "-100px" }}
					transition={{ duration: 0.6 }}
				>
					<div className="mb-5 inline-flex items-center gap-2 rounded-full border border-primary/15 bg-primary/[0.07] px-3 py-1 font-medium text-primary text-xs">
						<RefreshCw className="size-3" />
						Instant sync across devices
					</div>
					<h2 className="font-display text-3xl leading-tight tracking-tight sm:text-4xl md:text-5xl lg:text-[3.25rem]">
						One vault,{" "}
						<span className="bg-linear-to-r from-primary to-chart-4 bg-clip-text text-transparent">
							every device
						</span>
					</h2>
					<p className="mx-auto mt-4 max-w-2xl text-base text-muted-foreground leading-relaxed sm:text-lg">
						Install Bittery wherever you need it. Your passwords stay encrypted
						end-to-end and sync seamlessly — whether you're at your desk, on
						your phone, or in your browser.
					</p>
				</motion.div>

				{/* Tab selector + Mockup */}
				<div className="grid items-start gap-6 lg:grid-cols-[280px_1fr] lg:gap-10">
					{/* Platform tabs — vertical on desktop, horizontal scroll on mobile */}
					<motion.div
						className="scrollbar-none flex gap-2 overflow-x-auto pb-2 lg:flex-col lg:overflow-visible lg:pb-0"
						initial={{ opacity: 0, x: -20 }}
						whileInView={{ opacity: 1, x: 0 }}
						viewport={{ once: true, margin: "-80px" }}
						transition={{ duration: 0.5, delay: 0.15 }}
					>
						{platforms.map((platform) => {
							const isActive = active === platform.id;
							return (
								<button
									key={platform.id}
									type="button"
									onClick={() => setActive(platform.id)}
									className={cn(
										"group relative flex shrink-0 cursor-pointer items-center gap-3 rounded-xl px-4 py-3.5 text-left transition-all duration-200",
										isActive
											? "border border-primary/20 bg-card shadow-lg shadow-primary/4"
											: "border border-transparent bg-transparent hover:border-border/40 hover:bg-card/60",
									)}
								>
									<div
										className={cn(
											"flex size-10 shrink-0 items-center justify-center rounded-xl transition-colors",
											isActive
												? "bg-primary/12 text-primary"
												: "bg-muted/60 text-muted-foreground/60 group-hover:bg-muted group-hover:text-muted-foreground",
										)}
									>
										<platform.icon className="size-5" />
									</div>
									<div className="min-w-0">
										<div
											className={cn(
												"font-semibold text-sm transition-colors",
												isActive
													? "text-foreground"
													: "text-muted-foreground group-hover:text-foreground",
											)}
										>
											{platform.name}
										</div>
										<div className="whitespace-nowrap text-muted-foreground/60 text-xs">
											{platform.subtitle}
										</div>
									</div>
									{isActive && (
										<motion.div
											className="absolute top-3 bottom-3 left-0 hidden w-0.75 rounded-full bg-primary lg:block"
											layoutId="platform-indicator"
											transition={{
												type: "spring",
												stiffness: 350,
												damping: 30,
											}}
										/>
									)}
								</button>
							);
						})}

						{/* Sync indicator on desktop */}
						<div className="mt-3 hidden lg:block">
							<SyncIndicator />
						</div>
					</motion.div>

					{/* Mockup display */}
					<motion.div
						className="relative"
						initial={{ opacity: 0, y: 20 }}
						whileInView={{ opacity: 1, y: 0 }}
						viewport={{ once: true, margin: "-80px" }}
						transition={{ duration: 0.5, delay: 0.25 }}
					>
						{/* Layered gradient glow behind the mockup */}
						<div className="absolute -inset-3 -z-10 rounded-3xl bg-linear-to-br from-primary/15 via-primary/4 to-chart-4/12 blur-2xl dark:from-primary/6 dark:via-primary/[0.02] dark:to-chart-4/5" />
						<div className="absolute -inset-1 -z-10 rounded-2xl bg-linear-to-tr from-chart-4/10 via-transparent to-primary/10 blur-md dark:from-chart-4/4 dark:to-primary/4" />

						<div className="relative flex h-75 items-center justify-center rounded-2xl border border-border/40 bg-card/30 p-4 backdrop-blur-sm sm:h-100 sm:p-6 lg:h-120 lg:p-8">
							{/* Active platform screenshot with crossfade */}
							<motion.div
								key={active}
								initial={{ opacity: 0, scale: 0.97 }}
								animate={{ opacity: 1, scale: 1 }}
								transition={{ duration: 0.35, ease: "easeOut" }}
								className="flex h-full w-full items-center justify-center"
							>
								<div
									className={cn(
										"flex max-h-full",
										active === "mobile" &&
											"max-w-60 overflow-hidden rounded-2xl",
									)}
								>
									<img
										src={activeImage}
										alt={`Bittery ${active} app`}
										className={cn(
											"max-h-full object-contain shadow-2xl shadow-black/8 dark:shadow-black/40",
											active === "extension" && "max-w-90 rounded-xl",
											active === "mobile" && "w-full",
											active !== "extension" &&
												active !== "mobile" &&
												"w-full rounded-xl",
										)}
									/>
								</div>
							</motion.div>
						</div>

						{/* Floating badge */}
						<motion.div
							className="absolute -right-3 -bottom-3 flex items-center gap-2 rounded-lg border border-border/60 bg-card px-3 py-2 shadow-black/5 shadow-lg sm:right-4 sm:bottom-4 dark:shadow-black/30"
							initial={{ opacity: 0, scale: 0.8, y: 10 }}
							whileInView={{ opacity: 1, scale: 1, y: 0 }}
							viewport={{ once: true }}
							transition={{ delay: 0.8, type: "spring" }}
						>
							<div className="size-2 animate-pulse rounded-full bg-emerald-500" />
							<span className="font-medium text-[11px] text-muted-foreground">
								End-to-end encrypted
							</span>
						</motion.div>
					</motion.div>

					{/* Sync indicator on mobile */}
					<div className="lg:hidden">
						<SyncIndicator />
					</div>
				</div>
			</div>
		</section>
	);
}
