import {
	ArrowRight,
	Building2,
	Clock,
	Github,
	Globe,
	Mail,
	MapPin,
	MessageSquare,
	Shield,
} from "lucide-react";
import { motion } from "motion/react";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Layout } from "@/components/layout";
import { signupUrl } from "@/lib/urls";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/contact")({
	component: ContactPage,
	head: () => ({
		meta: [
			{ title: "Contact — Bittery" },
			{
				name: "description",
				content:
					"Get in touch with the Bittery team. Reach out for support, partnerships, security reports, or general questions.",
			},
		],
	}),
});

const contactChannels = [
	{
		icon: Mail,
		title: "Email us",
		description:
			"For general questions, partnerships, or anything else — drop us a line and we'll get back to you.",
		action: "hello@bittery.com",
		href: "mailto:hello@bittery.com",
		iconBg: "bg-primary/10 text-primary",
	},
	{
		icon: Shield,
		title: "Security reports",
		description:
			"Found a vulnerability? We take security seriously. Please report it responsibly and we'll respond quickly.",
		action: "security@bittery.com",
		href: "mailto:security@bittery.com",
		iconBg: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
	},
	{
		icon: Github,
		title: "GitHub Issues",
		description:
			"Bug reports, feature requests, or contributions — our GitHub is the best place for technical discussions.",
		action: "Open an issue",
		href: "https://github.com/bittery-org/bittery/issues",
		external: true,
		iconBg: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
	},
	{
		icon: MessageSquare,
		title: "Community",
		description:
			"Join the conversation with other Bittery users and contributors. Get help, share ideas, and connect.",
		action: "Join discussions",
		href: "https://github.com/bittery-org/bittery/discussions",
		external: true,
		iconBg: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
	},
];

const faqs = [
	{
		question: "How fast do you respond?",
		answer:
			"We aim to respond to all inquiries within 1–2 business days. Security reports are prioritized and typically addressed within 24 hours.",
	},
	{
		question: "Where should I report a bug?",
		answer:
			"For bugs and technical issues, please open a GitHub issue. This helps us track, discuss, and resolve problems transparently.",
	},
	{
		question: "Do you offer enterprise plans?",
		answer:
			"We're working on plans for teams and organizations. If you're interested, reach out via email and we'll keep you in the loop.",
	},
	{
		question: "Can I contribute to Bittery?",
		answer:
			"Absolutely! Bittery is open source. Check out our GitHub repository for contribution guidelines, or open a discussion to suggest ideas.",
	},
];

