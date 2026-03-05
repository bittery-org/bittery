import { createFileRoute, Link } from "@tanstack/react-router";
import {
	ArrowRight,
	CheckCircle2,
	Circle,
	Clock,
	MapIcon,
	Rocket,
	Sparkles,
} from "lucide-react";
import { motion } from "motion/react";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/roadmap")({
	component: RoadmapPage,
	head: () => ({
		meta: [
			{ title: "Roadmap — Bittery" },
			{
				name: "description",
				content:
					"See what's coming next for Bittery. Our transparent roadmap shows what we're building, what's done, and what's planned.",
			},
		],
	}),
});

// ─── Status helpers ──────────────────────────────────────────────────
// Change status to update the badge across the entire page.

type ItemStatus = "done" | "in-progress" | "planned";

interface RoadmapItem {
	title: string;
	description: string;
	status: ItemStatus;
}

interface RoadmapCategory {
	title: string;
	description: string;
	items: RoadmapItem[];
}

// ─── Roadmap data ────────────────────────────────────────────────────
// Edit this array to update the roadmap. Each category contains items
// with a status of "done", "in-progress", or "planned".

const roadmapCategories: RoadmapCategory[] = [
	{
		title: "Critical for Launch",
		description: "Core features required before our public release.",
		items: [
			{
				title: "iOS Autofill",
				description:
					"Native iOS autofill integration so Bittery works seamlessly on iPhone and iPad.",
				status: "planned",
			},
			{
				title: "Billing",
				description: "Plans, payment processing, and upgrade/downgrade flows.",
				status: "done",
			},
			{
				title: "Onboarding",
				description: "First-run onboarding flow and import handoff.",
				status: "done",
			},
			{
				title: "Device Setup",
				description:
					"Account selection, setup QR codes, and deep-link prefill across platforms.",
				status: "in-progress",
			},
			{
				title: "Account Recovery",
				description:
					"Recovery Kit PDF generation and forgotten master password flow.",
				status: "done",
			},
			{
				title: "Export",
				description:
					"Full data export so you're never locked in — your data is yours.",
				status: "in-progress",
			},
			{
				title: "Security Audit",
				description:
					"Comprehensive third-party security audit including session revocation enforcement.",
				status: "in-progress",
			},
			{
				title: "Session Revocation",
				description:
					"Enforce token revocation across all clients — Desktop, Mobile, and Extension.",
				status: "done",
			},
			{
				title: "Master Password Re-Auth",
				description:
					"Periodic master password re-authentication for sensitive operations.",
				status: "done",
			},
		],
	},
	{
		title: "Important Features",
		description: "High-impact features that make Bittery even better.",
		items: [
			{
				title: "Emergency Access",
				description:
					"Designate trusted contacts who can access your vault after a period of inactivity.",
				status: "planned",
			},
			{
				title: "Password History",
				description:
					"View and restore previous versions of your passwords with full encryption.",
				status: "done",
			},
			{
				title: "Travel Mode",
				description:
					"Hide specific vaults during border crossings to protect sensitive data.",
				status: "planned",
			},
			{
				title: "Secure File Storage",
				description: "Encrypted file attachments for any item in your vault.",
				status: "done",
			},
			{
				title: "Import",
				description:
					"Bring your data from other password managers into Bittery easily.",
				status: "done",
			},
			{
				title: "Internationalization",
				description: "Multi-language support starting with English and German.",
				status: "in-progress",
			},
		],
	},
	{
		title: "Team & Business",
		description: "Features for teams and organizations.",
		items: [
			{
				title: "Team Management",
				description:
					"Invite members, manage settings, and control vault access.",
				status: "done",
			},
			{
				title: "Sharing",
				description: "Securely share passwords and items with team members.",
				status: "done",
			},
			{
				title: "Offboarding Flow",
				description:
					"Cleanly revoke access on team removal and mark shared passwords as compromised.",
				status: "planned",
			},
		],
	},
	{
		title: "Planned for Later",
		description: "On our radar for future releases.",
		items: [
			{
				title: "SSH Key Management",
				description:
					"Manage and use SSH keys directly from Bittery — great for developers.",
				status: "planned",
			},
			{
				title: "CLI & Dev Tools",
				description:
					"Access secrets from CI/CD pipelines, scripts, and automation tools.",
				status: "planned",
			},
			{
				title: "More Item Types",
				description:
					"Server logins, software licenses, passports, and other secure item categories.",
				status: "planned",
			},
		],
	},
];

// ─── Status config ───────────────────────────────────────────────────

const statusConfig: Record<
	ItemStatus,
	{
		label: string;
		icon: typeof CheckCircle2;
		className: string;
		dotClass: string;
	}
