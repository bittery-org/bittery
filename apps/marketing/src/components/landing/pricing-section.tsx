import {
	type CloudPlanId,
	planFeatureBullets,
	planInfo,
} from "@bittery/shared/pricing";
import { ArrowRight, Check, Lock } from "lucide-react";
import { motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { signupUrl } from "@/lib/urls";
import { cn } from "@/lib/utils";
import { PrimaryCta } from "./cta-button";
import { PricingComparison } from "./pricing-comparison";

const planExtras: Record<
	CloudPlanId,
	{
		priceNote: string;
		cta: string;
		ctaVariant: "outline" | "default";
		ctaIcon: React.ComponentType<{ className?: string }>;
		highlighted: boolean;
	}
> = {
	free: {
		priceNote: "forever",
		cta: "Get started",
		ctaVariant: "outline",
		ctaIcon: Lock,
		highlighted: false,
	},
	personal: {
		priceNote: "/ month",
		cta: "Get started",
		ctaVariant: "default",
		ctaIcon: ArrowRight,
		highlighted: true,
	},
	family: {
		priceNote: "/ month",
		cta: "Get started",
		ctaVariant: "outline",
		ctaIcon: ArrowRight,
		highlighted: false,
	},
	team: {
		priceNote: "user / month",
		cta: "Get started",
		ctaVariant: "outline",
		ctaIcon: ArrowRight,
		highlighted: false,
	},
};

const plans = planInfo.map((plan) => ({
	...plan,
	price: plan.priceLabel,
	...planExtras[plan.id],
	features: planFeatureBullets[plan.id],
}));

export function PricingSection() {
	return (
		<section id="pricing" className="px-4 py-20 sm:py-28">
			<div className="mx-auto max-w-5xl">
				<motion.div
					className="mb-12 max-w-xl"
					initial={{ opacity: 0 }}
					whileInView={{ opacity: 1 }}
					viewport={{ once: true, margin: "-100px" }}
					transition={{ duration: 0.5 }}
				>
					<p className="mb-3 font-semibold text-[12px] text-primary uppercase tracking-[0.08em]">
						Pricing
					</p>
					<h2 className="font-semibold text-[30px] leading-[1.1] tracking-[-0.035em] sm:text-[40px]">
						Start free. Stay cheap.
					</h2>
					<p className="mt-3.5 text-[16px] text-muted-foreground">
						Every plan gets the same encryption, the same apps, and the same
						care. Paid plans just carry more.
					</p>
				</motion.div>

				<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-4">
					{plans.map((plan, i) => (
						<motion.div
							key={plan.name}
							className={cn(
								"relative overflow-hidden rounded-xl border bg-card p-6 transition-colors duration-150",
								plan.highlighted
									? "border-primary/40 shadow-[0_0_0_1px_color-mix(in_oklab,var(--color-primary)_20%,transparent)] dark:shadow-[0_0_0_1px_color-mix(in_oklab,var(--color-primary)_20%,transparent),0_0_40px_color-mix(in_oklab,var(--color-primary-deep)_14%,transparent)]"
									: "hover:border-border-strong",
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
								<span
									aria-hidden
									className="absolute inset-x-[10%] top-0 h-px bg-linear-to-r from-transparent via-primary/55 to-transparent"
								/>
							)}

							<div className="mb-5">
								<h3 className="font-semibold text-lg">{plan.name}</h3>
								<p className="mt-1 min-h-10 text-muted-foreground text-sm">
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

							{plan.highlighted ? (
								<PrimaryCta href={signupUrl(plan.id)} className="mb-5 w-full">
									{plan.cta}
									<plan.ctaIcon className="size-4" />
								</PrimaryCta>
							) : (
								<Button
									variant="outline"
									className="mb-5 w-full gap-2 rounded-md"
									asChild
								>
									<a href={signupUrl(plan.id)}>
										{plan.cta}
										<plan.ctaIcon className="size-4" />
									</a>
								</Button>
							)}

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

				<p className="mt-6 text-center text-[13px] text-muted-foreground">
					Prefer your own hardware?{" "}
					<a
						href="/docs/self-hosting/overview"
						className="text-foreground underline decoration-border-strong underline-offset-3 transition-colors hover:decoration-foreground"
					>
						Self-host with Docker
					</a>{" "}
					— free forever, no subscription required.
				</p>

				<PricingComparison />
			</div>
		</section>
	);
}