function ContactPage() {
	return (
		<Layout>
			{/* ─── Hero ─────────────────────────────────────────────── */}
			<section className="relative overflow-hidden pt-28 pb-16 sm:pt-36 sm:pb-20">
				{/* Gradient background accent */}
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
							<Mail className="size-3.5" />
							Get in touch
						</div>
						<h1 className="font-bold font-display text-3xl tracking-tight sm:text-4xl lg:text-5xl">
							We'd love to hear
							<br />
							<span className="text-primary">from you.</span>
						</h1>
						<p className="mx-auto mt-4 max-w-lg text-base text-muted-foreground leading-relaxed sm:text-lg">
							Whether you have a question, found a bug, or just want to say
							hi — there are plenty of ways to reach us.
						</p>
					</motion.div>
				</div>
			</section>

			{/* ─── Contact channels ────────────────────────────────── */}
			<section className="px-4 py-16 sm:py-20">
				<div className="mx-auto max-w-5xl">
					<div className="grid grid-cols-1 gap-3 sm:gap-4 md:grid-cols-2">
						{contactChannels.map((channel, i) => (
							<motion.a
								key={channel.title}
								href={channel.href}
								target={channel.external ? "_blank" : undefined}
								rel={channel.external ? "noopener noreferrer" : undefined}
								className="group relative rounded-2xl border border-border/60 bg-card p-5 transition-all duration-300 hover:border-border hover:shadow-black/3 hover:shadow-lg sm:p-6"
								initial={{ opacity: 0, y: 12 }}
								whileInView={{ opacity: 1, y: 0 }}
								viewport={{ once: true, margin: "-80px" }}
								transition={{ duration: 0.4, delay: i * 0.05 }}
							>
								<div
									className={cn(
										"mb-4 flex size-10 items-center justify-center rounded-xl",
										channel.iconBg,
									)}
								>
									<channel.icon className="size-5" />
								</div>
								<h3 className="mb-1.5 font-semibold text-base">
									{channel.title}
								</h3>
								<p className="text-muted-foreground text-sm leading-relaxed">
									{channel.description}
								</p>
								<span className="mt-4 inline-flex items-center gap-1.5 font-medium text-primary text-sm transition-colors group-hover:text-primary/80">
									{channel.action}
									<ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
								</span>
							</motion.a>
						))}
					</div>
				</div>
			</section>

			{/* ─── Company info banner ─────────────────────────────── */}
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

						<div className="relative grid gap-6 p-8 sm:p-10 md:grid-cols-3 lg:p-12">
							<div className="md:col-span-2">
								<div className="mb-4 inline-flex items-center gap-2 rounded-full border border-primary/15 bg-primary/8 px-3 py-1 font-medium text-primary text-xs">
									<Building2 className="size-3.5" />
									qrawall GmbH
								</div>
								<h2 className="font-display text-2xl tracking-tight sm:text-3xl">
									Built and maintained in Germany
								</h2>
								<p className="mt-4 max-w-lg text-muted-foreground text-sm leading-relaxed sm:text-base">
									Bittery is developed by{" "}
									<a
										href="https://qrawall.com/"
										target="_blank"
										rel="noopener noreferrer"
										className="font-medium text-foreground underline decoration-primary/30 underline-offset-2 transition-colors hover:decoration-primary/60"
									>
										qrawall GmbH
									</a>
									, based in Germany. We operate under strict EU data
									protection regulations including GDPR, ensuring your
									privacy is protected by law — not just by promise.
								</p>
							</div>

							<div className="flex flex-col justify-center gap-4">
								<div className="flex items-start gap-3">
									<div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
										<MapPin className="size-4" />
									</div>
									<div>
										<p className="font-medium text-foreground text-sm">
											Location
										</p>
										<p className="text-muted-foreground text-sm">
											Germany, EU
										</p>
									</div>
								</div>
								<div className="flex items-start gap-3">
									<div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
										<Clock className="size-4" />
									</div>
									<div>
										<p className="font-medium text-foreground text-sm">
											Response time
										</p>
										<p className="text-muted-foreground text-sm">
											1–2 business days
										</p>
									</div>
								</div>
								<div className="flex items-start gap-3">
									<div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
										<Globe className="size-4" />
									</div>
									<div>
										<p className="font-medium text-foreground text-sm">
											Website
										</p>
										<a
											href="https://qrawall.com/"
											target="_blank"
											rel="noopener noreferrer"
											className="text-primary text-sm transition-colors hover:text-primary/80"
										>
											qrawall.com
										</a>
									</div>
								</div>
							</div>
						</div>
					</motion.div>
				</div>
			</section>

			{/* ─── FAQ ─────────────────────────────────────────────── */}
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
							Frequently asked questions
						</h2>
						<p className="mx-auto mt-4 max-w-xl text-base text-muted-foreground sm:text-lg">
							Quick answers to common questions about reaching us.
						</p>
					</motion.div>

					<div className="mx-auto grid max-w-3xl gap-3 sm:gap-4">
						{faqs.map((faq, i) => (
							<motion.div
								key={faq.question}
								className="rounded-2xl border border-border/60 bg-card p-5 sm:p-6"
								initial={{ opacity: 0, y: 12 }}
								whileInView={{ opacity: 1, y: 0 }}
								viewport={{ once: true, margin: "-60px" }}
								transition={{ duration: 0.4, delay: i * 0.05 }}
							>
								<h3 className="font-semibold text-base text-foreground">
									{faq.question}
								</h3>
								<p className="mt-2 text-muted-foreground text-sm leading-relaxed">
									{faq.answer}
								</p>
							</motion.div>
						))}
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
								Join the people who decided their passwords deserve better.
								Free to start, no credit card needed.
							</p>
							<div className="mt-8 flex flex-wrap items-center justify-center gap-3">
								<Button
									size="lg"
									className="gap-2 rounded-full px-7"
									asChild
								>
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
