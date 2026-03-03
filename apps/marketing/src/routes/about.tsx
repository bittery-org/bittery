import { createFileRoute, Link } from "@tanstack/react-router";
import {
	ArrowRight,
	Building2,
	Code2,
	ExternalLink,
	Globe,
	Heart,
	KeyRound,
	Lock,
	MapPin,
	MonitorSmartphone,
	Shield,
	ShieldCheck,
	Users,
} from "lucide-react";
import { motion } from "motion/react";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { signupUrl } from "@/lib/urls";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/about")({
	component: AboutPage,
	head: () => ({
		meta: [
			{ title: "About — Bittery" },
			{
				name: "description",
				content:
					"Learn about Bittery, a zero-knowledge password manager built by qrawall GmbH in Germany.",
			},
		],
	}),
});

const values = [
	{
		icon: ShieldCheck,
		title: "We can't see your passwords",
		description:
			"Your data is scrambled on your device before it ever leaves. Even we can't read your passwords — and that's exactly how it should be.",
		iconBg: "bg-primary/10 text-primary",
	},
	{
		icon: Lock,
		title: "Privacy without compromise",
		description:
			"No tracking. No ads. No selling your data. Privacy isn't a setting you have to remember to turn on — it's just how Bittery works.",
		iconBg: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
	},
	{
		icon: Code2,
		title: "Nothing to hide",
		description:
			"Our entire codebase is public on GitHub. Security experts can review it. Or you can host Bittery on your own server if you prefer.",
		iconBg: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
	},
	{
		icon: Heart,
		title: "Built for real people",
		description:
			"We design for everyone — not just tech experts. If a feature doesn't make your life easier and more secure, we don't build it.",
		iconBg: "bg-pink-500/10 text-pink-600 dark:text-pink-400",
	},
	{
		icon: MonitorSmartphone,
		title: "Works on all your devices",
		description:
			"Phone, laptop, tablet, browser — Bittery keeps your passwords in sync everywhere you go, securely and effortlessly.",
		iconBg: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
	},
	{
		icon: KeyRound,
		title: "Two keys, one vault",
		description:
			"Your password plus a unique Secret Key protect your account. Even if someone guesses one, they still can't get in without the other.",
		iconBg: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
	},
];

const timeline = [
	{
		title: "The problem",
		description:
			"Most password managers ask you to just trust them with your most sensitive data. But trust isn't enough when it comes to your digital life.",
	},
	{
		title: "A better idea",
		description:
			"What if there was a password manager where even the company running it couldn't see your data? One that's open for anyone to inspect, and yours to host if you want?",
	},
	{
		title: "Making it real",
		description:
			"We built Bittery from scratch with security at its core — no shortcuts, no hand-waving. Every piece was designed to keep your data private by default.",
	},
	{
		title: "Where we are today",
		description:
			"Bittery works on your phone, laptop, browser, and desktop. With a growing community helping shape what comes next, we're just getting started.",
	},
];