> = {
	done: {
		label: "Done",
		icon: CheckCircle2,
		className:
			"bg-emerald-500/10 text-emerald-700 border-emerald-500/20 dark:text-emerald-400",
		dotClass: "bg-emerald-500",
	},
	"in-progress": {
		label: "In Progress",
		icon: Clock,
		className:
			"bg-amber-500/10 text-amber-700 border-amber-500/20 dark:text-amber-400",
		dotClass: "bg-amber-500",
	},
	planned: {
		label: "Planned",
		icon: Circle,
		className: "bg-muted text-muted-foreground border-border",
		dotClass: "bg-muted-foreground/40",
	},
};

// ─── Stats ───────────────────────────────────────────────────────────

function getRoadmapStats() {
	const all = roadmapCategories.flatMap((c) => c.items);
	return {
		total: all.length,
		done: all.filter((i) => i.status === "done").length,
		inProgress: all.filter((i) => i.status === "in-progress").length,
		planned: all.filter((i) => i.status === "planned").length,
	};
}

// ─── Component ───────────────────────────────────────────────────────

function StatusBadge({ status }: { status: ItemStatus }) {
	const config = statusConfig[status];
	const Icon = config.icon;
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-medium text-xs",
				config.className,
			)}
		>
			<Icon className="size-3" />
			{config.label}
		</span>
	);
}

function ProgressBar() {
	const stats = getRoadmapStats();
	const donePercent = (stats.done / stats.total) * 100;
	const progressPercent = ((stats.done + stats.inProgress) / stats.total) * 100;

	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between text-sm">
				<span className="text-muted-foreground">Overall progress</span>
				<span className="font-medium tabular-nums">
					{stats.done} of {stats.total} complete
				</span>
			</div>
			<div className="h-2 overflow-hidden rounded-full bg-muted">
				<div className="relative h-full">
					<motion.div
						className="absolute inset-y-0 left-0 rounded-full bg-amber-400/50 dark:bg-amber-500/30"
						initial={{ width: 0 }}
						animate={{ width: `${progressPercent}%` }}
						transition={{ duration: 0.8, delay: 0.2, ease: "easeOut" }}
					/>
					<motion.div
						className="absolute inset-y-0 left-0 rounded-full bg-emerald-500"
						initial={{ width: 0 }}
						animate={{ width: `${donePercent}%` }}
						transition={{ duration: 0.8, ease: "easeOut" }}
					/>
				</div>
			</div>
			<div className="flex gap-4 text-xs">
				<span className="flex items-center gap-1.5">
					<span className="size-2 rounded-full bg-emerald-500" />
					<span className="text-muted-foreground">{stats.done} Done</span>
				</span>
				<span className="flex items-center gap-1.5">
					<span className="size-2 rounded-full bg-amber-400 dark:bg-amber-500/60" />
					<span className="text-muted-foreground">
						{stats.inProgress} In Progress
					</span>
				</span>
				<span className="flex items-center gap-1.5">
					<span className="size-2 rounded-full bg-muted-foreground/30" />
					<span className="text-muted-foreground">{stats.planned} Planned</span>
				</span>
			</div>
		</div>
	);
}

