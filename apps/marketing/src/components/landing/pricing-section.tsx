import { ArrowRight, Check, Lock } from "lucide-react";
import { motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PricingComparison } from "./pricing-comparison";

const plans = [
	{
		name: "Free",
		description: "Basic vault for getting started.",
		price: "$0",
		priceNote: "forever",
		cta: "Get started",
		ctaVariant: "outline" as const,
		ctaIcon: Lock,
		highlighted: false,
		features: [
			"1 vault, 50 items",
			"Logins only",
			"Zero-knowledge encryption",
			"Two-factor authentication",
			"All apps & extensions",
			"2 synced devices",
		],
	},
	{
		name: "Personal",
		description: "Daily password security with premium features.",
		price: "$3",
		priceNote: "/ month",
		cta: "Get started",
		ctaVariant: "default" as const,
		ctaIcon: ArrowRight,
		highlighted: true,
		features: [
			"Unlimited vaults & items",
			"All item types",
			"250 MB secure storage",
			"Passkeys & breach monitoring",
			"5 active sharing links",
			"Unlimited devices",
			"Priority support",
		],
	},
	{
		name: "Family",
		description: "Shared protection for your household.",
		price: "$7",
		priceNote: "/ month",
		cta: "Get started",
		ctaVariant: "outline" as const,
		ctaIcon: ArrowRight,
		highlighted: false,
		features: [
			"Everything in Personal",
			"Unlimited vaults, 5 shared vaults",
			"Up to 6 family members",
			"1 GB secure storage",
			"Unlimited sharing links",
			"Role-based access",
		],
	},
	{
		name: "Team",
		description: "For teams and businesses with shared workspaces.",
		price: "$9",
		priceNote: "user / month",
		cta: "Get started",
		ctaVariant: "outline" as const,
		ctaIcon: ArrowRight,
		highlighted: false,
		features: [
			"Everything in Family",
			"Unlimited vaults & members",
			"2 GB secure storage",
			"Admin console",
			"Activity logs",
			"Custom policies",
		],
	},
];

export function PricingSection() {
	return (
		<section id="pricing" className="px-4 py-20 sm:py-28">
			<div className="mx-auto max-w-6xl">
				<motion.div
					className="mb-12 text-center sm:mb-16"
					initial={{ opacity: 0 }}
					whileInView={{ opacity: 1 }}
					viewport={{ once: true, margin: "-100px" }}
					transition={{ duration: 0.5 }}
				>
					<h2 className="font-display text-3xl tracking-tight sm:text-4xl md:text-5xl">
						Simple, honest pricing
					</h2>
					<p className="mx-auto mt-4 max-w-xl text-base text-muted-foreground sm:text-lg">
						Start for free, upgrade as you grow. All plans include
						zero-knowledge encryption and cross-platform access.
					</p>
				</motion.div>

				<div className="mx-auto grid max-w-5xl grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-4">
					{plans.map((plan, i) => (
						<motion.div
							key={plan.name}
							className={cn(
								"relative rounded-2xl border p-6 transition-all duration-300",
								plan.highlighted
								? "border-primary/30 bg-linear-to-b from-primary/4 to-card shadow-lg shadow-primary/4"
									: "border-border/60 bg-card hover:border-border",
							)}
							initial={{ opacity: 0, y: 12 }}
							whileInView={{ opacity: 1, y: 0 }}
							viewport={{ once: true, margin: "-80px" }}
							transition={{
								duration: 0.4,
								delay: i * 0.06,
							}}
						>
							{plan.highlighted && (
								<div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-primary px-3 py-0.5 font-semibold text-[11px] text-primary-foreground">
									Most popular
								</div>
							)}

							<div className="mb-5">
								<h3 className="font-semibold text-lg">{plan.name}</h3>
								<p className="mt-1 text-muted-foreground text-sm">
									{plan.description}
								</p>
							</div>

							<div className="mb-5 flex items-baseline gap-1.5">
								<span className="font-bold text-3xl tracking-tight">
									{plan.price}
								</span>
								<span className="text-muted-foreground text-sm">
									{plan.priceNote}
								</span>
							</div>

							<Button
								variant={plan.ctaVariant}
								className="mb-5 w-full gap-2 rounded-full"
							>
								{plan.ctaVariant === "outline" && (
									<plan.ctaIcon className="size-4" />
								)}
								{plan.cta}
								{plan.ctaVariant === "default" && (
									<plan.ctaIcon className="size-4" />
								)}
							</Button>

							<ul className="space-y-2.5">
								{plan.features.map((feature) => (
									<li
										key={feature}
										className="flex items-start gap-2.5 text-sm"
									>
										<Check className="mt-0.5 size-4 shrink-0 text-primary" />
										<span className="text-muted-foreground">{feature}</span>
									</li>
								))}
							</ul>
						</motion.div>
					))}
				</div>

				<PricingComparison />
			</div>
		</section>
	);
}