function AboutPage() {
	return (
		<Layout>
			{/* ─── Hero with image ──────────────────────────────────── */}
			<section className="relative overflow-hidden pt-28 pb-16 sm:pt-36 sm:pb-20">
				{/* Gradient background accent */}
				<div className="pointer-events-none absolute inset-0 overflow-hidden">
					<div className="absolute top-0 right-0 h-150 w-150 translate-x-1/3 -translate-y-1/3 rounded-full bg-primary/4 blur-3xl" />
					<div className="absolute bottom-0 left-0 h-100 w-100 -translate-x-1/3 translate-y-1/3 rounded-full bg-primary/3 blur-3xl" />
				</div>

				<div className="relative mx-auto max-w-5xl px-4">
					<div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
						{/* Text */}
						<motion.div
							initial={{ opacity: 0, y: 20 }}
							animate={{ opacity: 1, y: 0 }}
							transition={{ duration: 0.6, ease: "easeOut" }}
						>
							<div className="mb-4 inline-flex items-center gap-2 rounded-full border border-primary/15 bg-primary/8 px-3 py-1 font-medium text-primary text-xs">
								<Building2 className="size-3.5" />
								About Bittery
							</div>
							<h1 className="font-bold font-display text-2xl tracking-tight sm:text-3xl lg:text-4xl">
								Security you can trust.
								<br />
								<span className="text-primary">Privacy you deserve.</span>
							</h1>
							<p className="mt-4 max-w-lg text-base text-muted-foreground leading-relaxed sm:text-lg">
								Bittery is a password manager that keeps your data completely
								private — even from us. Simple to use, available everywhere, and
								made in Germany by{" "}
								<a
									href="https://qrawall.com/"
									target="_blank"
									rel="noopener noreferrer"
									className="inline-flex items-baseline gap-1 font-medium text-foreground underline decoration-from-font decoration-primary/30 underline-offset-2 transition-colors hover:decoration-primary/60"
								>
									qrawall GmbH
									<ExternalLink className="relative top-px size-3" />
								</a>
								.
							</p>

							<div className="mt-8 flex flex-wrap items-center gap-3">
								<Button size="lg" className="gap-2 rounded-full px-7" asChild>
									<a
										href="https://github.com/bittery-org/bittery"
										target="_blank"
										rel="noopener noreferrer"
									>
										View on GitHub
										<ArrowRight className="size-4" />
									</a>
								</Button>
								<Button
									size="lg"
									variant="outline"
									className="rounded-full px-7"
									asChild
								>
									<Link to="/docs">Read the docs</Link>
								</Button>
							</div>
						</motion.div>

						{/* Image */}
						<motion.div
							className="relative"
							initial={{ opacity: 0, scale: 0.95 }}
							animate={{ opacity: 1, scale: 1 }}
							transition={{ duration: 0.7, delay: 0.15, ease: "easeOut" }}
						>
							<div className="absolute -inset-4 rounded-3xl bg-linear-to-br from-primary/6 via-transparent to-primary/4 blur-2xl" />
							<div className="relative overflow-hidden rounded-2xl border border-border/60 shadow-black/5 shadow-xl dark:shadow-black/20">
								<img
									src="https://images.unsplash.com/photo-1522071820081-009f0129c71c?auto=format&fit=crop&w=1200&q=80"
									alt="Team collaborating around a laptop"
									className="aspect-4/3 w-full object-cover"
									loading="eager"
								/>
								<div className="absolute inset-0 bg-linear-to-t from-background/90 via-background/30 to-transparent" />
								<div className="absolute inset-x-0 bottom-0 p-5">
									<p className="font-display font-semibold text-foreground text-sm drop-shadow-sm">
										Small team, big mission
									</p>
									<p className="mt-0.5 text-muted-foreground text-xs drop-shadow-sm">
										Building the password manager we always wished existed
									</p>
								</div>
							</div>
						</motion.div>
					</div>
				</div>
			</section>

			{/* ─── Mission + story ─────────────────────────────────── */}
			<section className="px-4 py-16 sm:py-20">
				<div className="mx-auto max-w-5xl">
					<motion.div
						className="relative overflow-hidden rounded-2xl border border-border/60 bg-linear-to-br from-card via-card to-primary/3 sm:rounded-3xl"
						initial={{ opacity: 0 }}
						whileInView={{ opacity: 1 }}
						viewport={{ once: true, margin: "-100px" }}
						transition={{ duration: 0.5 }}
					>
						<div className="absolute top-0 right-0 h-64 w-64 translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/4 blur-3xl" />

						<div className="relative grid gap-0 lg:grid-cols-2">
							{/* Image side */}
							<div className="relative min-h-70 sm:min-h-90">
								<img
									src="https://images.unsplash.com/photo-1499750310107-5fef28a66643?auto=format&fit=crop&w=900&q=80"
									alt="Cozy workspace with a laptop and coffee"
									className="absolute inset-0 size-full object-cover"
									loading="lazy"
								/>
								<div className="absolute inset-0 bg-linear-to-r from-transparent to-card/40 max-lg:bg-linear-to-b max-lg:from-transparent max-lg:to-card/80 dark:to-card/60" />
							</div>

							{/* Text side */}
							<div className="relative p-8 sm:p-10 lg:p-12">
								<div className="mb-4 inline-flex items-center gap-2 rounded-full border border-primary/15 bg-primary/8 px-3 py-1 font-medium text-primary text-xs">
									<Shield className="size-3.5" />
									Our mission
								</div>
								<h2 className="font-display text-2xl tracking-tight sm:text-3xl">
									Everyone deserves real privacy
								</h2>
								<p className="mt-4 text-muted-foreground text-sm leading-relaxed sm:text-base">
									We started Bittery because we believe everyone deserves a
									password manager they can actually trust. Not one that just
									says "trust us" — one that proves it.
								</p>
								<p className="mt-3 text-muted-foreground text-sm leading-relaxed sm:text-base">
									With Bittery, your passwords are scrambled on your device
									before they ever leave it. That means we can't see them. We
									can't access them. Not even if we wanted to. That's not a
									feature — it's a promise.
								</p>
								<p className="mt-3 text-muted-foreground text-sm leading-relaxed sm:text-base">
									And because Bittery is open source, anyone can look at how it
									works. No secrets. No hidden tricks. Just honest software you
									can verify yourself.
								</p>
							</div>
						</div>
					</motion.div>
				</div>
			</section>

			{/* ─── Our story timeline ──────────────────────────────── */}
			<section className="px-4 py-16 sm:py-20">
				<div className="mx-auto max-w-5xl">
					<motion.div
						className="mb-12 text-center sm:mb-16"
						initial={{ opacity: 0 }}
						whileInView={{ opacity: 1 }}
						viewport={{ once: true, margin: "-100px" }}
						transition={{ duration: 0.5 }}
					>
						<h2 className="font-display text-3xl tracking-tight sm:text-4xl">
							Our story
						</h2>
						<p className="mx-auto mt-4 max-w-xl text-base text-muted-foreground sm:text-lg">
							How a simple frustration turned into something people use every
							day.
						</p>
					</motion.div>

					<div className="relative">
						{/* Vertical line */}
						<div className="absolute top-0 bottom-0 left-5 w-px bg-border/60 sm:left-1/2 sm:-translate-x-px" />

						<div className="space-y-10 sm:space-y-16">
							{timeline.map((item, i) => (
								<motion.div
									key={item.title}
									className={cn(
										"relative grid gap-6 sm:grid-cols-2 sm:gap-12",
										i % 2 === 0 ? "sm:text-right" : "",
									)}
									initial={{ opacity: 0, y: 16 }}
									whileInView={{ opacity: 1, y: 0 }}
									viewport={{ once: true, margin: "-60px" }}
									transition={{ duration: 0.45, delay: i * 0.08 }}
								>
									{/* Dot */}
									<div className="absolute top-1 left-5 z-10 flex size-2.5 -translate-x-1/2 items-center justify-center sm:left-1/2">
										<div className="size-2.5 rounded-full bg-primary ring-4 ring-background" />
									</div>

									{i % 2 === 0 ? (
										<>
											<div className="pl-12 sm:pr-8 sm:pl-0">
												<h3 className="font-display font-semibold text-base text-foreground sm:text-lg">
													{item.title}
												</h3>
												<p className="mt-2 text-muted-foreground text-sm leading-relaxed">
													{item.description}
												</p>
											</div>
											<div className="hidden sm:block" />
										</>
									) : (
										<>
											<div className="hidden sm:block" />
											<div className="pl-12 sm:pl-8 sm:text-left">
												<h3 className="font-display font-semibold text-base text-foreground sm:text-lg">
													{item.title}
												</h3>
												<p className="mt-2 text-muted-foreground text-sm leading-relaxed">
													{item.description}
												</p>
											</div>
										</>
									)}
								</motion.div>
							))}
						</div>
					</div>
				</div>
			</section>

			{/* ─── Values grid ─────────────────────────────────────── */}
			<section className="px-4 py-16 sm:py-20">
				<div className="mx-auto max-w-5xl">
					<motion.div
						className="mb-12 text-center sm:mb-16"
						initial={{ opacity: 0 }}
						whileInView={{ opacity: 1 }}
						viewport={{ once: true, margin: "-100px" }}
						transition={{ duration: 0.5 }}
					>
						<h2 className="font-display text-3xl tracking-tight sm:text-4xl">
							What we stand for
						</h2>
						<p className="mx-auto mt-4 max-w-xl text-base text-muted-foreground sm:text-lg">
							The principles behind every decision we make.
						</p>
					</motion.div>

					<div className="grid grid-cols-1 gap-3 sm:gap-4 md:grid-cols-3">
						{values.map((value, i) => (
							<motion.div
								key={value.title}
								className="group relative rounded-2xl border border-border/60 bg-card p-5 transition-all duration-300 hover:border-border hover:shadow-black/3 hover:shadow-lg sm:p-6"
								initial={{ opacity: 0, y: 12 }}
								whileInView={{ opacity: 1, y: 0 }}
								viewport={{ once: true, margin: "-80px" }}
								transition={{ duration: 0.4, delay: i * 0.05 }}
							>
								<div
									className={cn(
										"mb-4 flex size-10 items-center justify-center rounded-xl",
										value.iconBg,
									)}
								>
									<value.icon className="size-5" />
								</div>
								<h3 className="mb-1.5 font-semibold text-base">
									{value.title}
								</h3>
								<p className="text-muted-foreground text-sm leading-relaxed">
									{value.description}
								</p>
							</motion.div>
						))}
					</div>
				</div>
			</section>

			{/* ─── Company section ─────────────────────────────────── */}
			<section className="px-4 py-16 sm:py-20">
				<div className="mx-auto max-w-5xl">
					<motion.div
						className="mb-12 text-center sm:mb-16"
						initial={{ opacity: 0 }}
						whileInView={{ opacity: 1 }}
						viewport={{ once: true, margin: "-100px" }}
						transition={{ duration: 0.5 }}
					>
						<h2 className="font-display text-3xl tracking-tight sm:text-4xl">
							The company behind Bittery
						</h2>
						<p className="mx-auto mt-4 max-w-xl text-base text-muted-foreground sm:text-lg">
							Built and maintained by a German software company committed to
							privacy-respecting tools.
						</p>
					</motion.div>

					<div className="grid gap-4 sm:gap-6 md:grid-cols-3">
						{/* qrawall GmbH card — wide */}
						<motion.div
							className="relative overflow-hidden rounded-2xl border border-border/60 bg-card md:col-span-2"
							initial={{ opacity: 0, y: 12 }}
							whileInView={{ opacity: 1, y: 0 }}
							viewport={{ once: true, margin: "-80px" }}
							transition={{ duration: 0.4 }}
						>
							<div className="relative min-h-50 sm:min-h-60">
								<img
									src="https://images.unsplash.com/photo-1467269204594-9661b134dd2b?auto=format&fit=crop&w=1200&q=80"
									alt="German cityscape"
									className="absolute inset-0 size-full object-cover"
									loading="lazy"
								/>
								<div className="absolute inset-0 bg-linear-to-t from-card via-card/60 to-transparent" />
							</div>
							<div className="relative -mt-16 p-6 sm:p-8">
								<div className="mb-3 inline-flex items-center gap-2 rounded-full border border-primary/15 bg-primary/8 px-3 py-1 font-medium text-primary text-xs">
									<Building2 className="size-3.5" />
									qrawall GmbH
								</div>
								<h3 className="font-display font-semibold text-lg sm:text-xl">
									Made in Germany
								</h3>
								<p className="mt-2 max-w-lg text-muted-foreground text-sm leading-relaxed">
									Bittery is developed and maintained by{" "}
									<a
										href="https://qrawall.com/"
										target="_blank"
										rel="noopener noreferrer"
										className="font-medium text-foreground underline decoration-primary/30 underline-offset-2 transition-colors hover:decoration-primary/60"
									>
										qrawall GmbH
									</a>
									, a software company based in Germany. We're focused on
									building tools that respect user privacy and follow security
									best practices — operating under EU data protection
									regulations, including GDPR.
								</p>
								<a
									href="https://qrawall.com/"
									target="_blank"
									rel="noopener noreferrer"
									className="mt-4 inline-flex items-center gap-1.5 font-medium text-primary text-sm transition-colors hover:text-primary/80"
								>
									Visit qrawall.com
									<ExternalLink className="size-3.5" />
								</a>
							</div>
						</motion.div>

						{/* Side cards */}
						<div className="grid gap-4 sm:gap-6">
							<motion.div
								className="rounded-2xl border border-border/60 bg-card p-5 sm:p-6"
								initial={{ opacity: 0, y: 12 }}
								whileInView={{ opacity: 1, y: 0 }}
								viewport={{ once: true, margin: "-80px" }}
								transition={{ duration: 0.4, delay: 0.08 }}
							>
								<div className="mb-4 flex size-10 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
									<MapPin className="size-5" />
								</div>
								<h3 className="mb-1.5 font-semibold text-base">
									EU jurisdiction
								</h3>
								<p className="text-muted-foreground text-sm leading-relaxed">
									Operating under GDPR — one of the strictest privacy frameworks
									in the world. Your data enjoys European-level protection.
								</p>
							</motion.div>

							<motion.div
								className="rounded-2xl border border-border/60 bg-card p-5 sm:p-6"
								initial={{ opacity: 0, y: 12 }}
								whileInView={{ opacity: 1, y: 0 }}
								viewport={{ once: true, margin: "-80px" }}
								transition={{ duration: 0.4, delay: 0.16 }}
							>
								<div className="mb-4 flex size-10 items-center justify-center rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400">
									<Users className="size-5" />
								</div>
								<h3 className="mb-1.5 font-semibold text-base">
									Community-driven
								</h3>
								<p className="text-muted-foreground text-sm leading-relaxed">
									Feature requests, bug reports, and contributions from the
									community shape the future of Bittery.
								</p>
							</motion.div>
						</div>
					</div>
				</div>
			</section>

			{/* ─── CTA ─────────────────────────────────────────────── */}
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
							<h2 className="font-display text-2xl tracking-tight sm:text-3xl lg:text-4xl">
								Ready to take back your privacy?
							</h2>
							<p className="mx-auto mt-4 max-w-md text-base text-muted-foreground sm:text-lg">
								Join the people who decided their passwords deserve better. Free
								to start, no credit card needed.
							</p>
							<div className="mt-8 flex flex-wrap items-center justify-center gap-3">
								<Button size="lg" className="gap-2 rounded-full px-7" asChild>
									<a href={signupUrl()}>
										Get started free
										<ArrowRight className="size-4" />
									</a>
								</Button>
								<Button
									size="lg"
									variant="outline"
									className="gap-2 rounded-full px-7"
									asChild
								>
									<a
										href="https://github.com/bittery-org/bittery"
										target="_blank"
										rel="noopener noreferrer"
									>
										<Globe className="size-4" />
										View source
									</a>
								</Button>
							</div>
						</div>
					</div>
				</motion.div>
			</section>
		</Layout>
	);
}
