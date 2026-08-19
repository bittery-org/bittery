import { motion } from "motion/react";
import { billingMarketingEnabled, signupUrl } from "@/lib/urls";
import { ArrowLink, PrimaryCta } from "./cta-button";

export function FinalCta() {
	return (
		<section className="relative overflow-hidden px-4 py-28 text-center sm:py-32">
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
				<h2 className="font-semibold text-[32px] tracking-[-0.04em] sm:text-[48px]">
					Your passwords, truly yours.
				</h2>
				<p className="mx-auto mt-4 max-w-[44ch] text-[16px] text-muted-foreground">
					Set up in two minutes. Import from 1Password, Bitwarden or LastPass.
					Leave anytime — your data exports with you.
				</p>
				<div className="mt-8 flex items-center justify-center gap-5">
					<PrimaryCta
						href={billingMarketingEnabled() ? signupUrl() : "/#waitlist"}
						size="lg"
					>
						{billingMarketingEnabled()
							? "Get Bittery free"
							: "Join the waitlist"}
					</PrimaryCta>
					<ArrowLink href="/docs/getting-started/import-passwords">
						Import from your current manager
					</ArrowLink>
				</div>
			</motion.div>
		</section>
	);
}
