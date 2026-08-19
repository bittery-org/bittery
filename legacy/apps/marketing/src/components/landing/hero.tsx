import { motion } from "motion/react";
import { billingMarketingEnabled, signupUrl } from "@/lib/urls";
import { ArrowLink, PrimaryCta } from "./cta-button";
import { HeroAppVideo } from "./hero-video";

const TRUST_ITEMS = [
	"Zero-knowledge encryption",
	"Source-available",
	"Self-hostable",
];

const reveal = (delay: number) => ({
	initial: { opacity: 0, y: 14 },
	animate: { opacity: 1, y: 0 },
	transition: { duration: 0.7, delay, ease: [0.16, 1, 0.3, 1] as const },
});

export function Hero() {
	const primaryHref = billingMarketingEnabled() ? signupUrl() : "/#waitlist";
	return (
		<section className="relative overflow-hidden pt-36 text-center sm:pt-44">
			<div
				aria-hidden
				className="pointer-events-none absolute inset-x-[-20%] top-[-40%] h-[720px] bg-[radial-gradient(46%_58%_at_50%_42%,color-mix(in_oklab,var(--color-primary-deep)_9%,transparent),transparent_70%)] dark:bg-[radial-gradient(46%_58%_at_50%_42%,color-mix(in_oklab,var(--color-primary-deep)_15%,transparent),transparent_70%)]"
			/>
			<div className="relative mx-auto max-w-5xl px-4">
				<motion.h1
					{...reveal(0.13)}
					className="mx-auto max-w-[15ch] font-semibold text-[44px] text-foreground leading-[1.02] tracking-[-0.045em] sm:text-[64px] md:text-[74px]"
				>
					The password manager,{" "}
					<em className="bg-linear-to-r from-primary to-primary-deep bg-clip-text text-transparent not-italic">
						redesigned
					</em>
					.
				</motion.h1>

				<motion.p
					{...reveal(0.21)}
					className="mx-auto mt-5 max-w-[54ch] text-[17px] text-muted-foreground leading-relaxed"
				>
					Bittery is end-to-end encrypted, built on a Rust crypto core, and
					designed like it matters — because the software holding everything you
					log in to should be software you love to open.
				</motion.p>

				<motion.div
					{...reveal(0.29)}
					className="mt-8 flex items-center justify-center gap-5"
				>
					<PrimaryCta href={primaryHref} size="lg">
						{billingMarketingEnabled()
							? "Get Bittery free"
							: "Join the waitlist"}
					</PrimaryCta>
					<ArrowLink href="/#security">See how it's built</ArrowLink>
				</motion.div>

				<motion.div
					{...reveal(0.34)}
					className="mt-7 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-[12.5px] text-muted-foreground"
				>
					{TRUST_ITEMS.map((item) => (
						<span key={item} className="inline-flex items-center gap-2">
							<span
								aria-hidden
								className="size-[5px] rounded-full bg-success shadow-[0_0_6px_color-mix(in_oklab,var(--color-success)_60%,transparent)]"
							/>
							{item}
						</span>
					))}
				</motion.div>
			</div>

			<div className="relative mt-16 px-4 pb-24 sm:mt-20">
				<div
					aria-hidden
					className="pointer-events-none absolute bottom-0 left-1/2 h-72 w-[76%] -translate-x-1/2 bg-[radial-gradient(50%_50%_at_50%_50%,color-mix(in_oklab,var(--color-primary-deep)_8%,transparent),transparent_70%)] dark:bg-[radial-gradient(50%_50%_at_50%_50%,color-mix(in_oklab,var(--color-primary-deep)_14%,transparent),transparent_70%)]"
				/>
				<motion.div
					initial={{ opacity: 0, y: 28 }}
					animate={{ opacity: 1, y: 0 }}
					transition={{ duration: 0.9, delay: 0.42, ease: [0.16, 1, 0.3, 1] }}
					className="relative"
				>
					<HeroAppVideo />
				</motion.div>
			</div>
		</section>
	);
}