function RoadmapPage() {
	return (
		<Layout>
			{/* ─── Hero ──────────────────────────────────────────── */}
			<section className="relative overflow-hidden pt-28 pb-16 sm:pt-36 sm:pb-20">
				<div className="pointer-events-none absolute inset-0 overflow-hidden">
					<div className="absolute top-0 right-0 h-150 w-150 translate-x-1/3 -translate-y-1/3 rounded-full bg-primary/4 blur-3xl" />
					<div className="absolute bottom-0 left-0 h-100 w-100 -translate-x-1/3 translate-y-1/3 rounded-full bg-primary/3 blur-3xl" />
				</div>

				<div className="relative mx-auto max-w-5xl px-4">
					<motion.div
						className="mx-auto max-w-2xl text-center"
						initial={{ opacity: 0, y: 20 }}
						animate={{ opacity: 1, y: 0 }}
						transition={{ duration: 0.6, ease: "easeOut" }}
					>
						<div className="mb-4 inline-flex items-center gap-2 rounded-full border border-primary/15 bg-primary/8 px-3 py-1 font-medium text-primary text-xs">
							<MapIcon className="size-3.5" />
							Product Roadmap
						</div>
						<h1 className="font-bold font-display text-3xl tracking-tight sm:text-4xl lg:text-5xl">
							See what we're <span className="text-primary">building next</span>
						</h1>
						<p className="mt-4 text-base text-muted-foreground leading-relaxed sm:text-lg">
							Transparency is one of our core values. Here's exactly what we're
							working on, what's done, and what's coming next.
						</p>
					</motion.div>

					{/* Progress bar */}
					<motion.div
						className="mx-auto mt-10 max-w-lg"
						initial={{ opacity: 0, y: 12 }}
						animate={{ opacity: 1, y: 0 }}
						transition={{ duration: 0.5, delay: 0.2, ease: "easeOut" }}
					>
						<div className="rounded-2xl border border-border/60 bg-card p-5 sm:p-6">
							<ProgressBar />
						</div>
					</motion.div>
				</div>
			</section>

			{/* ─── Roadmap categories ────────────────────────────── */}
			<section className="px-4 pb-16 sm:pb-20">
				<div className="mx-auto max-w-5xl space-y-12 sm:space-y-16">
					{roadmapCategories.map((category, categoryIndex) => (
						<motion.div
							key={category.title}
							initial={{ opacity: 0, y: 16 }}
							whileInView={{ opacity: 1, y: 0 }}
							viewport={{ once: true, margin: "-60px" }}
							transition={{
								duration: 0.45,
								delay: categoryIndex * 0.06,
							}}
						>
							<div className="mb-6">
								<h2 className="font-display text-xl tracking-tight sm:text-2xl">
									{category.title}
								</h2>
								<p className="mt-1.5 text-muted-foreground text-sm sm:text-base">
									{category.description}
								</p>
							</div>

							<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
								{category.items.map((item, i) => {
									const config = statusConfig[item.status];
									return (
										<motion.div
											key={item.title}
											className={cn(
												"group relative rounded-xl border bg-card p-4 transition-all duration-300 hover:shadow-black/3 hover:shadow-lg sm:p-5",
												item.status === "done"
													? "border-emerald-500/15 hover:border-emerald-500/30"
													: item.status === "in-progress"
														? "border-amber-500/15 hover:border-amber-500/30"
														: "border-border/60 hover:border-border",
											)}
											initial={{ opacity: 0, y: 10 }}
											whileInView={{ opacity: 1, y: 0 }}
											viewport={{ once: true, margin: "-40px" }}
											transition={{
												duration: 0.35,
												delay: i * 0.04,
											}}
										>
											<div className="mb-3 flex items-start justify-between gap-2">
												<h3 className="font-semibold text-sm sm:text-base">
													{item.title}
												</h3>
												<StatusBadge status={item.status} />
											</div>
											<p className="text-muted-foreground text-xs leading-relaxed sm:text-sm">
												{item.description}
											</p>

											{/* Subtle status indicator line at bottom */}
											<div
												className={cn(
													"absolute inset-x-4 bottom-0 h-0.5 rounded-full opacity-0 transition-opacity duration-300 group-hover:opacity-100",
													config.dotClass,
												)}
											/>
										</motion.div>
									);
								})}
							</div>
						</motion.div>
					))}
				</div>
			</section>

			{/* ─── CTA ───────────────────────────────────────────── */}
			<section className="px-4 py-16 sm:py-24">
				<motion.div
					className="mx-auto max-w-5xl"
					initial={{ opacity: 0, y: 16 }}
					whileInView={{ opacity: 1, y: 0 }}
					viewport={{ once: true, margin: "-80px" }}
					transition={{ duration: 0.5 }}
				>
					<div className="relative overflow-hidden rounded-2xl border border-border/60 bg-linear-to-br from-card via-card to-primary/3 p-8 text-center sm:rounded-3xl sm:p-14">
						<div className="absolute top-0 left-1/2 h-64 w-64 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/5 blur-3xl" />

						<div className="relative">
							<div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-primary/10">
								<Sparkles className="size-6 text-primary" />
							</div>
							<h2 className="font-display text-2xl tracking-tight sm:text-3xl">
								Want to shape what's next?
							</h2>
							<p className="mx-auto mt-4 max-w-md text-base text-muted-foreground sm:text-lg">
								Bittery is open source. Join the community, share your ideas, or
								contribute directly on GitHub.
							</p>
							<div className="mt-8 flex flex-wrap items-center justify-center gap-3">
								<Button size="lg" className="gap-2 rounded-full px-7" asChild>
									<a
										href="https://github.com/bittery-org/bittery"
										target="_blank"
										rel="noopener noreferrer"
									>
										<Rocket className="size-4" />
										Contribute on GitHub
									</a>
								</Button>
								<Button
									size="lg"
									variant="outline"
									className="gap-2 rounded-full px-7"
									asChild
								>
									<Link to="/contact">
										Share feedback
										<ArrowRight className="size-4" />
									</Link>
								</Button>
							</div>
						</div>
					</div>
				</motion.div>
			</section>
		</Layout>
	);
}
