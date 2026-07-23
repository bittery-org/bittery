import { createFileRoute } from "@tanstack/react-router";
import { Check, Clock } from "lucide-react";
import { motion } from "motion/react";
import { ArrowLink, PrimaryCta } from "@/components/landing/cta-button";
import { seo } from "@/lib/seo";
import { billingMarketingEnabled } from "@/lib/urls";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/roadmap")({
	component: RoadmapPage,
	head: () => ({
		meta: seo({
			title: "Roadmap — Bittery",
			description:
				"See what's coming next for Bittery. Our transparent roadmap shows what we're building, what's done, and what's planned.",
		}),
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
				status: "done",
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
				status: "done",
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
				status: "done",
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

// ─── Timeline config ─────────────────────────────────────────────────
// Keyed by ItemStatus so adding a status fails type-checking here
// instead of rendering an unstyled group.

interface StatusGroupConfig {
	title: string;
	tagline: string;
	tagLabel: string;
	spineClass: string;
	cardClass: string;
	entryDotClass: string;
	tagClass: string;
}

const statusGroups: Record<ItemStatus, StatusGroupConfig> = {
	done: {
		title: "Shipped",
		tagline: "Done, tested, and live in the product today.",
		tagLabel: "Shipped",
		spineClass:
			"bg-linear-to-b from-success/50 via-success/40 to-success/30 shadow-[0_0_8px_color-mix(in_oklab,var(--color-success)_35%,transparent)]",
		cardClass: "bg-card",
		entryDotClass:
			"bg-success shadow-[0_0_6px_color-mix(in_oklab,var(--color-success)_60%,transparent)]",
		tagClass: "border-success/25 bg-success/10 text-success",
	},
	"in-progress": {
		title: "Building now",
		tagline: "Actively in development, on the bench right now.",
		tagLabel: "Building",
		spineClass:
			"bg-linear-to-b from-success/30 via-warning/45 to-warning/30 shadow-[0_0_8px_color-mix(in_oklab,var(--color-warning)_30%,transparent)]",
		cardClass: "bg-card",
		entryDotClass:
			"animate-pulse bg-warning shadow-[0_0_6px_color-mix(in_oklab,var(--color-warning)_55%,transparent)]",
		tagClass: "border-warning/25 bg-warning/10 text-warning",
	},
	planned: {
		title: "Planned",
		tagline: "Committed and queued — in rough priority order.",
		tagLabel: "Planned",
		spineClass: "bg-linear-to-b from-warning/25 via-border to-transparent",
		cardClass: "bg-background",
		entryDotClass: "border-[1.5px] border-muted-foreground/40 bg-background",
		tagClass: "border-border bg-foreground/4 text-muted-foreground",
	},
};

const STATUS_ORDER: readonly ItemStatus[] = ["done", "in-progress", "planned"];

// ─── Stats & grouping ────────────────────────────────────────────────

function getVisibleRoadmapCategories() {
	if (billingMarketingEnabled()) {
		return roadmapCategories;
	}
	return roadmapCategories.map((category) => ({
		...category,
		items: category.items.filter((item) => item.title !== "Billing"),
	}));
}

function getRoadmapStats(categories: RoadmapCategory[]) {
	const all = categories.flatMap((c) => c.items);
	return {
		total: all.length,
		done: all.filter((i) => i.status === "done").length,
		inProgress: all.filter((i) => i.status === "in-progress").length,
		planned: all.filter((i) => i.status === "planned").length,
	};
}

interface TimelineEntry extends RoadmapItem {
	category: string;
}

function getTimelineGroups(categories: RoadmapCategory[]) {
	const entries: TimelineEntry[] = categories.flatMap((category) =>
		category.items.map((item) => ({ ...item, category: category.title })),
	);
	return STATUS_ORDER.map((status) => ({
		status,
		entries: entries.filter((entry) => entry.status === status),
	})).filter((group) => group.entries.length > 0);
}

// ─── Motion helpers ──────────────────────────────────────────────────

const reveal = (delay: number) => ({
	initial: { opacity: 0, y: 14 },
	animate: { opacity: 1, y: 0 },
	transition: { duration: 0.7, delay, ease: [0.16, 1, 0.3, 1] as const },
});

const riseInView = (delay = 0) => ({
	initial: { opacity: 0, y: 14 },
	whileInView: { opacity: 1, y: 0 },
	viewport: { once: true, margin: "-40px" } as const,
	transition: { duration: 0.6, delay, ease: [0.16, 1, 0.3, 1] as const },
});

// ─── Pieces ──────────────────────────────────────────────────────────

function MomentumStrip({ categories }: { categories: RoadmapCategory[] }) {
	const stats = getRoadmapStats(categories);
	const donePercent = stats.total ? (stats.done / stats.total) * 100 : 0;
	const activePercent = stats.total
		? ((stats.done + stats.inProgress) / stats.total) * 100
		: 0;

	return (
		<section
			aria-label="Roadmap progress"
			className="rounded-2xl border bg-card p-5 text-left sm:px-6"
		>
			<div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
				<span className="font-semibold text-[26px] tabular-nums tracking-[-0.03em]">
					{stats.done}{" "}
					<span className="font-medium text-muted-foreground">
						/ {stats.total}
					</span>
				</span>
				<span className="text-[13px] text-muted-foreground">
					features shipped
				</span>
				<span className="ml-auto font-semibold text-[12.5px] text-success tabular-nums">
					{Math.round(donePercent)}% complete
				</span>
			</div>

			<div className="relative mt-3.5 h-1.5 overflow-hidden rounded-full bg-foreground/6">
				<motion.span
					aria-hidden
					className="absolute inset-y-0 left-0 rounded-full bg-warning/35"
					initial={{ width: 0 }}
					animate={{ width: `${activePercent}%` }}
					transition={{ duration: 1, delay: 0.55, ease: [0.16, 1, 0.3, 1] }}
				/>
				<motion.span
					aria-hidden
					className="absolute inset-y-0 left-0 rounded-full bg-linear-to-r from-success/70 to-success shadow-[0_0_12px_color-mix(in_oklab,var(--color-success)_50%,transparent)]"
					initial={{ width: 0 }}
					animate={{ width: `${donePercent}%` }}
					transition={{ duration: 1, delay: 0.4, ease: [0.16, 1, 0.3, 1] }}
				/>
			</div>

			<div className="mt-3 flex flex-wrap gap-x-4.5 gap-y-1.5 text-[12px] text-muted-foreground">
				<span className="inline-flex items-center gap-1.5">
					<span
						aria-hidden
						className="size-[7px] rounded-full bg-success shadow-[0_0_6px_color-mix(in_oklab,var(--color-success)_60%,transparent)]"
					/>
					<span className="font-semibold tabular-nums">{stats.done}</span>{" "}
					Shipped
				</span>
				<span className="inline-flex items-center gap-1.5">
					<span
						aria-hidden
						className="size-[7px] rounded-full bg-warning shadow-[0_0_6px_color-mix(in_oklab,var(--color-warning)_50%,transparent)]"
					/>
					<span className="font-semibold tabular-nums">{stats.inProgress}</span>{" "}
					Building now
				</span>
				<span className="inline-flex items-center gap-1.5">
					<span
						aria-hidden
						className="size-[7px] rounded-full bg-muted-foreground/30"
					/>
					<span className="font-semibold tabular-nums">{stats.planned}</span>{" "}
					Planned
				</span>
			</div>
		</section>
	);
}

function GroupNode({ status }: { status: ItemStatus }) {
	if (status === "planned") {
		return (
			<span
				aria-hidden
				className="absolute top-0.5 -left-10 size-6 rounded-full border border-dashed border-muted-foreground/40 bg-background"
			/>
		);
	}
	const isBuilding = status === "in-progress";
	const Icon = isBuilding ? Clock : Check;
	return (
		<span
			aria-hidden
			className={cn(
				"absolute top-0.5 -left-10 grid size-6 place-items-center rounded-full bg-background",
				isBuilding
					? "text-warning shadow-[0_0_0_1.5px_color-mix(in_oklab,var(--color-warning)_60%,transparent),0_0_16px_color-mix(in_oklab,var(--color-warning)_40%,transparent)]"
					: "text-success shadow-[0_0_0_1.5px_color-mix(in_oklab,var(--color-success)_60%,transparent),0_0_16px_color-mix(in_oklab,var(--color-success)_45%,transparent)]",
			)}
		>
			{isBuilding && (
				<span
					aria-hidden
					className="absolute inset-0 animate-pulse rounded-full shadow-[0_0_14px_color-mix(in_oklab,var(--color-warning)_55%,transparent)]"
				/>
			)}
			<Icon className="size-3" />
		</span>
	);
}

function CategoryChip({ category }: { category: string }) {
	return (
		<span
			className={cn(
				"whitespace-nowrap rounded-[5px] border bg-foreground/3 px-1.5 py-px font-medium text-[10.5px] text-muted-foreground",
				category === "Critical for Launch" &&
					"border-primary/25 bg-primary/8 text-primary",
			)}
		>
			{category}
		</span>
	);
}

function StatusTag({ status }: { status: ItemStatus }) {
	const config = statusGroups[status];
	return (
		<span
			className={cn(
				"inline-flex flex-none items-center gap-1.5 rounded-full border px-2 py-0.5 font-semibold text-[10.5px] uppercase tracking-[0.04em]",
				config.tagClass,
			)}
		>
			<span
				aria-hidden
				className={cn(
					"size-[5px] rounded-full bg-current",
					status === "in-progress" && "animate-pulse",
				)}
			/>
			{config.tagLabel}
		</span>
	);
}

// ─── Page ────────────────────────────────────────────────────────────

function RoadmapPage() {
	const visibleRoadmapCategories = getVisibleRoadmapCategories();
	const timelineGroups = getTimelineGroups(visibleRoadmapCategories);

	return (
		<>
			{/* ─── Hero — public build log ───────────────────────── */}
			<section className="relative overflow-hidden pt-32 pb-14 text-center sm:pt-40 sm:pb-16">
				<div
					aria-hidden
					className="pointer-events-none absolute inset-x-[-20%] top-[-40%] h-[640px] bg-[radial-gradient(46%_58%_at_50%_42%,color-mix(in_oklab,var(--color-primary-deep)_9%,transparent),transparent_70%)] dark:bg-[radial-gradient(46%_58%_at_50%_42%,color-mix(in_oklab,var(--color-primary-deep)_15%,transparent),transparent_70%)]"
				/>
				<div className="relative mx-auto max-w-3xl px-4">
					<motion.div
						{...reveal(0.05)}
						className="inline-flex items-center gap-2 rounded-full border border-border-strong bg-foreground/3 px-3 py-1.5 font-medium text-[12.5px] text-muted-foreground"
					>
						<span
							aria-hidden
							className="size-1.5 animate-pulse rounded-full bg-success shadow-[0_0_8px_color-mix(in_oklab,var(--color-success)_80%,transparent)]"
						/>
						Public build log — updated as we ship
					</motion.div>

					<motion.h1
						{...reveal(0.13)}
						className="mx-auto mt-5 max-w-[16ch] font-semibold text-[40px] leading-[1.04] tracking-[-0.045em] sm:text-[56px]"
					>
						Watch Bittery{" "}
						<em className="bg-linear-to-r from-primary to-primary-deep bg-clip-text text-transparent not-italic">
							get built
						</em>
						.
					</motion.h1>

					<motion.p
						{...reveal(0.21)}
						className="mx-auto mt-5 max-w-[52ch] text-[16.5px] text-muted-foreground leading-relaxed"
					>
						Transparency is one of our core values, so the roadmap is public.
						This is exactly what has shipped, what we're building right now, and
						what's next — no vaporware, no "coming soon" forever.
					</motion.p>

					<motion.div {...reveal(0.29)} className="mx-auto mt-10 max-w-xl">
						<MomentumStrip categories={visibleRoadmapCategories} />
					</motion.div>
				</div>
			</section>

			{/* ─── Shipping timeline ─────────────────────────────── */}
			<section className="px-4 pt-8 pb-10 sm:pt-10">
				<div className="mx-auto max-w-[820px]">
					{timelineGroups.map((group) => {
						const config = statusGroups[group.status];
						return (
							<section key={group.status} className="relative pt-7 pb-2 pl-10">
								<span
									aria-hidden
									className={cn(
										"absolute top-0 bottom-0 left-[11px] w-0.5 rounded-full",
										config.spineClass,
									)}
								/>

								<motion.div
									{...riseInView()}
									className="relative mb-4.5 flex flex-wrap items-baseline gap-x-3 gap-y-1"
								>
									<GroupNode status={group.status} />
									<h2 className="font-semibold text-[21px] tracking-[-0.03em]">
										{config.title}
									</h2>
									<span className="text-[12.5px] text-muted-foreground tabular-nums">
										{group.entries.length}{" "}
										{group.entries.length === 1 ? "feature" : "features"}
									</span>
									<p className="ml-auto hidden max-w-[30ch] text-right text-[13px] text-muted-foreground sm:block">
										{config.tagline}
									</p>
								</motion.div>

								<div className="space-y-2.5">
									{group.entries.map((entry, i) => (
										<motion.article
											key={entry.title}
											{...riseInView(Math.min(i * 0.045, 0.27))}
											className={cn(
												"relative rounded-xl border px-4 py-3.5 transition-colors duration-150 hover:border-border-strong sm:px-5",
												config.cardClass,
											)}
										>
											<span
												aria-hidden
												className="absolute top-6 -left-[29px] h-px w-5 bg-border"
											/>
											<span
												aria-hidden
												className={cn(
													"absolute top-[21px] -left-8 size-[7px] rounded-full",
													config.entryDotClass,
												)}
											/>

											<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
												<h3 className="font-semibold text-[14.5px] tracking-[-0.015em]">
													{entry.title}
												</h3>
												<CategoryChip category={entry.category} />
												<span className="ml-auto">
													<StatusTag status={entry.status} />
												</span>
											</div>
											<p className="mt-1 max-w-[62ch] text-[13px] text-muted-foreground leading-relaxed">
												{entry.description}
											</p>
										</motion.article>
									))}
								</div>
							</section>
						);
					})}
				</div>
			</section>

			{/* ─── CTA ───────────────────────────────────────────── */}
			<section className="relative overflow-hidden px-4 py-24 text-center sm:py-28">
				<div
					aria-hidden
					className="pointer-events-none absolute inset-x-[-20%] bottom-[-60%] h-[560px] bg-[radial-gradient(46%_58%_at_50%_50%,color-mix(in_oklab,var(--color-primary-deep)_10%,transparent),transparent_70%)] dark:bg-[radial-gradient(46%_58%_at_50%_50%,color-mix(in_oklab,var(--color-primary-deep)_16%,transparent),transparent_70%)]"
				/>
				<motion.div
					initial={{ opacity: 0, y: 16 }}
					whileInView={{ opacity: 1, y: 0 }}
					viewport={{ once: true, margin: "-80px" }}
					transition={{ duration: 0.6 }}
					className="relative mx-auto max-w-2xl"
				>
					<h2 className="font-semibold text-[32px] tracking-[-0.04em] sm:text-[44px]">
						Want to shape what's next?
					</h2>
					<p className="mx-auto mt-4 max-w-[46ch] text-[16px] text-muted-foreground">
						Bittery is open source under the AGPLv3 and GPLv3. Join the
						community, share your ideas, or contribute directly on GitHub.
					</p>
					<div className="mt-8 flex flex-wrap items-center justify-center gap-5">
						<PrimaryCta
							href="https://github.com/bittery-org/bittery"
							size="lg"
							target="_blank"
							rel="noopener noreferrer"
						>
							Contribute on GitHub
						</PrimaryCta>
						<ArrowLink href="/contact">Share feedback</ArrowLink>
					</div>
				</motion.div>
			</section>
		</>
	);
}
